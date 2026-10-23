using Microsoft.CodeAnalysis;

namespace CodeJanitor.Engine.Diagnostics;

/// <summary>Diagnostics of one ID fixed by one code fix provider during a diagnostic cleanup.</summary>
/// <param name="DiagnosticId">The fixed diagnostic ID.</param>
/// <param name="Category">The category of the fixed diagnostics.</param>
/// <param name="ProviderName">The name of the code fix provider that fixed them.</param>
/// <param name="Count">The number of diagnostics targeted by the applied fixes.</param>
public sealed record AppliedDiagnosticFix(string DiagnosticId, DiagnosticCleanupCategory Category, string ProviderName, int Count)
{
    /// <inheritdoc/>
    public override string ToString() => $"{DiagnosticId} ({Category}) fixed {Count}x by {ProviderName}";
}

/// <summary>An actionable diagnostic still present after a diagnostic cleanup.</summary>
/// <param name="DiagnosticId">The diagnostic ID.</param>
/// <param name="Category">The category of the diagnostic.</param>
/// <param name="Severity">The reported (effective) severity.</param>
/// <param name="FilePath">The path of the file containing the diagnostic.</param>
/// <param name="Line">The 1-based line of the diagnostic.</param>
/// <param name="Column">The 1-based column of the diagnostic.</param>
/// <param name="Message">The diagnostic message.</param>
/// <param name="Reason">Why the diagnostic was not fixed.</param>
/// <param name="Detail">Details of the reason (e.g. the failing provider and its exception message); empty when none.</param>
public sealed record UnresolvedRoslynDiagnostic(
    string DiagnosticId,
    DiagnosticCleanupCategory Category,
    DiagnosticSeverity Severity,
    string FilePath,
    int Line,
    int Column,
    string Message,
    UnresolvedDiagnosticReason Reason,
    string Detail = "")
{
    /// <inheritdoc/>
    public override string ToString() => $"{FilePath}({Line}): {Severity} {DiagnosticId} [{Category}] {Reason}: {Message}" + (Detail.Length == 0 ? string.Empty : $" ({Detail})");
}

/// <summary>Outcome of a <see cref="DiagnosticCleanupEngine"/> run.</summary>
public sealed class DiagnosticCleanupResult
{
    /// <summary>Initializes a new instance of the <see cref="DiagnosticCleanupResult"/> class.</summary>
    public DiagnosticCleanupResult(Solution originalSolution, Solution changedSolution, IEnumerable<AppliedDiagnosticFix> appliedFixes, IEnumerable<UnresolvedRoslynDiagnostic> unresolved, IEnumerable<string>? analyzerFailures = null)
    {
        OriginalSolution = originalSolution;
        ChangedSolution = changedSolution;
        AppliedFixes = appliedFixes.ToList();
        Unresolved = unresolved.ToList();
        AnalyzerFailures = analyzerFailures?.ToList() ?? [];
    }

    /// <summary>The solution the cleanup started from.</summary>
    public Solution OriginalSolution { get; }

    /// <summary>The solution with all accepted fixes; compared to <see cref="OriginalSolution"/> only document texts differ.</summary>
    public Solution ChangedSolution { get; }

    /// <summary>Whether at least one fix was accepted.</summary>
    public bool HasChanges => !ReferenceEquals(OriginalSolution, ChangedSolution);

    /// <summary>The applied fixes, in order of first application.</summary>
    public IReadOnlyList<AppliedDiagnosticFix> AppliedFixes { get; }

    /// <summary>The actionable diagnostics left in the cleaned document.</summary>
    public IReadOnlyList<UnresolvedRoslynDiagnostic> Unresolved { get; }

    /// <summary>Analyzers that threw (while analyzing, or while listing their diagnostics) and so found nothing: a file they would have flagged looks clean.</summary>
    public IReadOnlyList<string> AnalyzerFailures { get; }

    /// <summary>
    /// Whether the cleanup finished its work: false when a fix was rejected, a provider failed, or the cleanup did not
    /// converge. Diagnostics without a usable fix are reported but do not make it incomplete.
    /// </summary>
    public bool IsComplete => Unresolved.All(diagnostic => diagnostic.Reason is not (UnresolvedDiagnosticReason.FixRejectedIntroducesCompilerErrors
        or UnresolvedDiagnosticReason.FixRejectedUnsupportedChanges
        or UnresolvedDiagnosticReason.NotConverged
        or UnresolvedDiagnosticReason.FixProviderFailed));
}
