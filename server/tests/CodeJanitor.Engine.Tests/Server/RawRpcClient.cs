using System.Text;
using System.Text.Json.Nodes;

namespace CodeJanitor.Engine.Tests.Server;

/// <summary>
/// A JSON-RPC client speaking the wire format of vscode-jsonrpc (<c>Content-Length</c> headers, JSON bodies), so the tests
/// see exactly what the extension sends and receives.
/// </summary>
internal sealed class RawRpcClient(Stream stream)
{
    private readonly List<JsonObject> _unread = [];

    public async Task SendAsync(JsonObject message)
    {
        var body = Encoding.UTF8.GetBytes(message.ToJsonString());
        var header = Encoding.ASCII.GetBytes($"Content-Length: {body.Length}\r\n\r\n");
        await stream.WriteAsync(header);
        await stream.WriteAsync(body);
        await stream.FlushAsync();
    }

    public Task RequestAsync(int id, string method, JsonNode? parameters) =>
        SendAsync(new JsonObject { ["jsonrpc"] = "2.0", ["id"] = id, ["method"] = method, ["params"] = parameters });

    public Task NotifyAsync(string method, JsonNode? parameters) =>
        SendAsync(new JsonObject { ["jsonrpc"] = "2.0", ["method"] = method, ["params"] = parameters });

    /// <summary>Sends a request and returns its response (the whole message, with <c>result</c> or <c>error</c>).</summary>
    public async Task<JsonObject> CallAsync(int id, string method, JsonNode? parameters)
    {
        await RequestAsync(id, method, parameters);

        return await ResponseAsync(id);
    }

    public async Task<JsonObject> ResponseAsync(int id)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(120));
        while (true)
        {
            var waiting = _unread.FirstOrDefault(message => message["id"]?.GetValue<int>() == id);
            if (waiting is not null)
            {
                _unread.Remove(waiting);

                return waiting;
            }

            _unread.Add(await ReadAsync(timeout.Token));
        }
    }

    private async Task<JsonObject> ReadAsync(CancellationToken cancellationToken)
    {
        var length = -1;
        while (true)
        {
            var line = await ReadLineAsync(cancellationToken);
            if (line.Length == 0)
            {
                break;
            }

            if (line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase))
            {
                length = int.Parse(line["Content-Length:".Length..].Trim());
            }
        }

        var body = new byte[length];
        await stream.ReadExactlyAsync(body, cancellationToken);

        return JsonNode.Parse(body)!.AsObject();
    }

    private async Task<string> ReadLineAsync(CancellationToken cancellationToken)
    {
        var bytes = new List<byte>();
        var one = new byte[1];
        while (true)
        {
            await stream.ReadExactlyAsync(one, cancellationToken);
            if (one[0] == '\n')
            {
                return Encoding.ASCII.GetString([.. bytes]).TrimEnd('\r');
            }

            bytes.Add(one[0]);
        }
    }
}
