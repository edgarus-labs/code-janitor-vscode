using System.Reflection;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using CodeJanitor.Engine.Contracts;
using CodeJanitor.Engine.Pipeline;
using CodeJanitor.Engine.Settings;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;

namespace CodeJanitor.Engine;

/// <summary>
/// The cleanup engine: runs the cleanup steps of the engine assembly (discovered by reflection) on a document, by stage
/// then order, each on the result of the previous one, with the settings of the file (<see cref="EffectiveSettings"/>).
/// Stateless per request and safe for concurrent calls.
/// </summary>
public sealed partial class CleanupEngine : ICleanupEngine
{
    private const string OnlyChangedLinesKey = "onlyChangedLines";
    private const string ChangedLinesSetting = "codeJanitor.cleanup." + OnlyChangedLinesKey;
    private const string OutsideChangedLines = "its changes span lines not changed since the last commit (" + ChangedLinesSetting + ")";
    private const string SkipUsingsOnSaveSetting = "skipOrganizeUsingsDuringCleanupOnSave";
    private const string ProbeFileName = "CodeJanitorOptionsProbe.cs";
    private const string OnSaveScope = "cleanup on save";
    private const string PartialScope = "a partial cleanup of a file outside the workspace folders";
    private const string OnSaveTypesNotMoved = OnSaveScope + " does not create files (VS Code can drop the edits of a save, which would leave the type in two files); a cleanup command moves it";
    private const string PartialTypesNotMoved = PartialScope + " does not create files";

    /// <summary>The rules that sort, remove or move using directives, which a cleanup on save may skip and a partial cleanup always skips.</summary>
    private static readonly string[] UsingDirectiveRules = ["organizeUsings", "IDE0005", "IDE0065"];

    private static readonly Lazy<Components> Discovered = new(Discover);

    private readonly Components _components;
    private readonly Action<string>? _log;

    /// <summary>Initializes a new instance of the <see cref="CleanupEngine"/> class with the steps, commands and queries of the engine assembly.</summary>
    /// <param name="log">Where the details of a failure (the stack of an exception) go, one string per failure; null to drop them.</param>
    public CleanupEngine(Action<string>? log = null)
    {
        _components = Discovered.Value;
        _log = log;
    }

    /// <summary>Initializes a new instance of the <see cref="CleanupEngine"/> class with the given steps (ordered here) and no commands or queries.</summary>
    internal CleanupEngine(IEnumerable<ICleanupStep> steps, Action<string>? log = null)
    {
        _components = new Components(Order(steps), new Dictionary<string, IDocumentCommand>(), new Dictionary<string, IDocumentQuery>());
        _log = log;
    }

    /// <summary>The cleanup steps of the engine assembly, in the order they run.</summary>
    internal static IReadOnlyList<ICleanupStep> DiscoveredSteps => Discovered.Value.Steps;

    /// <summary>The explicit commands of the engine assembly, by protocol name.</summary>
    internal static IReadOnlyDictionary<string, IDocumentCommand> DiscoveredCommands => Discovered.Value.Commands;

    /// <summary>The read-only queries of the engine assembly, by protocol name.</summary>
    internal static IReadOnlyDictionary<string, IDocumentQuery> DiscoveredQueries => Discovered.Value.Queries;

    private IReadOnlyList<ICleanupStep> Steps => _components.Steps;

    private IReadOnlyDictionary<string, IDocumentCommand> Commands => _components.Commands;

    private IReadOnlyDictionary<string, IDocumentQuery> Queries => _components.Queries;

