using System.Diagnostics;
using System.Text.Json.Nodes;
using CodeJanitor.Engine.Tests.Testbed;
using Xunit;
using Xunit.Abstractions;

namespace CodeJanitor.Engine.Tests.Server;

public sealed class ServerProcessTests(ITestOutputHelper output)
{
    [Fact]
    public async Task The_server_process_cleans_a_testbed_scenario_over_stdio()
    {
        var testbed = ServerTestPaths.Testbed();
        var file = Path.Combine(testbed, "src", "Scenarios", "CodeStyle", "CsharpPreferredModifierOrder", "CsharpPreferredModifierOrder.cs");
        var scenario = TestbedScenarios.All.Single(candidate => string.Equals(candidate.FullPath, file, StringComparison.Ordinal));
        var text = TestbedScenarios.ReadText(file);
        var settings = TestbedScenarios.SettingsOf(scenario);
        using var process = Start("CodeJanitor.Server.dll");
        using var guard = new KillOnDispose(process);
        var stderr = process.StandardError.ReadToEndAsync();
        var client = new RawRpcClient(new ProcessStream(process));

        var initialized = await client.CallAsync(1, "initialize", new JsonObject { ["workspaceFolders"] = new JsonArray(testbed) });
        var cold = Stopwatch.StartNew();
        var cleaned = await client.CallAsync(2, "cleanup", new JsonObject { ["filePath"] = file, ["text"] = text, ["settings"] = settings.DeepClone() });
        cold.Stop();
        var warm = Stopwatch.StartNew();
        var again = await client.CallAsync(3, "cleanup", new JsonObject { ["filePath"] = file, ["text"] = text, ["settings"] = settings.DeepClone() });
        warm.Stop();
        var shutdown = await client.CallAsync(4, "shutdown", new JsonObject());
        Assert.True(process.WaitForExit(30_000));
        output.WriteLine($"cold cleanup {cold.ElapsedMilliseconds} ms, warm cleanup {warm.ElapsedMilliseconds} ms");
        output.WriteLine(await stderr);

        Assert.NotNull(initialized["result"]);
        Assert.Null(cleaned["error"]);
        Assert.Null(again["error"]);
        var cleanedText = cleaned["result"]!["text"]!.GetValue<string>();
        Assert.NotEqual(text, cleanedText);
        Assert.Empty(TestbedScenarios.Failures(scenario, cleanedText, IssuesOf(cleaned["result"]!)));
        Assert.Equal(cleanedText, again["result"]!["text"]!.GetValue<string>());
        Assert.True(shutdown.ContainsKey("result"));
        Assert.Equal(0, process.ExitCode);
    }

    [Fact]
    public async Task The_server_process_applies_the_code_fixes_of_a_project_whose_sdk_analyzers_reference_newer_composition_assemblies()
    {
        var testbed = ServerTestPaths.Testbed();
        var file = Path.Combine(testbed, "src", "Scenarios", "CodeStyle", "CsharpPreferBraces", "CsharpPreferBraces.cs");
        using var process = Start("CodeJanitor.Server.dll");
        using var guard = new KillOnDispose(process);
        var stderr = process.StandardError.ReadToEndAsync();
        var client = new RawRpcClient(new ProcessStream(process));
        var settings = new JsonObject { ["codeStyleRules"] = new JsonObject { ["csharp_prefer_braces"] = "true" } };

        await client.CallAsync(1, "initialize", new JsonObject { ["workspaceFolders"] = new JsonArray(testbed) });
        var cleaned = await client.CallAsync(2, "cleanup", new JsonObject { ["filePath"] = file, ["text"] = await File.ReadAllTextAsync(file), ["settings"] = settings });
        await client.CallAsync(3, "shutdown", new JsonObject());
        Assert.True(process.WaitForExit(30_000));
        output.WriteLine(await stderr);

        Assert.Equal("[]", cleaned["result"]?["issues"]?.ToJsonString());
        Assert.Contains("if (open)\n        {\n            return 1;\n        }", cleaned["result"]?["text"]?.GetValue<string>().Replace("\r\n", "\n"));
    }

    [Fact]
    public async Task The_server_process_exits_with_1_and_the_error_when_the_connection_breaks_the_framing()
    {
        using var process = Start("CodeJanitor.Server.dll");
        using var guard = new KillOnDispose(process);
        var stderr = process.StandardError.ReadToEndAsync();

        await process.StandardInput.BaseStream.WriteAsync("Content-Length: not a number\r\n\r\n{}"u8.ToArray());
        await process.StandardInput.BaseStream.FlushAsync();

        Assert.True(process.WaitForExit(60_000));
        Assert.Equal(1, process.ExitCode);
        Assert.Contains("The connection failed", await stderr, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_check_command_exits_with_2_on_a_usage_error()
    {
        using var process = Start("CodeJanitor.Server.dll", "check", "--bogus");
        using var guard = new KillOnDispose(process);
        var stderr = await process.StandardError.ReadToEndAsync();
        var stdout = await process.StandardOutput.ReadToEndAsync();
        Assert.True(process.WaitForExit(30_000));

        Assert.Equal(2, process.ExitCode);
        Assert.Equal(string.Empty, stdout);
        Assert.StartsWith("Usage: ", stderr, StringComparison.Ordinal);
    }

    private static List<string> IssuesOf(JsonNode result) =>
    [
        .. result["issues"]!.AsArray().Select(issue => issue!.GetValue<string>()),
        .. result["unresolved"]!.AsArray().Select(unresolved => $"unresolved: {unresolved!["id"]} line {unresolved["line"]}: {unresolved["message"]} ({unresolved["reason"]})"),
    ];

    /// <summary>Kills the process when the test ends before it did, so a failed assertion leaves no server running.</summary>
    private sealed class KillOnDispose(Process process) : IDisposable
    {
        public void Dispose()
        {
            try
            {
                if (!process.HasExited)
                {
                    process.Kill(entireProcessTree: true);
                }
            }
            catch (InvalidOperationException)
            {
            }
        }
    }

    private static Process Start(params string[] arguments)
    {
        var start = new ProcessStartInfo("dotnet")
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = AppContext.BaseDirectory,
        };
        start.ArgumentList.Add(Path.Combine(AppContext.BaseDirectory, arguments[0]));
        foreach (var argument in arguments.Skip(1))
        {
            start.ArgumentList.Add(argument);
        }

        return Process.Start(start)!;
    }

    /// <summary>The standard input and output of a process as one duplex stream.</summary>
    private sealed class ProcessStream(Process process) : Stream
    {
        private readonly Stream _input = process.StandardInput.BaseStream;
        private readonly Stream _output = process.StandardOutput.BaseStream;

        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => true;

        public override long Length => throw new NotSupportedException();

        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }

        public override void Flush() => _input.Flush();

        public override Task FlushAsync(CancellationToken cancellationToken) => _input.FlushAsync(cancellationToken);

        public override int Read(byte[] buffer, int offset, int count) => _output.Read(buffer, offset, count);

        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) => _output.ReadAsync(buffer, cancellationToken);

        public override void Write(byte[] buffer, int offset, int count) => _input.Write(buffer, offset, count);

        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default) => _input.WriteAsync(buffer, cancellationToken);

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();
    }
}
