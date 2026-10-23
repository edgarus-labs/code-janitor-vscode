using System.Text.Json.Nodes;
using CodeJanitor.Engine.Contracts;
using CodeJanitor.Server;
using Microsoft.CodeAnalysis.Text;
using Nerdbank.Streams;
using Xunit;

namespace CodeJanitor.Engine.Tests.Server;

public sealed class RpcServerTests : IDisposable
{
    private readonly TempTree _tree = new();
    private readonly FakeEngine _engine = new();
    private readonly List<string> _log = [];

    public void Dispose() => _tree.Dispose();

    [Fact]
    public async Task Initialize_returns_the_server_and_roslyn_versions()
    {
        await using var session = Start();

        var response = await session.Client.CallAsync(1, "initialize", new JsonObject { ["workspaceFolders"] = new JsonArray(_tree.Root) });

        Assert.Equal("2.0", response["jsonrpc"]?.GetValue<string>());
        Assert.False(string.IsNullOrEmpty(response["result"]?["serverVersion"]?.GetValue<string>()));
        Assert.StartsWith("5.9.0", response["result"]?["roslynVersion"]?.GetValue<string>());
    }

    [Fact]
    public async Task Cleanup_passes_the_request_to_the_engine_and_returns_the_result_in_camel_case()
    {
        var file = _tree.Write("Loose/A.cs", "class A { }\n");
        _engine.Cleanup = (document, _, _) =>
        {
            var changed = document.WithText(SourceText.From("internal class A { }\n"));
            var added = changed.Project.AddDocument("B.cs", SourceText.From("class B { }\n"), filePath: _tree.PathOf("Loose/B.cs"));

            return Task.FromResult(new CleanupOutcome(
                added.Project.Solution,
                [new RuleOutcome("IDE0040", "Add accessibility modifiers", 1, true)],
                [new UnresolvedDiagnostic("IDE1006", "bad name", "error", 3, 5, "public")],
                ["engine note"]));
        };
        await using var session = Start();

        var response = await session.Client.CallAsync(1, "cleanup", new JsonObject
        {
            ["filePath"] = file,
            ["text"] = "class A { }\n",
            ["settings"] = new JsonObject { ["removeRegions"] = true },
            ["excludedRules"] = new JsonArray("IDE0005"),
            ["changedLines"] = new JsonArray(new JsonObject { ["start"] = 1, ["end"] = 2 }),
        });

        var result = response["result"]!;
        Assert.Equal("internal class A { }\n", result["text"]?.GetValue<string>());
        Assert.Empty(result["otherFiles"]!.AsArray());
        Assert.Equal(_tree.PathOf("Loose/B.cs"), result["newFiles"]?[0]?["path"]?.GetValue<string>());
        Assert.Equal("class B { }\n", result["newFiles"]?[0]?["text"]?.GetValue<string>());
        Assert.Equal("""{"id":"IDE0040","name":"Add accessibility modifiers","changes":1,"included":true}""", result["rules"]?[0]?.ToJsonString());
        Assert.Equal("""{"id":"IDE1006","message":"bad name","severity":"error","line":3,"column":5,"reason":"public"}""", result["unresolved"]?[0]?.ToJsonString());
        Assert.Contains("engine note", result["issues"]!.AsArray().Select(issue => issue!.GetValue<string>()));
        var call = Assert.Single(_engine.Calls);
        Assert.Equal(file, call.Document.FilePath);
        Assert.True(call.Settings["removeRegions"]!.GetValue<bool>());
        Assert.Equal(["IDE0005"], call.Request!.ExcludedRules);
        Assert.Equal([new LineRange(1, 2)], call.Request.ChangedLines);
    }

    [Theory]
    [InlineData(null, null, false, false)]
    [InlineData(true, null, true, false)]
    [InlineData(null, true, false, true)]
    public async Task Cleanup_passes_the_on_save_and_partial_flags_to_the_engine(bool? onSave, bool? partial, bool expectedOnSave, bool expectedPartial)
    {
        var file = _tree.Write("Loose/A.cs", "class A { }\n");
        await using var session = Start();
        var parameters = new JsonObject { ["filePath"] = file, ["text"] = "class A { }\n", ["settings"] = new JsonObject() };
        if (onSave is { } save)
        {
            parameters["onSave"] = save;
        }

        if (partial is { } part)
        {
            parameters["partial"] = part;
        }

        await session.Client.CallAsync(1, "cleanup", parameters);

        var request = Assert.Single(_engine.Calls).Request!;
        Assert.Equal((expectedOnSave, expectedPartial), (request.OnSave, request.Partial));
    }

