using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using CodeJanitor.Engine.Comments;
using CodeJanitor.Engine.Contracts;
using Microsoft.CodeAnalysis;
using Microsoft.VisualStudio.Threading;
using StreamJsonRpc;

namespace CodeJanitor.Server;

/// <summary>
/// The JSON-RPC server of the extension: <c>Content-Length</c> framed messages with camelCase JSON, the methods of the
/// protocol on <see cref="WorkspaceHost"/> and an <see cref="ICleanupEngine"/>. Requests start in the order they arrive (a
/// <c>fileChanged</c> is applied before the request after it) and then run concurrently.
/// </summary>
internal static class RpcServer
{
    /// <summary>Serves until <c>shutdown</c> or until the client disconnects.</summary>
    public static async Task RunAsync(Stream sending, Stream receiving, WorkspaceHost host, ICleanupEngine engine, Action<string> log)
    {
        var formatter = new SystemTextJsonFormatter();
        formatter.JsonSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
        formatter.JsonSerializerOptions.PropertyNameCaseInsensitive = true;
        formatter.JsonSerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.Never;

        var shutdown = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var rpc = new JsonRpc(new HeaderDelimitedMessageHandler(sending, receiving, formatter))
        {
            SynchronizationContext = new NonConcurrentSynchronizationContext(sticky: false),
        };
        rpc.AddLocalRpcTarget(new Target(host, engine, log, shutdown), new JsonRpcTargetOptions { DisposeOnDisconnect = false });
        rpc.StartListening();

        var finished = await Task.WhenAny(rpc.Completion, shutdown.Task).ConfigureAwait(false);
        if (finished == rpc.Completion)
        {
            await rpc.Completion.ConfigureAwait(false);
        }
        else
        {
            await rpc.DispatchCompletion.ConfigureAwait(false);
        }
    }

    /// <summary>The methods of the protocol.</summary>
    private sealed class Target(WorkspaceHost host, ICleanupEngine engine, Action<string> log, TaskCompletionSource shutdown)
    {
        [JsonRpcMethod("initialize", UseSingleObjectParameterDeserialization = true)]
        public InitializeResult Initialize(InitializeParams parameters)
        {
            host.Initialize(parameters.WorkspaceFolders ?? []);
            log($"Initialized with {string.Join(", ", parameters.WorkspaceFolders ?? [])}.");

            return new InitializeResult(VersionOf(typeof(RpcServer).Assembly), VersionOf(typeof(SyntaxNode).Assembly));
        }

        [JsonRpcMethod("cleanup", UseSingleObjectParameterDeserialization = true)]
        public Task<CleanupResult> CleanupAsync(CleanupParams parameters, CancellationToken cancellationToken) =>
            Guard("cleanup", parameters.FilePath, async () =>
            {
                var opened = await host.OpenAsync(parameters.FilePath, parameters.Text, parameters.UnsavedDocuments, cancellationToken).ConfigureAwait(false);
                var request = new CleanupRequest(parameters.Settings ?? [], parameters.ExcludedRules ?? [], parameters.ChangedLines, parameters.OnSave == true, parameters.Partial == true);
                var outcome = await engine.CleanupAsync(opened.Document, request, cancellationToken).ConfigureAwait(false);

                return await ResultMapper.MapAsync(opened.Document, outcome, opened.Issues, [.. opened.Warnings, .. opened.Failures], cancellationToken).ConfigureAwait(false);
            });

        [JsonRpcMethod("analyze", UseSingleObjectParameterDeserialization = true)]
        public Task<AnalyzeResult> AnalyzeAsync(AnalyzeParams parameters, CancellationToken cancellationToken) =>
            Guard("analyze", parameters.FilePath, async () =>
            {
                var opened = await OpenAsync(parameters.FilePath, parameters.Text, parameters.UnsavedDocuments, cancellationToken).ConfigureAwait(false);

                return new AnalyzeResult(await engine.AnalyzeAsync(opened, parameters.Settings ?? [], cancellationToken).ConfigureAwait(false));
            });

        [JsonRpcMethod("query", UseSingleObjectParameterDeserialization = true)]
        public Task<JsonNode?> QueryAsync(QueryParams parameters, CancellationToken cancellationToken) =>
            Guard("query " + parameters.Query, parameters.FilePath, async () =>
            {
                var opened = await OpenAsync(parameters.FilePath, parameters.Text, parameters.UnsavedDocuments, cancellationToken).ConfigureAwait(false);

                return await engine.QueryAsync(opened, parameters.Query, parameters.Settings ?? [], parameters.Arguments, cancellationToken).ConfigureAwait(false);
            });

