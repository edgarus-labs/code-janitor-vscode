using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;

namespace CodeJanitor.Engine.Diagnostics;

/// <summary>
/// Maps a diagnostic to the <see cref="DiagnosticCleanupCategory" /> whose Janitor setting governs it.
/// </summary>
/// <remarks>
/// <para>
/// The built-in IDE analyzers give (nearly) every descriptor the same "Style" category, and neither help links nor
/// custom tags tell formatting or naming rules apart. What does tell them apart is the analyzer family: the formatting
/// rule is implemented by analyzers deriving from <c>AbstractFormattingAnalyzer</c>, the naming rule by analyzers
/// deriving from <c>NamingStyleDiagnosticAnalyzerBase&lt;T&gt;</c>, and the built-in code style rules by analyzers
/// deriving from <c>AbstractBuiltInCodeStyleDiagnosticAnalyzer</c>. Those Roslyn base types are internal, so they are
/// matched by simple type name (case-insensitively, generic arity ignored). They identify whole analyzer families, not
/// individual rules: the classification automatically covers whatever rules the host's Roslyn version ships, and no
/// diagnostic ID list exists anywhere. Third-party analyzers are classified by their descriptor category.
/// </para>
/// <para>
/// Compiler diagnostics are never actionable: neither descriptors tagged <see cref="WellKnownDiagnosticTags.Compiler" />
/// nor descriptors whose category is "Compiler". Some IDE analyzers mirror compiler checks under that category without
/// the tag, e.g. the unbound-identifier analyzer that feeds the add-import/generate-type/spell-check fixes; fixing such
/// diagnostics means repairing broken code (generating type stubs, guessing renames), which is not a cleanup.
/// </para>
/// </remarks>
internal static class DiagnosticCleanupCategoryClassifier
{
    private const string FormattingAnalyzerFamily = "AbstractFormattingAnalyzer";
    private const string NamingAnalyzerFamily = "NamingStyleDiagnosticAnalyzerBase";
    private const string CodeStyleAnalyzerFamily = "AbstractBuiltInCodeStyleDiagnosticAnalyzer";

    private const string FormattingCategoryMarker = "Formatting";
    private const string NamingCategoryMarker = "Naming";
    private const string CodeStyleCategory = "Style";
    private const string CompilerCategory = "Compiler";

    /// <summary>
    /// Classifies a diagnostic described by <paramref name="descriptor" /> and reported by <paramref name="analyzer" />.
    /// </summary>
    /// <param name="analyzer">The analyzer that reports the diagnostic.</param>
    /// <param name="descriptor">The descriptor of the diagnostic.</param>
    /// <returns>The category, or <c>null</c> for compiler diagnostics, which are never actionable.</returns>
    public static DiagnosticCleanupCategory? Classify(DiagnosticAnalyzer analyzer, DiagnosticDescriptor descriptor)
    {
        ArgumentNullException.ThrowIfNull(analyzer);
        ArgumentNullException.ThrowIfNull(descriptor);

        var category = descriptor.Category ?? string.Empty;

        if (descriptor.CustomTags.Contains(WellKnownDiagnosticTags.Compiler, StringComparer.Ordinal)
            || string.Equals(category, CompilerCategory, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        if (IsInFamily(analyzer, FormattingAnalyzerFamily) || ContainsIgnoreCase(category, FormattingCategoryMarker))
        {
            return DiagnosticCleanupCategory.Formatting;
        }

        if (IsInFamily(analyzer, NamingAnalyzerFamily) || ContainsIgnoreCase(category, NamingCategoryMarker))
        {
            return DiagnosticCleanupCategory.Naming;
        }

        if (string.Equals(category, CodeStyleCategory, StringComparison.OrdinalIgnoreCase) || IsInFamily(analyzer, CodeStyleAnalyzerFamily))
        {
            return DiagnosticCleanupCategory.CodeStyle;
        }

        return DiagnosticCleanupCategory.AnalyzerFixes;
    }

    private static bool IsInFamily(DiagnosticAnalyzer analyzer, string familyTypeName)
    {
        for (Type? type = analyzer.GetType(); type is not null; type = type.BaseType)
        {
            if (string.Equals(WithoutGenericArity(type.Name), familyTypeName, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    private static string WithoutGenericArity(string typeName)
    {
        var aritySeparator = typeName.IndexOf('`');

        return aritySeparator < 0 ? typeName : typeName[..aritySeparator];
    }

    private static bool ContainsIgnoreCase(string value, string marker) =>
        value.Contains(marker, StringComparison.OrdinalIgnoreCase);
}