    /// <inheritdoc/>
    public async Task<CleanupOutcome> CleanupAsync(Document document, CleanupRequest request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(document);
        ArgumentNullException.ThrowIfNull(request);

        var settings = await EffectiveSettings.ForDocumentAsync(document, request.UserSettings, cancellationToken).ConfigureAwait(false);
        var issues = new List<string>(settings.Policy.Issues);
        var solution = document.Project.Solution;
        if (await IsGeneratedCodeAsync(document, settings, cancellationToken).ConfigureAwait(false))
        {
            issues.Add($"{document.Name}: skipped, it is generated code.");

            return new CleanupOutcome(solution, [], [], issues);
        }

        var excluded = new HashSet<string>(request.ExcludedRules, StringComparer.OrdinalIgnoreCase);
        if (request.Partial || (request.OnSave && settings.GetBool(SkipUsingsOnSaveSetting)))
        {
            excluded.UnionWith(UsingDirectiveRules);
        }

        var keepOtherFilesScope = request.OnSave ? OnSaveScope : request.Partial ? PartialScope : null;
        IReadOnlySet<int>? changedLines = null;
        if (request.ChangedLines is not null && settings.GetBool(OnlyChangedLinesKey))
        {
            var lineCount = (await document.GetTextAsync(cancellationToken).ConfigureAwait(false)).Lines.Count;
            changedLines = ToLineSet(request.ChangedLines, lineCount);
        }

        var rules = new List<RuleOutcome>();
        var unresolved = new List<UnresolvedDiagnostic>();
        var failures = new List<string>();

        foreach (var step in Steps)
        {
            if (!step.IsEnabled(settings))
            {
                continue;
            }

            var current = solution.GetDocument(document.Id)!;
            try
            {
                if (step is IRuleReportingStep ruleStep)
                {
                    var before = (await current.GetTextAsync(cancellationToken).ConfigureAwait(false)).ToString();
                    var run = await ruleStep.RunAsync(current, settings, new StepRunOptions(excluded, ChangedLines: changedLines, KeepOtherFiles: keepOtherFilesScope is not null), cancellationToken).ConfigureAwait(false);
                    if (keepOtherFilesScope is not null && await CountOtherChangedDocumentsAsync(solution, run.Solution, document.Id, cancellationToken).ConfigureAwait(false) > 0)
                    {
                        issues.Add($"{step.Name}: not applied, {keepOtherFilesScope} does not change or create other files.");
                        continue;
                    }

                    rules.AddRange(run.Rules);
                    unresolved.AddRange(run.Unresolved);
                    issues.AddRange(run.Issues);
                    failures.AddRange(run.Failures);
                    if (changedLines is not null)
                    {
                        var after = (await run.Solution.GetDocument(document.Id)!.GetTextAsync(cancellationToken).ConfigureAwait(false)).ToString();
                        changedLines = ChangedLines.Renumber(changedLines, LineDiff.Hunks(before, after));
                    }

                    solution = run.Solution;
                    continue;
                }

                var id = step.RuleId ?? step.Name;
                if (step.RuleId is not null && excluded.Contains(step.RuleId))
                {
                    rules.Add(new RuleOutcome(id, step.Name, 0, Included: false));
                    continue;
                }

                if (keepOtherFilesScope is not null && step is IFileCreatingStep fileStep)
                {
                    issues.AddRange(await fileStep.ReportWithoutCreatingAsync(current, settings, request.OnSave ? OnSaveTypesNotMoved : PartialTypesNotMoved, cancellationToken).ConfigureAwait(false));
                    rules.Add(new RuleOutcome(id, step.Name, 0, Included: true));
                    continue;
                }

                var applied = await ApplyStepAsync(step, current, settings, changedLines, keepOtherFilesScope, cancellationToken).ConfigureAwait(false);
                issues.AddRange(applied.Issues);
                if (applied.NotAppliedBecause is { } why)
                {
                    issues.Add($"{id}: not applied, {why}.");
                    rules.Add(new RuleOutcome(id, step.Name, 0, Included: true));
                    continue;
                }

                rules.Add(new RuleOutcome(id, step.Name, applied.Changes, Included: true));
                solution = applied.Solution;
                changedLines = applied.ChangedLines;
            }
            catch (Exception exception) when (exception is not (OperationCanceledException or OutOfMemoryException))
            {
                failures.Add($"{step.Name} failed and was not applied: {exception.GetType().Name}: {Flatten(exception.Message)}");
                _log?.Invoke($"{step.Name} failed on {document.FilePath ?? document.Name}: {exception}");
            }
        }

        return new CleanupOutcome(solution, rules, unresolved, issues) { Failures = failures };
    }