        [JsonRpcMethod("fixRule", UseSingleObjectParameterDeserialization = true)]
        public Task<CleanupResult> FixRuleAsync(FixRuleParams parameters, CancellationToken cancellationToken) =>
            Guard("fixRule " + parameters.RuleId, parameters.FilePath, async () =>
            {
                var opened = await host.OpenAsync(parameters.FilePath, parameters.Text, parameters.UnsavedDocuments, cancellationToken).ConfigureAwait(false);
                var outcome = await engine.FixRuleAsync(opened.Document, parameters.Settings ?? [], parameters.RuleId, parameters.Line, cancellationToken).ConfigureAwait(false);

                return await ResultMapper.MapAsync(opened.Document, outcome, opened.Issues, [.. opened.Warnings, .. opened.Failures], cancellationToken).ConfigureAwait(false);
            });

        [JsonRpcMethod("command", UseSingleObjectParameterDeserialization = true)]
        public Task<CleanupResult> CommandAsync(CommandParams parameters, CancellationToken cancellationToken) =>
            Guard("command " + parameters.Command, parameters.FilePath, async () =>
            {
                var opened = await host.OpenAsync(parameters.FilePath, parameters.Text, parameters.UnsavedDocuments, cancellationToken).ConfigureAwait(false);
                var solution = await engine.ExecuteCommandAsync(opened.Document, parameters.Command, parameters.Settings ?? [], parameters.Arguments, cancellationToken).ConfigureAwait(false);

                return await ResultMapper.MapAsync(opened.Document, new CleanupOutcome(solution, [], [], []), opened.Issues, [.. opened.Warnings, .. opened.Failures], cancellationToken).ConfigureAwait(false);
            });

        [JsonRpcMethod("overrideNotes", UseSingleObjectParameterDeserialization = true)]
        public Task<OverrideNotesResult> OverrideNotesAsync(OverrideNotesParams parameters, CancellationToken cancellationToken) =>
            Guard("overrideNotes", parameters.Directory, async () =>
                new OverrideNotesResult(await engine.OverrideNotesAsync(Path.GetFullPath(parameters.Directory), parameters.Settings ?? [], cancellationToken).ConfigureAwait(false)));

        [JsonRpcMethod("formatCommentText", UseSingleObjectParameterDeserialization = true)]
        public Task<FormatCommentTextResult> FormatCommentTextAsync(FormatCommentTextParams parameters) =>
            Guard("formatCommentText", parameters.CommentPrefix, () =>
                Task.FromResult(new FormatCommentTextResult(CommentTextFormatter.Format(parameters.Text, parameters.CommentPrefix, parameters.Settings, parameters.StartLine, parameters.EndLine))));

        [JsonRpcMethod("shutdown")]
        public object? Shutdown()
        {
            log("Shutting down.");
            shutdown.TrySetResult();

            return null;
        }

        [JsonRpcMethod("fileChanged", UseSingleObjectParameterDeserialization = true)]
        public void FileChanged(FileChangedParams parameters)
        {
            try
            {
                host.FileChanged(parameters.Path);
            }
            catch (Exception exception) when (exception is not OutOfMemoryException)
            {
                log($"fileChanged {parameters.Path} failed: {exception}");
            }
        }

        private async Task<Document> OpenAsync(string filePath, string? text, IReadOnlyList<UnsavedDocument>? unsavedDocuments, CancellationToken cancellationToken)
        {
            var opened = await host.OpenAsync(filePath, text, unsavedDocuments, cancellationToken).ConfigureAwait(false);
            foreach (var issue in opened.Messages)
            {
                log(issue);
            }

            return opened.Document;
        }

        /// <summary>Runs a request, logging its failure (the client gets it as a JSON-RPC error) but not its cancellation.</summary>
        private async Task<T> Guard<T>(string method, string path, Func<Task<T>> run)
        {
            try
            {
                return await run().ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception exception)
            {
                log($"{method} {path} failed: {exception}");
                throw;
            }
        }

        private static string VersionOf(Assembly assembly)
        {
            var version = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
                ?? assembly.GetName().Version?.ToString()
                ?? "unknown";
            var metadata = version.IndexOf('+', StringComparison.Ordinal);

            return metadata < 0 ? version : version[..metadata];
        }
    }
}
