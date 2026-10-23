using System.Collections.Immutable;
using System.Globalization;
using System.Runtime.CompilerServices;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CodeActions;
using Microsoft.CodeAnalysis.CodeFixes;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Text;

namespace CodeJanitor.Engine.Diagnostics;

/// <summary>
/// Fixes the Roslyn diagnostics of one document with the existing analyzers and code fix providers. Which rules are
/// active, and how they are configured, comes from .editorconfig (the project's analyzer config documents) and
/// <see cref="DiagnosticCleanupOptions.AnalyzerConfigOverrides" />; which rule families may be fixed comes from
/// <see cref="DiagnosticCleanupOptions.EnabledCategories" />.
/// </summary>
/// <remarks>
/// <para>
/// Host-agnostic: only the public Roslyn API is used and nothing is applied to a workspace; the caller applies
/// <see cref="DiagnosticCleanupResult.ChangedSolution" />. Rules are never re-implemented, diagnostics are never
/// suppressed, and no diagnostic ID is special-cased.
/// </para>
/// <para>
/// A diagnostic is actionable when it is located in the document, is not suppressed, is reported with at least Info
/// severity (hidden/silent rules and rules configured as none stay untouched) and its category is enabled. Severities
/// are the ones Roslyn reports for the project's analyzer config: <c>dotnet_diagnostic.&lt;id&gt;.severity</c>, the
/// <c>option = value:severity</c> suffix, or a naming rule's severity. The document is analyzed like the IDE analyzes
/// an open document (syntax and semantic analysis of its tree), so diagnostics that analyzers only report at
/// compilation end are not seen.
/// </para>
/// <para>
/// Each pass analyzes the document, picks the fix of every actionable diagnostic (the first top-level action without
/// nested actions, from the first provider in catalog order that offers one) and applies the first group of diagnostics
/// that share provider and equivalence key: through the provider's fix-all provider when it supports document scope,
/// otherwise for the first diagnostic of the group only. When the provider also offers other actions with the same
/// equivalence key, the batch fixer is used with only the chosen action of each diagnostic. A fix is accepted only when its operations contain
/// exactly one solution change, that change merely changes document texts, and it adds no compiler error to any project
/// compiling a changed file. Other operations (host/UI notifications) are never executed. A rejected group is not retried in the same run. Passes
/// repeat until no actionable diagnostic can make progress or <see cref="DiagnosticCleanupOptions.MaxPasses" /> fixes
/// were applied.
/// </para>
/// <para>
/// Exceptions thrown by code fix providers (while registering fixes, providing a fix-all provider or computing a fix)
/// never abort the cleanup: the affected diagnostics are reported as <see cref="UnresolvedDiagnosticReason.FixProviderFailed" />
/// and the other fixes still apply; a provider that failed while registering fixes for a diagnostic id is not asked again
/// for that id in the same run. Only cancellation propagates to the caller. Analyzer failures are reported by Roslyn
/// without a source location, so they never become actionable; they are listed in <see cref="DiagnosticCleanupResult.AnalyzerFailures" />.
/// </para>
/// </remarks>
public sealed class DiagnosticCleanupEngine
{
    private static readonly ConditionalWeakTable<DiagnosticAnalyzer, AnalyzerCategories> s_analyzerCategories =
        new ConditionalWeakTable<DiagnosticAnalyzer, AnalyzerCategories>();

    private readonly CodeFixProviderCatalog _catalog;

    /// <summary>Initializes a new instance of the <see cref="DiagnosticCleanupEngine" /> class with the providers of the analyzer references and of <see cref="HostAnalyzers" />.</summary>
    public DiagnosticCleanupEngine()
        : this(new CodeFixProviderCatalog(hostReferences: HostAnalyzers.References))
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="DiagnosticCleanupEngine" /> class.
    /// </summary>
    /// <param name="catalog">The source of the code fix providers.</param>
    public DiagnosticCleanupEngine(CodeFixProviderCatalog catalog)
    {
        ArgumentNullException.ThrowIfNull(catalog);
        _catalog = catalog;
    }