    [Fact]
    public async Task Analyze_query_fix_rule_command_and_override_notes_reach_the_engine()
    {
        var file = _tree.Write("Loose/A.cs", "class A { }\n");
        _engine.Analyze = _ => Task.FromResult<IReadOnlyList<EngineDiagnostic>>([new EngineDiagnostic("IDE0040", "Add modifiers", "warning", 0, 6, 0, 7, true, null)]);
        await using var session = Start();
        var settings = new JsonObject();

        var analyzed = await session.Client.CallAsync(1, "analyze", new JsonObject { ["filePath"] = file, ["text"] = "class A { }\n", ["settings"] = settings.DeepClone() });
        var queried = await session.Client.CallAsync(2, "query", new JsonObject { ["filePath"] = file, ["text"] = "class A { }\n", ["settings"] = settings.DeepClone(), ["query"] = "memberAtPosition", ["arguments"] = new JsonObject { ["line"] = 0, ["character"] = 3 } });
        var fixedRule = await session.Client.CallAsync(3, "fixRule", new JsonObject { ["filePath"] = file, ["text"] = "class A { }\n", ["settings"] = settings.DeepClone(), ["ruleId"] = "IDE0040", ["line"] = 0 });
        var commanded = await session.Client.CallAsync(4, "command", new JsonObject { ["filePath"] = file, ["text"] = "class A { }\n", ["settings"] = settings.DeepClone(), ["command"] = "fixNamespace", ["arguments"] = new JsonObject { ["namespace"] = "N" } });
        var notes = await session.Client.CallAsync(5, "overrideNotes", new JsonObject { ["directory"] = _tree.Root, ["settings"] = settings.DeepClone() });

        Assert.Equal("""{"id":"IDE0040","message":"Add modifiers","severity":"warning","startLine":0,"startColumn":6,"endLine":0,"endColumn":7,"fixable":true,"helpLink":null}""", analyzed["result"]?["diagnostics"]?[0]?.ToJsonString());
        Assert.Equal("""{"name":"A.cs","line":0}""", queried["result"]?.ToJsonString());
        Assert.Equal("class A { }\n", fixedRule["result"]?["text"]?.GetValue<string>());
        Assert.Equal("// fixNamespace\nclass A { }\n", commanded["result"]?["text"]?.GetValue<string>());
        Assert.Empty(commanded["result"]!["rules"]!.AsArray());
        Assert.Equal($"set by {_tree.Root}/.codejanitor", notes["result"]?["notes"]?["removeRegions"]?.GetValue<string>());
        Assert.Equal(["analyze", "query memberAtPosition", "fixRule IDE0040 0", """command fixNamespace {"namespace":"N"}"""], _engine.Calls.Select(call => call.Kind));
    }

    [Fact]
    public async Task A_file_changed_notification_makes_the_next_request_read_the_new_disk_text()
    {
        _tree.Write("App/App.csproj", ServerTestPaths.Project);
        var file = _tree.Write("App/A.cs", "class A { }\n");
        var texts = new List<string>();
        _engine.Cleanup = async (document, _, cancellationToken) =>
        {
            texts.Add((await document.GetTextAsync(cancellationToken)).ToString());

            return new CleanupOutcome(document.Project.Solution, [], [], []);
        };
        await using var session = Start(msbuildAvailable: true);
        await session.Client.CallAsync(1, "initialize", new JsonObject { ["workspaceFolders"] = new JsonArray(_tree.Root) });

        await session.Client.CallAsync(2, "cleanup", new JsonObject { ["filePath"] = file, ["settings"] = new JsonObject() });
        _tree.Write("App/A.cs", "class Changed { }\n");
        await session.Client.NotifyAsync("fileChanged", new JsonObject { ["path"] = file });
        var response = await session.Client.CallAsync(3, "cleanup", new JsonObject { ["filePath"] = file, ["settings"] = new JsonObject() });

        Assert.Equal(["class A { }\n", "class Changed { }\n"], texts);
        Assert.Equal("class Changed { }\n", response["result"]?["text"]?.GetValue<string>());
    }

