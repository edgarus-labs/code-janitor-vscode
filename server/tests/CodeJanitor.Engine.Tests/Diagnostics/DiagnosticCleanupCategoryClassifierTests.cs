#nullable disable

using System.Linq;
using CodeJanitor.Engine.Diagnostics;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
using Xunit;

namespace CodeJanitor.Engine.Tests.Diagnostics;

/// <summary>
/// Unit tests for <see cref="DiagnosticCleanupCategoryClassifier" />. Built-in IDE descriptors all share the
/// "Style" category, so formatting and naming must be recognized from the analyzer family; other analyzers are
/// classified by their descriptor category; compiler diagnostics are never actionable.
/// </summary>
public sealed class DiagnosticCleanupCategoryClassifierTests
{
    [Theory]
    [InlineData("IDE0055", DiagnosticCleanupCategory.Formatting)]
    [InlineData("IDE1006", DiagnosticCleanupCategory.Naming)]
    [InlineData("IDE0008", DiagnosticCleanupCategory.CodeStyle)]
    public void Classify_BuiltInIdeAnalyzer_UsesAnalyzerFamily(string diagnosticId, DiagnosticCleanupCategory expected)
    {
        (DiagnosticAnalyzer analyzer, DiagnosticDescriptor descriptor) = FindHostAnalyzer(diagnosticId);

        Assert.Equal(expected, DiagnosticCleanupCategoryClassifier.Classify(analyzer, descriptor));
    }

    [Fact]
    public void Classify_BuiltInAnalyzerMirroringCompilerErrors_IsNeverActionable()
    {
        (DiagnosticAnalyzer analyzer, DiagnosticDescriptor descriptor) = FindHostAnalyzer("IDE1007");

        Assert.Null(DiagnosticCleanupCategoryClassifier.Classify(analyzer, descriptor));
    }

    [Theory]
    [InlineData("Compiler")]
    [InlineData("compiler")]
    public void Classify_CompilerCategoryDescriptor_IsNeverActionable(string category)
    {
        DiagnosticDescriptor descriptor = new DiagnosticDescriptor("CJT0102", "Title", "Message", category, DiagnosticSeverity.Error, isEnabledByDefault: true);

        Assert.Null(DiagnosticCleanupCategoryClassifier.Classify(new LegacyFieldAnalyzer(), descriptor));
    }

    [Theory]
    [InlineData("Naming", DiagnosticCleanupCategory.Naming)]
    [InlineData("StyleCop.CSharp.NamingRules", DiagnosticCleanupCategory.Naming)]
    [InlineData("Formatting", DiagnosticCleanupCategory.Formatting)]
    [InlineData("formatting", DiagnosticCleanupCategory.Formatting)]
    [InlineData("Style", DiagnosticCleanupCategory.CodeStyle)]
    [InlineData("StyleCop.CSharp.SpacingRules", DiagnosticCleanupCategory.AnalyzerFixes)]
    [InlineData("Performance", DiagnosticCleanupCategory.AnalyzerFixes)]
    public void Classify_CustomAnalyzer_UsesDescriptorCategory(string category, DiagnosticCleanupCategory expected)
    {
        DiagnosticDescriptor descriptor = new DiagnosticDescriptor("CJT0100", "Title", "Message", category, DiagnosticSeverity.Warning, isEnabledByDefault: true);

        Assert.Equal(expected, DiagnosticCleanupCategoryClassifier.Classify(new LegacyFieldAnalyzer(), descriptor));
    }

    [Fact]
    public void Classify_CompilerTaggedDescriptor_IsNeverActionableWhateverItsCategory()
    {
        DiagnosticDescriptor descriptor = new DiagnosticDescriptor(
            "CJT0101",
            "Title",
            "Message",
            "Naming",
            DiagnosticSeverity.Warning,
            isEnabledByDefault: true,
            customTags: WellKnownDiagnosticTags.Compiler);

        Assert.Null(DiagnosticCleanupCategoryClassifier.Classify(new LegacyFieldAnalyzer(), descriptor));
    }

    [Fact]
    public void Classify_MissingAnalyzerOrDescriptor_Throws()
    {
        DiagnosticDescriptor descriptor = new DiagnosticDescriptor("CJT0103", "Title", "Message", "Style", DiagnosticSeverity.Warning, isEnabledByDefault: true);

        Assert.Equal("analyzer", Assert.Throws<System.ArgumentNullException>(() => DiagnosticCleanupCategoryClassifier.Classify(null, descriptor)).ParamName);
        Assert.Equal("descriptor", Assert.Throws<System.ArgumentNullException>(() => DiagnosticCleanupCategoryClassifier.Classify(new LegacyFieldAnalyzer(), null)).ParamName);
    }

    private static (DiagnosticAnalyzer Analyzer, DiagnosticDescriptor Descriptor) FindHostAnalyzer(string diagnosticId)
    {
        DiagnosticAnalyzer analyzer = DiagnosticCleanupTestWorkspace.HostAnalyzers.First(candidate => candidate.SupportedDiagnostics.Any(d => d.Id == diagnosticId));

        return (analyzer, analyzer.SupportedDiagnostics.First(d => d.Id == diagnosticId));
    }
}
