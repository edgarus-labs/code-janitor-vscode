using CodeJanitor.Engine.Contracts;
using CodeJanitor.Engine.Settings;
using Microsoft.CodeAnalysis;

namespace CodeJanitor.Engine.Pipeline;

/// <summary>What one run of a rule-reporting step may do.</summary>
/// <param name="ExcludedRules">Rule ids left out by the preview.</param>
/// <param name="OnlyRule">The only rule to apply, or null for every rule.</param>
/// <param name="OnlyLine">With <paramref name="OnlyRule"/>: only its occurrence on this 0-based line.</param>
/// <param name="ChangedLines">With <c>onlyChangedLines</c>: the 0-based changed lines of the document; null means every line.</param>
/// <param name="KeepOtherFiles">On save and in a partial cleanup: renames stay in the document, whatever <c>renamePublicSymbolsAcrossWorkspace</c> says.</param>
internal sealed record StepRunOptions(IReadOnlySet<string> ExcludedRules, string? OnlyRule = null, int? OnlyLine = null, IReadOnlySet<int>? ChangedLines = null, bool KeepOtherFiles = false)
{
    public static readonly StepRunOptions All = new(new HashSet<string>(StringComparer.OrdinalIgnoreCase));
}

/// <summary>What a rule-reporting step did.</summary>
/// <param name="Solution">The solution after the step.</param>
/// <param name="Rules">Per rule: how many places it changed and whether it was included.</param>
/// <param name="Unresolved">The enforced diagnostics the step could not fix.</param>
/// <param name="Issues">Messages for the output channel.</param>
internal sealed record StepRun(Solution Solution, IReadOnlyList<RuleOutcome> Rules, IReadOnlyList<UnresolvedDiagnostic> Unresolved, IReadOnlyList<string> Issues)
{
    /// <summary>What the step could not do because a part of it crashed; shown with the issues, but a failure of the cleanup.</summary>
    public IReadOnlyList<string> Failures { get; init; } = [];
}

/// <summary>
/// A step made of several rules (the Roslyn diagnostics), which reports per rule and honours exclusions, single rules and
/// changed lines itself.
/// </summary>
internal interface IRuleReportingStep : ICleanupStep
{
    /// <summary>Whether the step applies the rule <paramref name="ruleId"/>, so <c>fixRule</c> runs it for that id.</summary>
    bool OwnsRule(string ruleId);

    Task<StepRun> RunAsync(Document document, EffectiveSettings settings, StepRunOptions options, CancellationToken cancellationToken);
}

/// <summary>A step that reports the diagnostics it would fix (and those it cannot) for the Problems panel.</summary>
internal interface IAnalyzingStep
{
    Task<IReadOnlyList<EngineDiagnostic>> AnalyzeAsync(Document document, EffectiveSettings settings, CancellationToken cancellationToken);
}

/// <summary>A step that also reports issues (violations it cannot fix) for the output channel.</summary>
internal interface IIssueReportingStep : ICleanupStep
{
    /// <summary>Applies the step like <see cref="ICleanupStep.ApplyAsync"/> and returns what it reports.</summary>
    Task<(Solution Solution, IReadOnlyList<string> Issues)> ApplyWithIssuesAsync(Document document, IEffectiveSettings settings, CancellationToken cancellationToken);
}

/// <summary>A step that creates files, which on save and in a partial cleanup only reports what it would create.</summary>
internal interface IFileCreatingStep : ICleanupStep
{
    /// <summary>What the step would create, reported as not done because of <paramref name="reason"/>; the document is left as it is.</summary>
    Task<IReadOnlyList<string>> ReportWithoutCreatingAsync(Document document, IEffectiveSettings settings, string reason, CancellationToken cancellationToken);
}