    [Fact]
    public async Task An_engine_failure_is_a_json_rpc_error_and_the_server_keeps_serving()
    {
        var file = _tree.Write("Loose/A.cs", "class A { }\n");
        _engine.Cleanup = (_, _, _) => throw new InvalidOperationException("engine broke");
        await using var session = Start();

        var failed = await session.Client.CallAsync(1, "cleanup", new JsonObject { ["filePath"] = file, ["text"] = "class A { }\n", ["settings"] = new JsonObject() });
        var initialized = await session.Client.CallAsync(2, "initialize", new JsonObject { ["workspaceFolders"] = new JsonArray() });

        Assert.Null(failed["result"]);
        Assert.Contains("engine broke", failed["error"]?["message"]?.GetValue<string>());
        Assert.NotNull(initialized["result"]);
        Assert.Contains(_log, line => line.Contains("engine broke", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_cancel_request_cancels_the_engine_and_answers_with_request_cancelled()
    {
        var file = _tree.Write("Loose/A.cs", "class A { }\n");
        var started = new TaskCompletionSource();
        var cancelled = new TaskCompletionSource();
        _engine.Cleanup = async (_, _, cancellationToken) =>
        {
            started.SetResult();
            using var registration = cancellationToken.Register(() => cancelled.TrySetResult());
            await Task.Delay(Timeout.Infinite, cancellationToken);
            throw new InvalidOperationException("not cancelled");
        };
        await using var session = Start();

        await session.Client.RequestAsync(7, "cleanup", new JsonObject { ["filePath"] = file, ["text"] = "class A { }\n", ["settings"] = new JsonObject() });
        await started.Task.WaitAsync(TimeSpan.FromSeconds(30));
        await session.Client.NotifyAsync("$/cancelRequest", new JsonObject { ["id"] = 7 });
        var response = await session.Client.ResponseAsync(7);

        await cancelled.Task.WaitAsync(TimeSpan.FromSeconds(30));
        Assert.Equal(-32800, response["error"]?["code"]?.GetValue<int>());
    }

    [Fact]
    public async Task Shutdown_answers_null_and_ends_the_server()
    {
        await using var session = Start();

        var response = await session.Client.CallAsync(1, "shutdown", new JsonObject());

        Assert.True(response.ContainsKey("result"));
        Assert.Null(response["result"]);
        await session.Server.WaitAsync(TimeSpan.FromSeconds(30));
    }

    [Fact]
    public async Task A_connection_that_breaks_the_framing_ends_the_server_with_the_error()
    {
        var (clientStream, serverStream) = FullDuplexStream.CreatePair();
        using var host = new WorkspaceHost(Log, msbuildAvailable: false);
        var server = RpcServer.RunAsync(serverStream, serverStream, host, _engine, Log);

        await clientStream.WriteAsync("Content-Length: not a number\r\n\r\n{}"u8.ToArray());
        await clientStream.FlushAsync();

        await Assert.ThrowsAnyAsync<Exception>(() => server.WaitAsync(TimeSpan.FromSeconds(30)));
    }

    private Session Start(bool msbuildAvailable = false)
    {
        var (clientStream, serverStream) = FullDuplexStream.CreatePair();
        var host = new WorkspaceHost(Log, msbuildAvailable);
        var server = RpcServer.RunAsync(serverStream, serverStream, host, _engine, Log);

        return new Session(new RawRpcClient(clientStream), server, clientStream, host);
    }

    private void Log(string line)
    {
        lock (_log)
        {
            _log.Add(line);
        }
    }

    private sealed record Session(RawRpcClient Client, Task Server, Stream Stream, WorkspaceHost Host) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync()
        {
            await Stream.DisposeAsync();
            await Server.WaitAsync(TimeSpan.FromSeconds(30));
            Host.Dispose();
        }
    }
}
