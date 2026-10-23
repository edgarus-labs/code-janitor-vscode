using Microsoft.CodeAnalysis;

namespace CodeJanitor.Engine.Diagnostics;

/// <summary>
/// Decides, for one actionable diagnostic of the cleaned document, whether it may be fixed: null when it may, otherwise the
/// detail reported with <see cref="UnresolvedDiagnosticReason.NotApplied"/>.
/// </summary>
public delegate Task<string?> DiagnosticGate(Document document, Diagnostic diagnostic, CancellationToken cancellationToken);

/// <summary>Options of a single <see cref="DiagnosticCleanupEngine"/> run.</summary>
public sealed class DiagnosticCleanupOptions
{
    private const int DefaultMaxPasses = 50;

    private readonly HashSet<string>? _diagnosticIds;
    private readonly HashSet<string> _excludedIds;

    /// <summary>
    /// The options of the Fix Namespace command: Roslyn's "Namespace does not match folder structure" analyzer and code
    /// fix (IDE0130, <c>dotnet_style_namespace_match_folder</c>) and no other diagnostic.
    /// </summary>
    public static DiagnosticCleanupOptions NamespaceMatchFolder { get; } = new(
        Enum.GetValues<DiagnosticCleanupCategory>(),
        analyzerConfigOverrides: new Dictionary<string, string>
        {
            ["dotnet_style_namespace_match_folder"] = "true:suggestion",
            ["dotnet_diagnostic.IDE0130.severity"] = "suggestion",
        },
        diagnosticIds: ["IDE0130"]);

    /// <summary>Initializes a new instance of the <see cref="DiagnosticCleanupOptions"/> class.</summary>
    /// <param name="enabledCategories">The diagnostic families whose diagnostics may be fixed.</param>
    /// <param name="maxPasses">The maximum number of fixes applied (each followed by a re-analysis).</param>
    /// <param name="analyzerConfigOverrides">Entries (option name to value) applied to the cleaned document over its analyzer configuration.</param>
    /// <param name="diagnosticIds">The only diagnostic IDs that may be fixed, or null for every ID.</param>
    /// <param name="sortUsingsAfterFixes">Whether the using directives of the cleaned document are sorted (Roslyn's order) when a fix changed it.</param>
    /// <param name="excludedDiagnosticIds">Diagnostic IDs never fixed nor reported (rules the preview left out).</param>
    /// <param name="gate">Decides per diagnostic whether it may be fixed; null lets every diagnostic be fixed.</param>
    /// <param name="filter">Selects the diagnostics considered at all (neither fixed nor reported otherwise); null selects every one.</param>
    /// <param name="enforced">
    /// Selects the diagnostics that are actionable whatever severity they are reported with: the rules whose Roslyn analyzer
    /// reports at its descriptor's default severity although their option enforces them.
    /// </param>
    public DiagnosticCleanupOptions(
        IEnumerable<DiagnosticCleanupCategory> enabledCategories,
        int maxPasses = DefaultMaxPasses,
        IReadOnlyDictionary<string, string>? analyzerConfigOverrides = null,
        IEnumerable<string>? diagnosticIds = null,
        bool sortUsingsAfterFixes = false,
        IEnumerable<string>? excludedDiagnosticIds = null,
        DiagnosticGate? gate = null,
        Func<Diagnostic, bool>? filter = null,
        Func<Diagnostic, bool>? enforced = null)
    {
        ArgumentNullException.ThrowIfNull(enabledCategories);
        ArgumentOutOfRangeException.ThrowIfLessThan(maxPasses, 1);

        EnabledCategories = enabledCategories.Distinct().Order().ToList().AsReadOnly();
        MaxPasses = maxPasses;
        AnalyzerConfigOverrides = (analyzerConfigOverrides ?? new Dictionary<string, string>()).ToDictionary(entry => entry.Key, entry => entry.Value, StringComparer.Ordinal);
        _diagnosticIds = diagnosticIds is null ? null : new HashSet<string>(diagnosticIds, StringComparer.OrdinalIgnoreCase);
        _excludedIds = new HashSet<string>(excludedDiagnosticIds ?? [], StringComparer.OrdinalIgnoreCase);
        SortUsingsAfterFixes = sortUsingsAfterFixes;
        Gate = gate;
        Filter = filter;
        Enforced = enforced;
    }

    /// <summary>The diagnostic families whose diagnostics may be fixed, without duplicates.</summary>
    public IReadOnlyCollection<DiagnosticCleanupCategory> EnabledCategories { get; }

    /// <summary>The maximum number of fixes applied (each followed by a re-analysis).</summary>
    public int MaxPasses { get; }

    /// <summary>
    /// The entries (option name to value) applied to the cleaned document over its analyzer configuration: they win over
    /// every <c>.editorconfig</c> and global configuration. They never appear in <see cref="DiagnosticCleanupResult.ChangedSolution"/>.
    /// </summary>
    public IReadOnlyDictionary<string, string> AnalyzerConfigOverrides { get; }

    /// <summary>The only diagnostic IDs that may be fixed, or null when every diagnostic of an enabled category may be.</summary>
    public IReadOnlyCollection<string>? DiagnosticIds => _diagnosticIds;

    /// <summary>Whether the using directives of the cleaned document are sorted when a fix changed it.</summary>
    public bool SortUsingsAfterFixes { get; }

    /// <summary>Decides per diagnostic whether it may be fixed.</summary>
    public DiagnosticGate? Gate { get; }

    /// <summary>Selects the diagnostics considered at all; null selects every one.</summary>
    public Func<Diagnostic, bool>? Filter { get; }

    /// <summary>Selects the diagnostics actionable whatever severity they are reported with; null selects none.</summary>
    public Func<Diagnostic, bool>? Enforced { get; }

    /// <summary>Whether no category is enabled, in which case the engine performs no analysis at all.</summary>
    public bool IsEmpty => EnabledCategories.Count == 0;

    internal bool IsEnabled(DiagnosticCleanupCategory category) => EnabledCategories.Contains(category);

    internal bool Includes(string diagnosticId) => !_excludedIds.Contains(diagnosticId) && (_diagnosticIds is null || _diagnosticIds.Contains(diagnosticId));
}