    /// <inheritdoc/>
    public async Task<IReadOnlyList<EngineDiagnostic>> AnalyzeAsync(Document document, JsonObject userSettings, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(document);
        var settings = await EffectiveSettings.ForDocumentAsync(document, userSettings, cancellationToken).ConfigureAwait(false);
        if (await IsGeneratedCodeAsync(document, settings, cancellationToken).ConfigureAwait(false))
        {
            return [];
        }

        var diagnostics = new List<EngineDiagnostic>();
        foreach (var step in Steps.OfType<IAnalyzingStep>())
        {
            diagnostics.AddRange(await step.AnalyzeAsync(document, settings, cancellationToken).ConfigureAwait(false));
        }

        return diagnostics;
    }

    /// <inheritdoc/>
    public async Task<CleanupOutcome> FixRuleAsync(Document document, JsonObject userSettings, string ruleId, int? line, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(document);
        ArgumentException.ThrowIfNullOrEmpty(ruleId);

        var settings = await EffectiveSettings.ForDocumentAsync(document, userSettings, cancellationToken).ConfigureAwait(false);
        var solution = document.Project.Solution;
        if (await IsGeneratedCodeAsync(document, settings, cancellationToken).ConfigureAwait(false))
        {
            return new CleanupOutcome(solution, [], [], []);
        }

        var ruleStep = Steps.OfType<IRuleReportingStep>().FirstOrDefault(step => step.OwnsRule(ruleId));
        if (ruleStep is not null)
        {
            var run = await ruleStep.RunAsync(document, settings, StepRunOptions.All with { OnlyRule = ruleId, OnlyLine = line }, cancellationToken).ConfigureAwait(false);

            return new CleanupOutcome(run.Solution, run.Rules, run.Unresolved, run.Issues) { Failures = run.Failures };
        }

        var step = Steps.FirstOrDefault(candidate => string.Equals(candidate.RuleId ?? candidate.Name, ruleId, StringComparison.OrdinalIgnoreCase))
            ?? throw new ArgumentException($"Unknown rule '{ruleId}'.", nameof(ruleId));
        var lines = line is null ? null : (IReadOnlySet<int>)new HashSet<int> { line.Value };
        var applied = await ApplyStepAsync(step, document, settings, lines, keepOtherFilesScope: null, cancellationToken).ConfigureAwait(false);
        var skipped = applied.NotAppliedBecause is not null;
        var issues = skipped ? new[] { $"{ruleId}: not applied, its change on line {line + 1} spans other lines." } : [];

        return new CleanupOutcome(skipped ? solution : applied.Solution, [new RuleOutcome(ruleId, step.Name, skipped ? 0 : applied.Changes, Included: true)], [], issues);
    }

    /// <inheritdoc/>
    public Task<IReadOnlyDictionary<string, string>> OverrideNotesAsync(string directory, JsonObject userSettings, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(directory))
        {
            return Task.FromResult<IReadOnlyDictionary<string, string>>(new Dictionary<string, string>());
        }

