using System.Text.Json.Nodes;
using CodeJanitor.Server;
using Nerdbank.Streams;
using Xunit;

namespace CodeJanitor.Engine.Tests.Server;

public sealed class FormatCommentTextRpcTests
{
    [Fact]
    public async Task FormatCommentText_formats_the_comments_with_the_given_prefix()
    {
        await using var session = Start();

        var response = await session.Client.CallAsync(1, "formatCommentText", new JsonObject
        {
            ["text"] = "Module M\n    ' one two three four five six\nEnd Module\n",
            ["commentPrefix"] = "'",
            ["settings"] = new JsonObject { ["commentFormat"] = new JsonObject { ["wrapColumn"] = 20 } },
        });

        Assert.Equal("Module M\n    ' one two three\n    ' four five six\nEnd Module\n", response["result"]?["text"]?.GetValue<string>());
    }

    [Fact]
    public async Task FormatCommentText_keeps_to_the_given_lines()
    {
        await using var session = Start();

        var response = await session.Client.CallAsync(1, "formatCommentText", new JsonObject
        {
            ["text"] = "# one two three four five six\nx = 1\n# one two three four five six\n",
            ["commentPrefix"] = "#",
            ["startLine"] = 2,
            ["endLine"] = 2,
            ["settings"] = new JsonObject { ["commentFormat"] = new JsonObject { ["wrapColumn"] = 20 } },
        });

        Assert.Equal("# one two three four five six\nx = 1\n# one two three four\n# five six\n", response["result"]?["text"]?.GetValue<string>());
    }

    [Fact]
    public async Task FormatCommentText_rejects_a_blank_prefix()
    {
        await using var session = Start();

        var response = await session.Client.CallAsync(1, "formatCommentText", new JsonObject { ["text"] = "' a\n", ["commentPrefix"] = " ", ["settings"] = new JsonObject() });

        Assert.NotNull(response["error"]);
    }

    private static Session Start()
    {
        var (clientStream, serverStream) = FullDuplexStream.CreatePair();
        var host = new WorkspaceHost(_ => { }, msbuildAvailable: false);
        var server = RpcServer.RunAsync(serverStream, serverStream, host, new FakeEngine(), _ => { });

        return new Session(new RawRpcClient(clientStream), server, clientStream, host);
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