    /// <summary>
    /// Fixes the actionable diagnostics located in <paramref name="document" />. Fixes may edit other documents too
    /// (e.g. a rename updates references), but only diagnostics of <paramref name="document" /> are targeted.
    /// </summary>
    /// <param name="document">The document to clean.</param>
    /// <param name="options">The enabled categories and the pass limit.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>The changed solution with applied fixes and the diagnostics left unresolved.</returns>
    public async Task<DiagnosticCleanupResult> CleanupAsync(Document document, DiagnosticCleanupOptions options, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(document);
        ArgumentNullException.ThrowIfNull(options);

        var solution = document.Project.Solution;
        if (options.IsEmpty)
        {
            return CreateUnchangedResult(solution, []);
        }

        var workingDocument = await WithAnalyzerConfigOverridesAsync(document, options.AnalyzerConfigOverrides, cancellationToken).ConfigureAwait(false);
        var project = workingDocument.Project;
        var (analyzers, analyzerFailures) = GetAnalyzers(project, options);

        // Suppressors alone cannot report anything actionable: no analyzer of an enabled category means no analysis.
        if (analyzers.All(analyzer => analyzer is DiagnosticSuppressor))
        {
            return CreateUnchangedResult(solution, analyzerFailures);
        }

        var (providersByDiagnosticId, providerLoadFailures) = IndexProviders(project);
        var run = new CleanupRun(document.Id, options, analyzers, analyzerFailures, providersByDiagnosticId, providerLoadFailures);
        var result = await run.ExecuteAsync(project.Solution, cancellationToken).ConfigureAwait(false);

        return await RebaseAsync(result, solution, document.Id, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// The actionable diagnostics of <paramref name="document" /> without changing it, each with whether its fix exists and
    /// passes the same validation as in <see cref="CleanupAsync" /> (checked once per group of provider and equivalence key).
    /// </summary>
    public async Task<IReadOnlyList<AnalyzedDiagnostic>> AnalyzeAsync(Document document, DiagnosticCleanupOptions options, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(document);
        ArgumentNullException.ThrowIfNull(options);
        if (options.IsEmpty)
        {
            return [];
        }

        var workingDocument = await WithAnalyzerConfigOverridesAsync(document, options.AnalyzerConfigOverrides, cancellationToken).ConfigureAwait(false);
        var project = workingDocument.Project;
        var (analyzers, analyzerFailures) = GetAnalyzers(project, options);
        if (analyzers.All(analyzer => analyzer is DiagnosticSuppressor))
        {
            return [];
        }

        var (providersByDiagnosticId, providerLoadFailures) = IndexProviders(project);
        var run = new CleanupRun(document.Id, options, analyzers, analyzerFailures, providersByDiagnosticId, providerLoadFailures);

        return await run.AnalyzeAsync(project.Solution, cancellationToken).ConfigureAwait(false);
    }

    private static DiagnosticCleanupResult CreateUnchangedResult(Solution solution, IEnumerable<string> analyzerFailures) =>
        new(solution, solution, [], [], analyzerFailures);

    /// <summary>What kept code fix providers out of the catalog, as the detail of a diagnostic that has no fix; null when nothing did.</summary>
    private static string? DescribeLoadFailures(ImmutableArray<string> failures) => failures.IsEmpty
        ? null
        : "code fix providers failed to load: " + string.Join("; ", failures.Take(3)) + (failures.Length > 3 ? $"; and {failures.Length - 3} more" : string.Empty);

    /// <summary>
    /// Returns the document in a solution whose analyzer configuration also contains <paramref name="overrides" />, as
    /// the last section of an .editorconfig in the document's directory: the nearest .editorconfig and its last
    /// section win, so the overrides beat every other .editorconfig and global configuration. An existing
    /// .editorconfig there gets the section appended; otherwise one is added.
    /// </summary>
    internal static async Task<Document> WithAnalyzerConfigOverridesAsync(Document document, IReadOnlyDictionary<string, string> overrides, CancellationToken cancellationToken)
    {
        if (overrides.Count == 0)
        {
            return document;
        }

        if (string.IsNullOrEmpty(document.FilePath) || !Path.IsPathRooted(document.FilePath))
        {
            throw new InvalidOperationException($"Analyzer configuration overrides need a document with an absolute file path; '{document.Name}' has none.");
        }

        var section = "[*]\n" + string.Concat(overrides.Select(entry => entry.Key + " = " + entry.Value + "\n"));
        var configPath = Path.Combine(Path.GetDirectoryName(document.FilePath)!, ".editorconfig");
        var project = document.Project;
        var existing = project.AnalyzerConfigDocuments.FirstOrDefault(config => string.Equals(config.FilePath, configPath, StringComparison.OrdinalIgnoreCase));

        Solution solution;
        if (existing is null)
        {
            solution = project.Solution.AddAnalyzerConfigDocument(DocumentId.CreateNewId(project.Id), ".editorconfig", SourceText.From(section), filePath: configPath);
        }
        else
        {
            var text = (await existing.GetTextAsync(cancellationToken).ConfigureAwait(false)).ToString();
            var separator = text.Length == 0 || text.EndsWith("\n", StringComparison.Ordinal) ? string.Empty : "\n";
            solution = project.Solution.WithAnalyzerConfigDocumentText(existing.Id, SourceText.From(text + separator + section));
        }

        return solution.GetDocument(document.Id)!;
    }

    /// <summary>
    /// Moves the text changes of a run onto <paramref name="solution" />, so the result never carries the analyzer
    /// configuration overrides. Each changed document keeps the line ending of its file (its <c>end_of_line</c>, otherwise
    /// the one line ending its original text uses throughout), because a code fix may insert line breaks of its own.
    /// </summary>
    private static async Task<DiagnosticCleanupResult> RebaseAsync(
        DiagnosticCleanupResult result,
        Solution solution,
        DocumentId cleanedDocumentId,
        CancellationToken cancellationToken)
    {
        var changedSolution = solution;

        foreach (var projectChanges in result.ChangedSolution.GetChanges(result.OriginalSolution).GetProjectChanges())
        {
            foreach (var documentId in projectChanges.GetChangedDocuments(onlyGetDocumentsWithTextChanges: true))
            {
                var original = solution.GetDocument(documentId)!;
                var originalText = await original.GetTextAsync(cancellationToken).ConfigureAwait(false);
                var tree = await original.GetSyntaxTreeAsync(cancellationToken).ConfigureAwait(false);
                string? endOfLine = null;
                if (tree is not null)
                {
                    original.Project.AnalyzerOptions.AnalyzerConfigOptionsProvider.GetOptions(tree).TryGetValue("end_of_line", out endOfLine);
                }

                var text = await result.ChangedSolution.GetDocument(documentId)!.GetTextAsync(cancellationToken).ConfigureAwait(false);
                if (documentId == cleanedDocumentId)
                {
                    text = WithoutBlankLinesAddedAtStart(originalText, text);
                }

                changedSolution = changedSolution.WithDocumentText(documentId, Pipeline.LineEndings.Restore(text, originalText, endOfLine));
            }
        }

        return new DiagnosticCleanupResult(solution, changedSolution, result.AppliedFixes, result.Unresolved, result.AnalyzerFailures);
    }

    /// <summary>
    /// Removes the blank lines at the start of <paramref name="fixedText" /> when <paramref name="originalText" /> had
    /// none. A fix that moves the first member of a file leaves the blank line that separated it from the member
    /// before at the top of the file, e.g. the using directives moved above a file-scoped namespace (IDE0065).
    /// </summary>
    /// <param name="originalText">The text before the fixes.</param>
    /// <param name="fixedText">The text after the fixes.</param>
    /// <returns>The fixed text without the blank lines added at its start.</returns>
    private static SourceText WithoutBlankLinesAddedAtStart(SourceText originalText, SourceText fixedText)
    {
        var blankLineCount = CountLeadingBlankLines(fixedText);
        if (blankLineCount == 0 || CountLeadingBlankLines(originalText) > 0)
        {
            return fixedText;
        }

        return fixedText.WithChanges(new TextChange(TextSpan.FromBounds(0, fixedText.Lines[blankLineCount].Start), string.Empty));
    }

    /// <summary>
    /// Counts the lines at the start of the text that hold only whitespace, when a line with content follows them.
    /// </summary>
    /// <param name="text">The text.</param>
    /// <returns>The number of leading blank lines; zero for a text that is entirely blank.</returns>
    private static int CountLeadingBlankLines(SourceText text)
    {
        var count = 0;
        while (count < text.Lines.Count && string.IsNullOrWhiteSpace(text.Lines[count].ToString()))
        {
            count++;
        }

        return count == text.Lines.Count ? 0 : count;
    }

    /// <summary>
    /// Gets the analyzers of the project and solution analyzer references and of the Roslyn Features assemblies
    /// (<see cref="HostAnalyzers" />), deduplicated by type with project analyzers taking precedence.
    /// Analyzers that cannot report a diagnostic of an enabled category, or none of <see cref="DiagnosticCleanupOptions.DiagnosticIds" />,
    /// are skipped, which does not change the result; diagnostic suppressors always run so suppressed diagnostics stay suppressed.
    /// An analyzer whose descriptors cannot be obtained is skipped and reported as a failure.
    /// </summary>
    private static (ImmutableArray<DiagnosticAnalyzer> Analyzers, ImmutableArray<string> Failures) GetAnalyzers(Project project, DiagnosticCleanupOptions options)
    {
        var analyzerTypes = new HashSet<string>(StringComparer.Ordinal);
        var analyzers = ImmutableArray.CreateBuilder<DiagnosticAnalyzer>();
        var failures = ImmutableArray.CreateBuilder<string>();

        foreach (var reference in project.AnalyzerReferences.Concat(project.Solution.AnalyzerReferences).Concat(HostAnalyzers.References))
        {
            foreach (var analyzer in reference.GetAnalyzers(project.Language))
            {
                if (!analyzerTypes.Add(analyzer.GetType().FullName ?? analyzer.GetType().Name))
                {
                    continue;
                }

                if (analyzer is DiagnosticSuppressor)
                {
                    analyzers.Add(analyzer);

                    continue;
                }

                var categories = s_analyzerCategories.GetValue(analyzer, ClassifySupportedDiagnostics);
                if (categories.Failure is not null)
                {
                    failures.Add(categories.Failure);
                }
                else if (categories.Categories.Any(options.IsEnabled) && (options.DiagnosticIds is null || SupportsAnyIncludedDiagnostic(analyzer, options)))
                {
                    analyzers.Add(analyzer);
                }
            }
        }

        return (analyzers.ToImmutable(), failures.ToImmutable());
    }

    private static bool SupportsAnyIncludedDiagnostic(DiagnosticAnalyzer analyzer, DiagnosticCleanupOptions options)
    {
        try
        {
            return analyzer.SupportedDiagnostics.Any(descriptor => descriptor != null && options.Includes(descriptor.Id));
        }
        catch (Exception)
        {
            // The failure of SupportedDiagnostics is reported by ClassifySupportedDiagnostics, which runs first.
            return false;
        }
    }

    private static AnalyzerCategories ClassifySupportedDiagnostics(DiagnosticAnalyzer analyzer)
    {
        ImmutableArray<DiagnosticDescriptor> descriptors;
        try
        {
            descriptors = analyzer.SupportedDiagnostics;
        }
        catch (Exception exception)
        {
            // Roslyn rejects diagnostics outside SupportedDiagnostics, so the analyzer is skipped and its failure reported.
            return new AnalyzerCategories(ImmutableArray<DiagnosticCleanupCategory>.Empty, DescribeAnalyzerFailure(analyzer, exception));
        }

        return new AnalyzerCategories(
            descriptors.IsDefault
                ? ImmutableArray<DiagnosticCleanupCategory>.Empty
                : descriptors
                    .Where(descriptor => descriptor != null)
                    .Select(descriptor => DiagnosticCleanupCategoryClassifier.Classify(analyzer, descriptor))
                    .OfType<DiagnosticCleanupCategory>()
                    .Distinct()
                    .ToImmutableArray(),
            failure: null);
    }

    private static string DescribeAnalyzerFailure(DiagnosticAnalyzer analyzer, Exception exception) =>
        $"{analyzer.GetType().Name} failed and found nothing: {exception.GetType().Name}: {string.Join(" ", exception.Message.Split(new[] { "\r\n", "\r", "\n" }, StringSplitOptions.None))}";

    /// <summary>
    /// The code fix providers of <paramref name="project" /> by fixable diagnostic id, and what kept providers out of that
    /// index: the catalog's load failures and the providers whose <see cref="CodeFixProvider.FixableDiagnosticIds" /> threw.
    /// </summary>
    private (Lazy<ILookup<string, CodeFixProvider>> ProvidersByDiagnosticId, Lazy<string?> LoadFailures) IndexProviders(Project project)
    {
        var indexFailures = new List<string>();
        var providersByDiagnosticId = new Lazy<ILookup<string, CodeFixProvider>>(() => IndexByDiagnosticId(_catalog.GetProviders(project), indexFailures));
        var loadFailures = new Lazy<string?>(() =>
        {
            _ = providersByDiagnosticId.Value;

            return DescribeLoadFailures([.. _catalog.GetLoadFailures(project), .. indexFailures]);
        });

        return (providersByDiagnosticId, loadFailures);
    }

    private static ILookup<string, CodeFixProvider> IndexByDiagnosticId(ImmutableArray<CodeFixProvider> providers, List<string> failures)
    {
        var entries = new List<KeyValuePair<string, CodeFixProvider>>();
        foreach (var provider in providers)
        {
            ImmutableArray<string> ids;
            try
            {
                ids = provider.FixableDiagnosticIds;
            }
            catch (Exception exception)
            {
                failures.Add($"{provider.GetType().Name} could not list its fixable diagnostics: {exception.GetType().Name}: {string.Join(" ", exception.Message.Split(new[] { "\r\n", "\r", "\n" }, StringSplitOptions.None))}");
                continue;
            }

            if (!ids.IsDefault)
            {
                entries.AddRange(ids.Distinct(StringComparer.Ordinal).Select(id => new KeyValuePair<string, CodeFixProvider>(id, provider)));
            }
        }

        return entries.ToLookup(entry => entry.Key, entry => entry.Value, StringComparer.Ordinal);
    }

    /// <summary>
    /// State of one <see cref="CleanupAsync" /> call.
    /// </summary>
    private sealed class CleanupRun
    {
        private readonly DocumentId _documentId;
        private readonly DiagnosticCleanupOptions _options;
        private readonly ImmutableArray<DiagnosticAnalyzer> _analyzers;
        private readonly Lazy<ILookup<string, CodeFixProvider>> _providersByDiagnosticId;
        private readonly Lazy<string?> _providerLoadFailures;
        private readonly List<string> _analyzerFailures = [];

        private readonly Dictionary<(CodeFixProvider? Provider, string? EquivalenceKey), (UnresolvedDiagnosticReason Reason, string? Detail)> _rejectedGroups = [];

        // Providers that threw while registering fixes for a diagnostic id: they are not asked again in later passes of
        // this run (like _rejectedGroups for failures while computing a fix), so their exception is logged once.

        private readonly Dictionary<(CodeFixProvider Provider, string DiagnosticId), string> _registrationFailures = [];

        private readonly List<(string DiagnosticId, DiagnosticCleanupCategory Category, CodeFixProvider Provider)> _appliedOrder =
            [];

        private readonly Dictionary<(string DiagnosticId, DiagnosticCleanupCategory Category, CodeFixProvider Provider), int> _appliedCounts = [];

        private Solution? _errorSolution;
        private Dictionary<ProjectId, IReadOnlyList<Diagnostic>> _errors = [];

        public CleanupRun(
            DocumentId documentId,
            DiagnosticCleanupOptions options,
            ImmutableArray<DiagnosticAnalyzer> analyzers,
            ImmutableArray<string> analyzerFailures,
            Lazy<ILookup<string, CodeFixProvider>> providersByDiagnosticId,
            Lazy<string?> providerLoadFailures)
        {
            _documentId = documentId;
            _options = options;
            _analyzers = analyzers;
            _analyzerFailures.AddRange(analyzerFailures);
            _providersByDiagnosticId = providersByDiagnosticId;
            _providerLoadFailures = providerLoadFailures;
        }

        public async Task<DiagnosticCleanupResult> ExecuteAsync(Solution originalSolution, CancellationToken cancellationToken)
        {
            var solution = originalSolution;

            for (var pass = 0; ; pass++)
            {
                var document = solution.GetDocument(_documentId)!;
                var plans = await PlanFixesAsync(document, cancellationToken).ConfigureAwait(false);
                if (plans.IsEmpty || pass == _options.MaxPasses)
                {
                    return CreateResult(originalSolution, solution, plans);
                }

                var fixedSolution = await ApplyFirstAcceptedGroupAsync(solution, document, plans, cancellationToken).ConfigureAwait(false);
                if (fixedSolution is null)
                {
                    return CreateResult(originalSolution, solution, plans);
                }

                solution = fixedSolution;
            }
        }

        public async Task<IReadOnlyList<AnalyzedDiagnostic>> AnalyzeAsync(Solution solution, CancellationToken cancellationToken)
        {
            var document = solution.GetDocument(_documentId)!;
            var plans = await PlanFixesAsync(document, cancellationToken).ConfigureAwait(false);
            var accepted = new Dictionary<(CodeFixProvider? Provider, string? EquivalenceKey), bool>();

            foreach (var group in plans.Where(plan => plan.IsFixable).GroupBy(plan => plan.GroupKey))
            {
                var attempt = await TryApplyGroupAsync(solution, document, group.ToImmutableArray(), cancellationToken).ConfigureAwait(false);
                accepted[group.Key] = !attempt.Rejection.HasValue;
                if (attempt.Rejection.HasValue)
                {
                    _rejectedGroups[group.Key] = (attempt.Rejection.Value, attempt.RejectionDetail);
                }
            }

            return plans
                .Select(plan => new AnalyzedDiagnostic(
                    plan.Actionable.Diagnostic,
                    plan.Actionable.Category,
                    plan.IsFixable && accepted.GetValueOrDefault(plan.GroupKey),
                    plan.IsFixable && accepted.GetValueOrDefault(plan.GroupKey) ? null : CreateUnresolved(plan)))
                .ToList();
        }

        private async Task<ImmutableArray<FixPlan>> PlanFixesAsync(Document document, CancellationToken cancellationToken)
        {
            var diagnostics = await AnalyzeAsync(document, cancellationToken).ConfigureAwait(false);
            var plans = ImmutableArray.CreateBuilder<FixPlan>(diagnostics.Length);

            foreach (var diagnostic in diagnostics)
            {
                plans.Add(await PlanFixAsync(document, diagnostic, cancellationToken).ConfigureAwait(false));
            }

            return plans.MoveToImmutable();
        }

        /// <summary>
        /// Returns the actionable diagnostics of the document sorted by (span start, id), with deterministic tie-breaks.
        /// </summary>
        private async Task<ImmutableArray<ActionableDiagnostic>> AnalyzeAsync(Document document, CancellationToken cancellationToken)
        {
            var tree = await document.GetSyntaxTreeAsync(cancellationToken).ConfigureAwait(false);
            var compilation = await document.Project.GetCompilationAsync(cancellationToken).ConfigureAwait(false);
            if (tree is null || compilation is null)
            {
                return ImmutableArray<ActionableDiagnostic>.Empty;
            }

            var diagnostics = await GetDiagnosticsAsync(compilation, document.Project.AnalyzerOptions, tree, cancellationToken).ConfigureAwait(false);
            var configOptions = document.Project.AnalyzerOptions.AnalyzerConfigOptionsProvider.GetOptions(tree);
            var treeOptions = compilation.Options.SyntaxTreeOptionsProvider;
            HashSet<(string Id, TextSpan Span, DiagnosticSeverity Severity)>? defaultDiagnostics = null;
            var reported = new HashSet<Diagnostic>();
            var actionable = new List<ActionableDiagnostic>();

            foreach (var (analyzer, diagnostic) in diagnostics)
            {
                if (diagnostic.Location.SourceTree != tree
                    || diagnostic.IsSuppressed
                    || !reported.Add(diagnostic)
                    || !_options.Includes(diagnostic.Id)
                    || _options.Filter?.Invoke(diagnostic) == false)
                {
                    continue;
                }

                var enforced = _options.Enforced?.Invoke(diagnostic) == true || IsNotConfigurableAndEnabled(diagnostic.Descriptor, tree, treeOptions, cancellationToken);
                if (diagnostic.Severity < DiagnosticSeverity.Info && !enforced)
                {
                    continue;
                }

                var category = DiagnosticCleanupCategoryClassifier.Classify(analyzer, diagnostic.Descriptor);
                if (!category.HasValue || !_options.IsEnabled(category.Value))
                {
                    continue;
                }

                if (!enforced
                    && !IsSeverityConfigured(diagnostic.Descriptor, tree, configOptions, treeOptions, cancellationToken)
                    && !(category == DiagnosticCleanupCategory.Naming && configOptions.Keys.Any(key => key.StartsWith("dotnet_naming_rule.", StringComparison.Ordinal))))
                {
                    defaultDiagnostics ??= await GetDiagnosticsWithoutEditorConfigAsync(document, cancellationToken).ConfigureAwait(false);
                    if (defaultDiagnostics.Contains((diagnostic.Id, diagnostic.Location.SourceSpan, diagnostic.Severity)))
                    {
                        continue;
                    }
                }

                var gateDetail = _options.Gate is null ? null : await _options.Gate(document, diagnostic, cancellationToken).ConfigureAwait(false);
                actionable.Add(new ActionableDiagnostic(diagnostic, category.Value, gateDetail));
            }

            return actionable
                .OrderBy(item => item.Diagnostic.Location.SourceSpan.Start)
                .ThenBy(item => item.Diagnostic.Id, StringComparer.Ordinal)
                .ThenBy(item => item.Diagnostic.Location.SourceSpan.End)
                .ThenBy(item => item.Diagnostic.GetMessage(CultureInfo.InvariantCulture), StringComparer.Ordinal)
                .ToImmutableArray();
        }

        private async Task<List<(DiagnosticAnalyzer Analyzer, Diagnostic Diagnostic)>> GetDiagnosticsAsync(
            Compilation compilation,
            AnalyzerOptions analyzerOptions,
            SyntaxTree tree,
            CancellationToken cancellationToken)
        {
            var analysisOptions = new CompilationWithAnalyzersOptions(
                analyzerOptions,
                onAnalyzerException: (exception, analyzer, _) => RecordAnalyzerFailure(DescribeAnalyzerFailure(analyzer, exception)),
                concurrentAnalysis: false,
                logAnalyzerExecutionTime: false,
                reportSuppressedDiagnostics: false);
            var compilationWithAnalyzers = compilation.WithAnalyzers(_analyzers, analysisOptions);
            var syntaxResult = await compilationWithAnalyzers.GetAnalysisResultAsync(tree, cancellationToken).ConfigureAwait(false);
            var semanticModel = compilationWithAnalyzers.Compilation.GetSemanticModel(tree);
            var semanticResult = await compilationWithAnalyzers.GetAnalysisResultAsync(semanticModel, null, cancellationToken).ConfigureAwait(false);

            return new[] { syntaxResult, semanticResult }
                .SelectMany(result => result.Analyzers.SelectMany(analyzer => result.GetAllDiagnostics(analyzer).Select(diagnostic => (analyzer, diagnostic))))
                .ToList();
        }

        private void RecordAnalyzerFailure(string failure)
        {
            lock (_analyzerFailures)
            {
                if (!_analyzerFailures.Contains(failure))
                {
                    _analyzerFailures.Add(failure);
                }
            }
        }

        private async Task<HashSet<(string Id, TextSpan Span, DiagnosticSeverity Severity)>> GetDiagnosticsWithoutEditorConfigAsync(
            Document document,
            CancellationToken cancellationToken)
        {
            var editorConfigIds = document.Project.AnalyzerConfigDocuments
                .Where(config => string.Equals(Path.GetFileName(config.FilePath), ".editorconfig", StringComparison.OrdinalIgnoreCase))
                .Select(config => config.Id)
                .ToImmutableArray();
            var project = document.Project.Solution.RemoveAnalyzerConfigDocuments(editorConfigIds).GetProject(document.Project.Id);
            var tree = await project!.GetDocument(document.Id)!.GetSyntaxTreeAsync(cancellationToken).ConfigureAwait(false);
            var compilation = await project.GetCompilationAsync(cancellationToken).ConfigureAwait(false);
            if (tree is null || compilation is null)
            {
                return [];
            }

            var diagnostics = await GetDiagnosticsAsync(compilation, project.AnalyzerOptions, tree, cancellationToken).ConfigureAwait(false);

            return new HashSet<(string, TextSpan, DiagnosticSeverity)>(
                diagnostics
                    .Where(item => item.Diagnostic.Location.SourceTree == tree)
                    .Select(item => (item.Diagnostic.Id, item.Diagnostic.Location.SourceSpan, item.Diagnostic.Severity)));
        }

        private static bool IsSeverityConfigured(
            DiagnosticDescriptor descriptor,
            SyntaxTree tree,
            AnalyzerConfigOptions configOptions,
            SyntaxTreeOptionsProvider? treeOptions,
            CancellationToken cancellationToken) =>
            treeOptions?.TryGetDiagnosticValue(tree, descriptor.Id, cancellationToken, out _) == true
            || treeOptions?.TryGetGlobalDiagnosticValue(descriptor.Id, cancellationToken, out _) == true
            || configOptions.TryGetValue($"dotnet_analyzer_diagnostic.category-{descriptor.Category}.severity", out _)
            || configOptions.TryGetValue("dotnet_analyzer_diagnostic.severity", out _);

        /// <summary>
        /// A rule Roslyn always reports as hidden (the <c>NotConfigurable</c> tag, e.g. IDE0035): a severity in <c>.editorconfig</c>
        /// cannot raise it, so a severity other than none or silent is what asks for the rule to be applied.
        /// </summary>
        private static bool IsNotConfigurableAndEnabled(DiagnosticDescriptor descriptor, SyntaxTree tree, SyntaxTreeOptionsProvider? treeOptions, CancellationToken cancellationToken) =>
            descriptor.CustomTags.Contains(WellKnownDiagnosticTags.NotConfigurable, StringComparer.Ordinal)
            && treeOptions?.TryGetDiagnosticValue(tree, descriptor.Id, cancellationToken, out var severity) == true
            && severity is ReportDiagnostic.Error or ReportDiagnostic.Warn or ReportDiagnostic.Info;

        private async Task<FixPlan> PlanFixAsync(Document document, ActionableDiagnostic actionable, CancellationToken cancellationToken)
        {
            if (actionable.GateDetail is not null)
            {
                return FixPlan.Unfixable(actionable, UnresolvedDiagnosticReason.NotApplied, actionable.GateDetail);
            }

            var providers = _providersByDiagnosticId.Value[actionable.Diagnostic.Id].ToList();
            if (providers.Count == 0)
            {
                return FixPlan.Unfixable(actionable, UnresolvedDiagnosticReason.NoCodeFixProvider, _providerLoadFailures.Value);
            }

            string? providerFailure = null;
            foreach (var provider in providers)
            {
                if (_registrationFailures.TryGetValue((provider, actionable.Diagnostic.Id), out var knownFailure))
                {
                    providerFailure ??= knownFailure;

                    continue;
                }

                (CodeAction? Action, bool HasEquivalentAlternatives) chosen;
                try
                {
                    chosen = await GetFirstApplicableActionAsync(document, provider, actionable.Diagnostic, cancellationToken).ConfigureAwait(false);
                }
                catch (Exception exception) when (exception is not OperationCanceledException)
                {
                    // Canceling the cleanup wins over whatever the interrupted provider threw.
                    cancellationToken.ThrowIfCancellationRequested();

                    // A provider bug must not stop the cleanup of the file; the next provider may still offer a fix.
                    var failure = DescribeProviderFailure(provider, exception);
                    _registrationFailures[(provider, actionable.Diagnostic.Id)] = failure;
                    providerFailure ??= failure;

                    continue;
                }

                if (chosen.Action is not null)
                {
                    return FixPlan.Fixable(actionable, provider, chosen.Action, chosen.HasEquivalentAlternatives);
                }
            }

            return providerFailure is null
                ? FixPlan.Unfixable(actionable, UnresolvedDiagnosticReason.NoApplicableCodeAction)
                : FixPlan.Unfixable(actionable, UnresolvedDiagnosticReason.FixProviderFailed, providerFailure);
        }

        /// <summary>
        /// Returns the one-line detail reported for the unresolved diagnostic: line breaks of the exception message are
        /// flattened to spaces.
        /// </summary>
        private static string DescribeProviderFailure(CodeFixProvider provider, Exception exception)
        {
            var message = string.Join(" ", exception.Message.Split(new[] { "\r\n", "\r", "\n" }, StringSplitOptions.None));

            return $"{provider.GetType().Name} threw {exception.GetType().Name}: {message}";
        }

        /// <summary>
        /// Gets the first top-level action registered by <paramref name="provider" /> that has no nested actions;
        /// nested actions are choices for a user and are never picked automatically. Also tells whether the provider
        /// registered other actions with the same equivalence key.
        /// </summary>
        private static async Task<(CodeAction? Action, bool HasEquivalentAlternatives)> GetFirstApplicableActionAsync(Document document, CodeFixProvider provider, Diagnostic diagnostic, CancellationToken cancellationToken)
        {
            var actions = new List<CodeAction>();
            var context = new CodeFixContext(
                document,
                diagnostic,
                (action, _) =>
                {
                    lock (actions)
                    {
                        actions.Add(action);
                    }
                },
                cancellationToken);

            await provider.RegisterCodeFixesAsync(context).ConfigureAwait(false);

            lock (actions)
            {
                var chosen = actions.FirstOrDefault(action => action.NestedActions.IsDefaultOrEmpty);
                var hasEquivalentAlternatives = chosen is not null
                    && actions.Any(action => action != chosen && string.Equals(action.EquivalenceKey, chosen.EquivalenceKey, StringComparison.Ordinal));

                return (chosen, hasEquivalentAlternatives);
            }
        }

        private async Task<Solution?> ApplyFirstAcceptedGroupAsync(Solution solution, Document document, ImmutableArray<FixPlan> plans, CancellationToken cancellationToken)
        {
            foreach (var group in plans.Where(plan => plan.IsFixable).GroupBy(plan => plan.GroupKey))
            {
                if (_rejectedGroups.ContainsKey(group.Key))
                {
                    continue;
                }

                var attempt = await TryApplyGroupAsync(solution, document, group.ToImmutableArray(), cancellationToken).ConfigureAwait(false);
                if (attempt.Rejection.HasValue)
                {
                    _rejectedGroups.Add(group.Key, (attempt.Rejection.Value, attempt.RejectionDetail));
                    continue;
                }

                RecordAppliedFixes(attempt.FixedDiagnostics, group.Key.Provider!);

                return attempt.Solution;
            }

            return null;
        }

        private async Task<FixAttempt> TryApplyGroupAsync(Solution solution, Document document, ImmutableArray<FixPlan> group, CancellationToken cancellationToken)
        {
            var first = group[0];
            var action = first.Action!;
            var provider = first.Provider!;
            var fixedDiagnostics = ImmutableArray.Create(first.Actionable);

            var hasAlternatives = group.Any(plan => plan.HasEquivalentAlternatives);
            ImmutableArray<CodeActionOperation> operations;
            try
            {
                var fixAllProvider = hasAlternatives ? WellKnownFixAllProviders.BatchFixer : provider.GetFixAllProvider();
                if (fixAllProvider is not null && fixAllProvider.GetSupportedFixAllScopes().Contains(FixAllScope.Document))
                {
                    var diagnostics = group.Select(plan => plan.Actionable.Diagnostic).ToImmutableArray();
                    var fixAllContext = new FixAllContext(
                        document,
                        hasAlternatives ? new ChosenActionCodeFixProvider(provider, group) : provider,
                        FixAllScope.Document,
                        action.EquivalenceKey,
                        diagnostics.Select(diagnostic => diagnostic.Id).Distinct(StringComparer.Ordinal),
                        new GroupDiagnosticProvider(document.Id, diagnostics),
                        cancellationToken);
                    var fixAllAction = await fixAllProvider.GetFixAsync(fixAllContext).ConfigureAwait(false);

                    // A fix-all provider may decline; the provider's own action for the first diagnostic still applies.
                    if (fixAllAction is not null)
                    {
                        action = fixAllAction;
                        fixedDiagnostics = group.Select(plan => plan.Actionable).ToImmutableArray();
                    }
                }

                operations = await action.GetOperationsAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                // The provider (or its fix-all provider) threw while computing the fix: only this group is skipped.
                return FixAttempt.Rejected(UnresolvedDiagnosticReason.FixProviderFailed, DescribeProviderFailure(provider, exception));
            }

            if (operations.IsDefaultOrEmpty)
            {
                return FixAttempt.Rejected(UnresolvedDiagnosticReason.NoApplicableCodeAction);
            }

            // Exactly one solution change is required (Roslyn allows at most one per action). Other operations are
            // host/UI notifications the engine never executes; anything that would need them to complete the fix is
            // still caught by the text-only validation and the compiler-error gate below.
            var applyChangesOperations = operations.OfType<ApplyChangesOperation>().ToList();
            if (applyChangesOperations.Count != 1)
            {
                return FixAttempt.Rejected(UnresolvedDiagnosticReason.FixRejectedUnsupportedChanges);
            }

            var (changedTexts, unsupported) = await GetChangedDocumentTextsAsync(solution, applyChangesOperations[0].ChangedSolution, cancellationToken).ConfigureAwait(false);
            if (unsupported is not null)
            {
                return FixAttempt.Rejected(UnresolvedDiagnosticReason.FixRejectedUnsupportedChanges, unsupported);
            }

            if (changedTexts.IsEmpty)
            {
                return FixAttempt.Rejected(UnresolvedDiagnosticReason.NoApplicableCodeAction);
            }

            var candidate = solution;
            foreach (var changedText in changedTexts)
            {
                candidate = candidate.WithDocumentText(changedText.Key, changedText.Value);
            }

            (candidate, var flavorIds) = WithLinkedDocuments(solution, candidate, changedTexts);
            var changedProjectIds = changedTexts.Select(changedText => changedText.Key.ProjectId).Concat(flavorIds.Select(id => id.ProjectId)).Distinct();
            if (await IntroducesCompilerErrorsAsync(solution, candidate, changedProjectIds, cancellationToken).ConfigureAwait(false))
            {
                return FixAttempt.Rejected(UnresolvedDiagnosticReason.FixRejectedIntroducesCompilerErrors);
            }

            return FixAttempt.Accepted(candidate, fixedDiagnostics);
        }

        /// <summary>
        /// Gives the other documents of each changed file (the same file compiled by another project or target framework)
        /// the file's new text, so the compiler-error gate checks every flavor and the solution stays consistent.
        /// </summary>
        private static (Solution Candidate, IReadOnlyList<DocumentId> FlavorIds) WithLinkedDocuments(
            Solution solution,
            Solution candidate,
            ImmutableArray<KeyValuePair<DocumentId, SourceText>> changedTexts)
        {
            var changedIds = changedTexts.Select(changedText => changedText.Key).ToHashSet();
            var flavorIds = new List<DocumentId>();
            foreach (var (documentId, text) in changedTexts)
            {
                var filePath = solution.GetDocument(documentId)?.FilePath;
                if (filePath is null)
                {
                    continue;
                }

                foreach (var flavorId in solution.GetDocumentIdsWithFilePath(filePath))
                {
                    if (changedIds.Add(flavorId))
                    {
                        candidate = candidate.WithDocumentText(flavorId, text);
                        flavorIds.Add(flavorId);
                    }
                }
            }

            return (candidate, flavorIds);
        }

        /// <summary>
        /// Returns the new texts of the documents changed by <paramref name="changedSolution" />, empty when nothing
        /// changed, or a default array when the change is more than document texts (documents, projects, references,
        /// options or document attributes added, removed or changed).
        /// </summary>
        private static async Task<(ImmutableArray<KeyValuePair<DocumentId, SourceText>> Texts, string? Unsupported)> GetChangedDocumentTextsAsync(
            Solution solution,
            Solution changedSolution,
            CancellationToken cancellationToken)
        {
            var solutionChanges = changedSolution.GetChanges(solution);
            if (solutionChanges.GetAddedProjects().Any()
                || solutionChanges.GetRemovedProjects().Any()
                || solutionChanges.GetAddedAnalyzerReferences().Any()
                || solutionChanges.GetRemovedAnalyzerReferences().Any())
            {
                return ([], "the fix adds or removes projects or analyzer references");
            }

            var changedTexts = ImmutableArray.CreateBuilder<KeyValuePair<DocumentId, SourceText>>();

            foreach (var projectChanges in solutionChanges.GetProjectChanges())
            {
                if (ChangesMoreThanDocumentTexts(projectChanges) is { } projectChange)
                {
                    return ([], $"the fix {projectChange} of project '{projectChanges.NewProject.Name}'");
                }

                foreach (var documentId in projectChanges.GetChangedDocuments())
                {
                    var oldDocument = projectChanges.OldProject.GetDocument(documentId)!;
                    var newDocument = projectChanges.NewProject.GetDocument(documentId)!;
                    if (!HaveSameAttributes(oldDocument, newDocument))
                    {
                        return ([], $"the fix renames or moves the document '{oldDocument.Name}'");
                    }

                    var oldText = await oldDocument.GetTextAsync(cancellationToken).ConfigureAwait(false);
                    var newText = await newDocument.GetTextAsync(cancellationToken).ConfigureAwait(false);
                    if (!oldText.ContentEquals(newText))
                    {
                        changedTexts.Add(new KeyValuePair<DocumentId, SourceText>(documentId, newText));
                    }
                }
            }

            return (changedTexts.ToImmutable(), null);
        }

        /// <summary>What a project change does beyond document texts (as "the fix ... of project"), or null.</summary>
        private static string? ChangesMoreThanDocumentTexts(ProjectChanges changes)
        {
            var oldProject = changes.OldProject;
            var newProject = changes.NewProject;

            if (changes.GetAddedDocuments().Any() || changes.GetRemovedDocuments().Any())
            {
                return "adds or removes documents";
            }

            if (changes.GetAddedAdditionalDocuments().Any() || changes.GetRemovedAdditionalDocuments().Any() || changes.GetChangedAdditionalDocuments().Any())
            {
                return "changes additional files";
            }

            if (changes.GetAddedAnalyzerConfigDocuments().Any() || changes.GetRemovedAnalyzerConfigDocuments().Any() || changes.GetChangedAnalyzerConfigDocuments().Any())
            {
                return "changes analyzer configuration files";
            }

            if (changes.GetAddedMetadataReferences().Any() || changes.GetRemovedMetadataReferences().Any()
                || changes.GetAddedProjectReferences().Any() || changes.GetRemovedProjectReferences().Any()
                || changes.GetAddedAnalyzerReferences().Any() || changes.GetRemovedAnalyzerReferences().Any())
            {
                return "changes the references";
            }

            return !Equals(oldProject.CompilationOptions, newProject.CompilationOptions)
                || !Equals(oldProject.ParseOptions, newProject.ParseOptions)
                || !string.Equals(oldProject.Name, newProject.Name, StringComparison.Ordinal)
                || !string.Equals(oldProject.AssemblyName, newProject.AssemblyName, StringComparison.Ordinal)
                || !string.Equals(oldProject.FilePath, newProject.FilePath, StringComparison.Ordinal)
                || !string.Equals(oldProject.OutputFilePath, newProject.OutputFilePath, StringComparison.Ordinal)
                || !string.Equals(oldProject.DefaultNamespace, newProject.DefaultNamespace, StringComparison.Ordinal)
                ? "changes the options"
                : null;
        }

        private static bool HaveSameAttributes(Document oldDocument, Document newDocument) =>
            string.Equals(oldDocument.Name, newDocument.Name, StringComparison.Ordinal)
            && string.Equals(oldDocument.FilePath, newDocument.FilePath, StringComparison.Ordinal)
            && oldDocument.SourceCodeKind == newDocument.SourceCodeKind;

        /// <summary>
        /// Safety gate: compares the Error-severity compiler diagnostics of every changed project before and after the
        /// change (see <see cref="CompilerErrors" />), so a fix that removes one error but adds a different one is still
        /// rejected. Passing the gate is the last acceptance check, so the errors of the candidate are kept as the
        /// errors of the next current solution.
        /// </summary>
        private async Task<bool> IntroducesCompilerErrorsAsync(Solution solution, Solution candidate, IEnumerable<ProjectId> projectIds, CancellationToken cancellationToken)
        {
            if (!ReferenceEquals(_errorSolution, solution))
            {
                _errorSolution = solution;
                _errors = new Dictionary<ProjectId, IReadOnlyList<Diagnostic>>();
            }

            var candidateErrors = new Dictionary<ProjectId, IReadOnlyList<Diagnostic>>();

            foreach (var projectId in projectIds)
            {
                var project = solution.GetProject(projectId)!;
                if (!_errors.TryGetValue(projectId, out var before))
                {
                    before = await CompilerErrors.GetAsync(project, cancellationToken).ConfigureAwait(false);
                    _errors.Add(projectId, before);
                }

                var candidateProject = candidate.GetProject(projectId)!;
                var after = await CompilerErrors.GetAsync(candidateProject, cancellationToken).ConfigureAwait(false);
                if (await CompilerErrors.FindFirstNewAsync(project, before, candidateProject, after, cancellationToken).ConfigureAwait(false) is not null)
                {
                    return true;
                }

                candidateErrors.Add(projectId, after);
            }

            _errorSolution = candidate;
            _errors = candidateErrors;

            return false;
        }

        private void RecordAppliedFixes(IEnumerable<ActionableDiagnostic> fixedDiagnostics, CodeFixProvider provider)
        {
            foreach (var fixedDiagnostic in fixedDiagnostics)
            {
                var key = (fixedDiagnostic.Diagnostic.Id, fixedDiagnostic.Category, provider);
                if (_appliedCounts.TryGetValue(key, out var count))
                {
                    _appliedCounts[key] = count + 1;
                }
                else
                {
                    _appliedOrder.Add(key);
                    _appliedCounts.Add(key, 1);
                }
            }
        }

        private DiagnosticCleanupResult CreateResult(Solution originalSolution, Solution solution, ImmutableArray<FixPlan> remainingPlans)
        {
            var appliedFixes = _appliedOrder.Select(key => new AppliedDiagnosticFix(key.DiagnosticId, key.Category, key.Provider.GetType().Name, _appliedCounts[key]));
            var unresolved = remainingPlans.Select(CreateUnresolved);

            lock (_analyzerFailures)
            {
                return new DiagnosticCleanupResult(originalSolution, solution, appliedFixes, unresolved, _analyzerFailures.ToList());
            }
        }

        /// <summary>
        /// A remaining diagnostic without usable fix keeps its planning reason, one of a rejected group gets the
        /// rejection reason, and any other one was still fixable when the pass limit was reached.
        /// </summary>
        private (UnresolvedDiagnosticReason Reason, string? Detail) GetUnresolvedReason(FixPlan plan)
        {
            if (plan.UnfixableReason.HasValue)
            {
                return (plan.UnfixableReason.Value, plan.UnfixableDetail);
            }

            return _rejectedGroups.TryGetValue(plan.GroupKey, out var rejection) ? rejection : (UnresolvedDiagnosticReason.NotConverged, null);
        }

        private UnresolvedRoslynDiagnostic CreateUnresolved(FixPlan plan)
        {
            var actionable = plan.Actionable;
            var diagnostic = actionable.Diagnostic;
            var lineSpan = diagnostic.Location.GetLineSpan();
            var (reason, detail) = GetUnresolvedReason(plan);

            return new UnresolvedRoslynDiagnostic(
                diagnostic.Id,
                actionable.Category,
                diagnostic.Severity,
                lineSpan.Path ?? string.Empty,
                lineSpan.StartLinePosition.Line + 1,
                lineSpan.StartLinePosition.Character + 1,
                diagnostic.GetMessage(CultureInfo.InvariantCulture),
                reason,
                detail ?? string.Empty);
        }
    }

    private sealed class ChosenActionCodeFixProvider : CodeFixProvider
    {
        private readonly CodeFixProvider _provider;
        private readonly Dictionary<Diagnostic, CodeAction> _chosenActions;

        public ChosenActionCodeFixProvider(CodeFixProvider provider, IEnumerable<FixPlan> plans)
        {
            _provider = provider;
            _chosenActions = plans.ToDictionary(plan => plan.Actionable.Diagnostic, plan => plan.Action!);
        }

        public override ImmutableArray<string> FixableDiagnosticIds => _provider.FixableDiagnosticIds;

        public override FixAllProvider? GetFixAllProvider() => null;

        public override Task RegisterCodeFixesAsync(CodeFixContext context)
        {
            foreach (var diagnostic in context.Diagnostics)
            {
                if (_chosenActions.TryGetValue(diagnostic, out var action))
                {
                    context.RegisterCodeFix(action, diagnostic);
                }
            }

            return Task.CompletedTask;
        }
    }

    private sealed record ActionableDiagnostic(Diagnostic Diagnostic, DiagnosticCleanupCategory Category, string? GateDetail);

    /// <summary>
    /// The fix chosen for one actionable diagnostic, or why there is none.
    /// </summary>
    private sealed class FixPlan
    {
        private FixPlan(ActionableDiagnostic actionable, CodeFixProvider? provider, CodeAction? action, bool hasEquivalentAlternatives, UnresolvedDiagnosticReason? unfixableReason, string? unfixableDetail)
        {
            Actionable = actionable;
            Provider = provider;
            Action = action;
            HasEquivalentAlternatives = hasEquivalentAlternatives;
            UnfixableReason = unfixableReason;
            UnfixableDetail = unfixableDetail;
        }

        public ActionableDiagnostic Actionable { get; }

        public CodeFixProvider? Provider { get; }

        public CodeAction? Action { get; }

        /// <summary>
        /// Gets a value indicating whether the provider also registered other actions with the equivalence key of
        /// <see cref="Action" />.
        /// </summary>
        public bool HasEquivalentAlternatives { get; }

        public UnresolvedDiagnosticReason? UnfixableReason { get; }

        public string? UnfixableDetail { get; }

        public bool IsFixable => Action is not null;

        public (CodeFixProvider? Provider, string? EquivalenceKey) GroupKey => (Provider, Action?.EquivalenceKey);

        public static FixPlan Fixable(ActionableDiagnostic actionable, CodeFixProvider provider, CodeAction action, bool hasEquivalentAlternatives) => new(actionable, provider, action, hasEquivalentAlternatives, null, null);

        public static FixPlan Unfixable(ActionableDiagnostic actionable, UnresolvedDiagnosticReason reason, string? detail = null) => new(actionable, null, null, false, reason, detail);
    }

    private sealed class FixAttempt
    {
        private FixAttempt(Solution? solution, ImmutableArray<ActionableDiagnostic> fixedDiagnostics, UnresolvedDiagnosticReason? rejection, string? rejectionDetail)
        {
            Solution = solution;
            FixedDiagnostics = fixedDiagnostics;
            Rejection = rejection;
            RejectionDetail = rejectionDetail;
        }

        public Solution? Solution { get; }

        public ImmutableArray<ActionableDiagnostic> FixedDiagnostics { get; }

        public UnresolvedDiagnosticReason? Rejection { get; }

        public string? RejectionDetail { get; }

        public static FixAttempt Accepted(Solution solution, ImmutableArray<ActionableDiagnostic> fixedDiagnostics) => new(solution, fixedDiagnostics, null, null);

        public static FixAttempt Rejected(UnresolvedDiagnosticReason reason, string? detail = null) => new(null, [], reason, detail);
    }

    /// <summary>
    /// Feeds exactly the diagnostics of one fix group to a fix-all provider.
    /// </summary>
    private sealed class GroupDiagnosticProvider : FixAllContext.DiagnosticProvider
    {
        private readonly DocumentId _documentId;
        private readonly ImmutableArray<Diagnostic> _diagnostics;

        public GroupDiagnosticProvider(DocumentId documentId, ImmutableArray<Diagnostic> diagnostics)
        {
            _documentId = documentId;
            _diagnostics = diagnostics;
        }

        public override Task<IEnumerable<Diagnostic>> GetDocumentDiagnosticsAsync(Document document, CancellationToken cancellationToken) =>
            Task.FromResult<IEnumerable<Diagnostic>>(document.Id == _documentId ? _diagnostics : ImmutableArray<Diagnostic>.Empty);

        public override Task<IEnumerable<Diagnostic>> GetProjectDiagnosticsAsync(Project project, CancellationToken cancellationToken) =>
            Task.FromResult<IEnumerable<Diagnostic>>(ImmutableArray<Diagnostic>.Empty);

        public override Task<IEnumerable<Diagnostic>> GetAllDiagnosticsAsync(Project project, CancellationToken cancellationToken) =>
            Task.FromResult<IEnumerable<Diagnostic>>(project.Id == _documentId.ProjectId ? _diagnostics : ImmutableArray<Diagnostic>.Empty);
    }

    /// <summary>
    /// The categories an analyzer can report, cached per analyzer instance, or why they could not be obtained.
    /// </summary>
    private sealed class AnalyzerCategories
    {
        public AnalyzerCategories(ImmutableArray<DiagnosticCleanupCategory> categories, string? failure)
        {
            Categories = categories;
            Failure = failure;
        }

        public ImmutableArray<DiagnosticCleanupCategory> Categories { get; }

        public string? Failure { get; }
    }
}

/// <summary>An actionable diagnostic of a document and whether cleanup can fix it.</summary>
/// <param name="Diagnostic">The diagnostic, as reported with the analyzer configuration overrides.</param>
/// <param name="Category">Its category.</param>
/// <param name="Fixable">Whether a fix exists and passes validation.</param>
/// <param name="Unresolved">Why it cannot be fixed; null when <paramref name="Fixable"/>.</param>
public sealed record AnalyzedDiagnostic(Diagnostic Diagnostic, DiagnosticCleanupCategory Category, bool Fixable, UnresolvedRoslynDiagnostic? Unresolved);