        return Task.FromResult(OverrideNotes.For(Path.Combine(Path.GetFullPath(directory), ProbeFileName), userSettings));
    }

    /// <inheritdoc/>
    public async Task<Solution> ExecuteCommandAsync(Document document, string command, JsonObject userSettings, JsonObject? arguments, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(document);
        if (!Commands.TryGetValue(command, out var handler))
        {
            throw new ArgumentException($"Unknown command '{command}'.", nameof(command));
        }

        var settings = await EffectiveSettings.ForDocumentAsync(document, userSettings, cancellationToken).ConfigureAwait(false);

        return await handler.ExecuteAsync(document, settings, arguments, cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc/>
    public async Task<JsonNode?> QueryAsync(Document document, string query, JsonObject userSettings, JsonObject? arguments, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(document);
        if (!Queries.TryGetValue(query, out var handler))
        {
            throw new ArgumentException($"Unknown query '{query}'.", nameof(query));
        }

        var settings = await EffectiveSettings.ForDocumentAsync(document, userSettings, cancellationToken).ConfigureAwait(false);

        return await handler.QueryAsync(document, settings, arguments, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// Generated code is not cleaned, as the .NET analyzers do not report on it: <c>generated_code = true</c>, or a leading
    /// comment containing <c>&lt;auto-generated</c>.
    /// </summary>
    internal static async Task<bool> IsGeneratedCodeAsync(Document document, IEffectiveSettings settings, CancellationToken cancellationToken)
    {
        var generated = settings.EditorConfigValue("generated_code")?.Trim();
        if (string.Equals(generated, "true", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        if (string.Equals(generated, "false", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var text = await document.GetTextAsync(cancellationToken).ConfigureAwait(false);
        var header = LeadingComments().Match(text.ToString(new TextSpan(0, Math.Min(text.Length, 8192)))).Value;

        return header.Contains("<auto-generated", StringComparison.OrdinalIgnoreCase) || header.Contains("<autogenerated", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Applies one step. It is not applied (<see cref="AppliedStep.NotAppliedBecause"/>) when it would change or create other
    /// files while <paramref name="keepOtherFilesScope"/> (on save, partial cleanup) forbids it, or when its changes span lines
    /// outside <paramref name="changedLines"/>.
    /// </summary>
    private static async Task<AppliedStep> ApplyStepAsync(ICleanupStep step, Document document, EffectiveSettings settings, IReadOnlySet<int>? changedLines, string? keepOtherFilesScope, CancellationToken cancellationToken)
    {
        var solution = document.Project.Solution;
        var beforeText = await document.GetTextAsync(cancellationToken).ConfigureAwait(false);
        var before = beforeText.ToString();
        IReadOnlyList<string> issues = [];
        Solution changed;
        if (step is IIssueReportingStep reporting)
        {
            (changed, issues) = await reporting.ApplyWithIssuesAsync(document, settings, cancellationToken).ConfigureAwait(false);
        }
        else
        {
            changed = await step.ApplyAsync(document, settings, cancellationToken).ConfigureAwait(false);
        }

        var afterDocument = changed.GetDocument(document.Id);
        var after = afterDocument is null ? before : (await afterDocument.GetTextAsync(cancellationToken).ConfigureAwait(false)).ToString();
        var otherChanges = await CountOtherChangedDocumentsAsync(solution, changed, document.Id, cancellationToken).ConfigureAwait(false);
        if (otherChanges > 0 && keepOtherFilesScope is not null)
        {
            return new AppliedStep(solution, 0, changedLines, $"{keepOtherFilesScope} does not change or create other files", issues);
        }

        if (changedLines is null)
        {
            return new AppliedStep(changed, LineDiff.CountChangedRegions(before, after) + otherChanges, null, NotAppliedBecause: null, issues);
        }

        if (otherChanges > 0)
        {
            return new AppliedStep(solution, 0, changedLines, OutsideChangedLines, issues);
        }

        var kept = await ChangedLines.KeepAsync(document, before, after, changedLines, async text =>
        {
            var redone = await step.ApplyAsync(document.WithText(SourceText.From(text, beforeText.Encoding)), settings, cancellationToken).ConfigureAwait(false);

            return (await redone.GetDocument(document.Id)!.GetTextAsync(cancellationToken).ConfigureAwait(false)).ToString();
        }, cancellationToken).ConfigureAwait(false);
        if (kept is null)
        {
            return new AppliedStep(solution, 0, changedLines, OutsideChangedLines, issues);
        }

        var (keptText, lines, regions) = kept.Value;
        var result = keptText == after ? changed : keptText == before ? solution : solution.WithDocumentText(document.Id, SourceText.From(keptText, (await afterDocument!.GetTextAsync(cancellationToken).ConfigureAwait(false)).Encoding));

        return new AppliedStep(result, regions, lines, NotAppliedBecause: null, issues);
    }

    private static async Task<int> CountOtherChangedDocumentsAsync(Solution before, Solution after, DocumentId documentId, CancellationToken cancellationToken)
    {
        if (ReferenceEquals(before, after))
        {
            return 0;
        }

        var copies = before.GetDocument(documentId)?.FilePath is { } filePath ? before.GetDocumentIdsWithFilePath(filePath) : [];
        var count = 0;
        foreach (var projectChanges in after.GetChanges(before).GetProjectChanges())
        {
            count += projectChanges.GetAddedDocuments().Count();
            foreach (var changedId in projectChanges.GetChangedDocuments(onlyGetDocumentsWithTextChanges: true))
            {
                if (changedId == documentId || copies.Contains(changedId))
                {
                    continue;
                }

                var oldText = await before.GetDocument(changedId)!.GetTextAsync(cancellationToken).ConfigureAwait(false);
                var newText = await after.GetDocument(changedId)!.GetTextAsync(cancellationToken).ConfigureAwait(false);
                if (!oldText.ContentEquals(newText))
                {
                    count++;
                }
            }
        }

        return count;
    }

    /// <summary>The 0-based lines of the 1-based inclusive <paramref name="ranges"/>, cut at the last of <paramref name="lineCount"/> lines.</summary>
    private static HashSet<int> ToLineSet(IReadOnlyList<LineRange> ranges, int lineCount)
    {
        var lines = new HashSet<int>();
        foreach (var range in ranges)
        {
            if (range.Start < 1 || range.End < range.Start)
            {
                throw new ArgumentException($"The changed line range {range.Start}-{range.End} is not a 1-based range with its start not after its end.", nameof(ranges));
            }

            for (var line = range.Start; line <= Math.Min(range.End, lineCount); line++)
            {
                lines.Add(line - 1);
            }
        }

        return lines;
    }

    private static string Flatten(string message) => string.Join(" ", message.Split(["\r\n", "\r", "\n"], StringSplitOptions.None));

    private static Components Discover()
    {
        var types = typeof(CleanupEngine).Assembly.GetTypes()
            .Where(type => type is { IsAbstract: false, IsInterface: false, ContainsGenericParameters: false } && type.GetConstructor(Type.EmptyTypes) is { IsPublic: true })
            .ToList();

        var steps = Order(types.Where(typeof(ICleanupStep).IsAssignableFrom).Select(type => (ICleanupStep)Activator.CreateInstance(type)!));
        var commands = types.Where(typeof(IDocumentCommand).IsAssignableFrom).Select(type => (IDocumentCommand)Activator.CreateInstance(type)!)
            .ToDictionary(command => command.Name, StringComparer.Ordinal);
        var queries = types.Where(typeof(IDocumentQuery).IsAssignableFrom).Select(type => (IDocumentQuery)Activator.CreateInstance(type)!)
            .ToDictionary(query => query.Name, StringComparer.Ordinal);

        return new Components(steps, commands, queries);
    }

    private static List<ICleanupStep> Order(IEnumerable<ICleanupStep> steps) => steps
        .OrderBy(step => step.Stage)
        .ThenBy(step => step.Order)
        .ThenBy(step => step.Name, StringComparer.Ordinal)
        .ToList();

    [GeneratedRegex(@"^\uFEFF?(?:\s*(?://[^\n]*|/\*[\s\S]*?\*/))*")]
    private static partial Regex LeadingComments();

    private sealed record Components(IReadOnlyList<ICleanupStep> Steps, IReadOnlyDictionary<string, IDocumentCommand> Commands, IReadOnlyDictionary<string, IDocumentQuery> Queries);

    private sealed record AppliedStep(Solution Solution, int Changes, IReadOnlySet<int>? ChangedLines, string? NotAppliedBecause, IReadOnlyList<string> Issues);
}
