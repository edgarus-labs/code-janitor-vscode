namespace CodeJanitor.Engine.Diagnostics;

/// <summary>
/// Families of Roslyn diagnostics that the diagnostic-driven cleanup can fix. Each family is opted into
/// separately; within an enabled family, .editorconfig decides which rules are active and how they are configured.
/// </summary>
public enum DiagnosticCleanupCategory
{
    /// <summary>
    /// Whitespace and layout rules of the IDE formatting analyzer (indentation, spacing, new lines, braces).
    /// </summary>
    Formatting,

    /// <summary>
    /// Naming rules configured through <c>dotnet_naming_rule</c>, <c>dotnet_naming_symbols</c> and
    /// <c>dotnet_naming_style</c>.
    /// </summary>
    Naming,

    /// <summary>
    /// Other code style rules, e.g. <c>csharp_style_*</c> and <c>dotnet_style_*</c> preferences.
    /// </summary>
    CodeStyle,

    /// <summary>
    /// Any other analyzer diagnostic with an existing code fix, e.g. code quality rules or third-party analyzers.
    /// </summary>
    AnalyzerFixes,
}
