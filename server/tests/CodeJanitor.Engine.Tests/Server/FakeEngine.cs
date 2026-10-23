using System.Text.Json.Nodes;
using CodeJanitor.Engine.Contracts;
using Microsoft.CodeAnalysis;

namespace CodeJanitor.Engine.Tests.Server;

/// <summary>An <see cref="ICleanupEngine"/> whose answers the test sets; it records what it was asked.</summary>
internal sealed class FakeEngine : ICleanupEngine
{
    public Func<Document, CleanupRequest, CancellationToken, Task<CleanupOutcome>> Cleanup { get; set; } =
        (document, _, _) => Task.FromResult(new CleanupOutcome(document.Project.Solution, [], [], []));

    public Func<Document, string, int?, Task<CleanupOutcome>> FixRule { get; set; } =
        (document, _, _) => Task.FromResult(new CleanupOutcome(document.Project.Solution, [], [], []));

    public Func<Document, Task<IReadOnlyList<EngineDiagnostic>>> Analyze { get; set; } =
        _ => Task.FromResult<IReadOnlyList<EngineDiagnostic>>([]);

    public List<(string Kind, Document Document, JsonObject Settings, CleanupRequest? Request)> Calls { get; } = [];

    public async Task<CleanupOutcome> CleanupAsync(Document document, CleanupRequest request, CancellationToken cancellationToken)
    {
        Record("cleanup", document, request.UserSettings, request);

        return await Cleanup(document, request, cancellationToken);
    }

    public Task<IReadOnlyList<EngineDiagnostic>> AnalyzeAsync(Document document, JsonObject userSettings, CancellationToken cancellationToken)
    {
        Record("analyze", document, userSettings, null);

        return Analyze(document);
    }

    public Task<CleanupOutcome> FixRuleAsync(Document document, JsonObject userSettings, string ruleId, int? line, CancellationToken cancellationToken)
    {
        Record($"fixRule {ruleId} {line}", document, userSettings, null);

        return FixRule(document, ruleId, line);
    }

    public Task<IReadOnlyDictionary<string, string>> OverrideNotesAsync(string directory, JsonObject userSettings, CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyDictionary<string, string>>(new Dictionary<string, string> { ["removeRegions"] = $"set by {directory}/.codejanitor" });

    public async Task<Solution> ExecuteCommandAsync(Document document, string command, JsonObject userSettings, JsonObject? arguments, CancellationToken cancellationToken)
    {
        Record($"command {command} {arguments?.ToJsonString()}", document, userSettings, null);
        var text = await document.GetTextAsync(cancellationToken);

        return document.WithText(Microsoft.CodeAnalysis.Text.SourceText.From("// " + command + "\n" + text, text.Encoding)).Project.Solution;
    }

    public Task<JsonNode?> QueryAsync(Document document, string query, JsonObject userSettings, JsonObject? arguments, CancellationToken cancellationToken)
    {
        Record($"query {query}", document, userSettings, null);

        return Task.FromResult<JsonNode?>(new JsonObject { ["name"] = document.Name, ["line"] = arguments?["line"]?.DeepClone() });
    }

    private void Record(string kind, Document document, JsonObject settings, CleanupRequest? request)
    {
        lock (Calls)
        {
            Calls.Add((kind, document, settings, request));
        }
    }
}
