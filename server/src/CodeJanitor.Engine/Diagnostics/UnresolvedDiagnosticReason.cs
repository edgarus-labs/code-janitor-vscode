namespace CodeJanitor.Engine.Diagnostics;

/// <summary>
/// Why an actionable diagnostic is still present after the diagnostic-driven cleanup.
/// </summary>
public enum UnresolvedDiagnosticReason
{
    /// <summary>
    /// No code fix provider handles the diagnostic. It is reported and the code is never modified for it.
    /// </summary>
    NoCodeFixProvider,

    /// <summary>
    /// The providers offered nothing usable: no action, only actions with nested choices, or an action without
    /// any effect.
    /// </summary>
    NoApplicableCodeAction,

    /// <summary>
    /// The fix was rejected because it added a compiler error to a changed project (even if it removed another).
    /// </summary>
    FixRejectedIntroducesCompilerErrors,

    /// <summary>
    /// The fix was rejected because it did more than change document texts (e.g. added or removed documents,
    /// projects or references) or did not consist of exactly one solution change. Other operations a fix returns next
    /// to its solution change, such as host notifications, do not cause a rejection; the engine never executes them
    /// (see <see cref="DiagnosticCleanupResult.PostApplyOperations" />).
    /// </summary>
    FixRejectedUnsupportedChanges,

    /// <summary>
    /// The diagnostic was still present when the maximum number of passes was reached.
    /// </summary>
    NotConverged,

    /// <summary>
    /// A code fix provider threw (a provider bug): either while offering fixes, when no other provider of the
    /// diagnostic offered one, or while computing the chosen fix. Only that fix is skipped; the other fixes of the file
    /// still apply. <see cref="UnresolvedRoslynDiagnostic.Detail" /> names the provider and its exception message.
    /// </summary>
    FixProviderFailed,

    /// <summary>
    /// The fix is not made by the settings: a rename that may reach other files without
    /// <c>renamePublicSymbolsAcrossWorkspace</c>, or a rename while only changed lines are cleaned.
    /// <see cref="UnresolvedRoslynDiagnostic.Detail" /> tells why.
    /// </summary>
    NotApplied,
}
