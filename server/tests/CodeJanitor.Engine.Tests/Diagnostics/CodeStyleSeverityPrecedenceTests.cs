#nullable disable

using System.Collections.Immutable;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
using Xunit;

namespace CodeJanitor.Engine.Tests.Diagnostics;

/// <summary>
/// Characterizes how Roslyn combines the severity sources of a built-in code-style rule (IDE0011,
/// <c>csharp_prefer_braces</c>, category Style), which <see cref="CodeJanitor.Engine.Settings.EffectiveSettings" />
/// mirrors: a <c>:none</c> option suffix stops the analyzer whatever else is configured; otherwise
/// <c>dotnet_diagnostic.&lt;id&gt;.severity</c> wins, then <c>dotnet_analyzer_diagnostic.category-&lt;category&gt;.severity</c>,
/// then <c>dotnet_analyzer_diagnostic.severity</c>, and only then the option's severity suffix.
/// </summary>
public sealed class CodeStyleSeverityPrecedenceTests
{
    [Theory]
    [InlineData("csharp_prefer_braces = true:warning\ndotnet_diagnostic.IDE0011.severity = none", null)]
    [InlineData("csharp_prefer_braces = true:silent\ndotnet_diagnostic.IDE0011.severity = warning", DiagnosticSeverity.Warning)]
    [InlineData("csharp_prefer_braces = true:silent\ndotnet_analyzer_diagnostic.category-Style.severity = warning", DiagnosticSeverity.Warning)]
    [InlineData("csharp_prefer_braces = true:warning\ndotnet_analyzer_diagnostic.category-Style.severity = none", null)]
    [InlineData("csharp_prefer_braces = true:silent\ndotnet_analyzer_diagnostic.severity = warning", DiagnosticSeverity.Warning)]
    [InlineData("csharp_prefer_braces = true\ndotnet_analyzer_diagnostic.category-Style.severity = warning", DiagnosticSeverity.Warning)]
    [InlineData("csharp_prefer_braces = true\ndotnet_analyzer_diagnostic.category-Style.severity = none", null)]
    [InlineData("dotnet_analyzer_diagnostic.category-style.severity = warning", DiagnosticSeverity.Warning)]
    [InlineData("dotnet_analyzer_diagnostic.category-Style.severity = suggestion\ndotnet_analyzer_diagnostic.severity = none", DiagnosticSeverity.Info)]
    [InlineData("csharp_prefer_braces = true:none\ndotnet_diagnostic.IDE0011.severity = warning", null)]
    [InlineData("csharp_prefer_braces = true:none\ndotnet_analyzer_diagnostic.category-Style.severity = warning", null)]
    [InlineData("csharp_prefer_braces = true:none\ndotnet_analyzer_diagnostic.severity = warning", null)]
    public async Task EffectiveSeverity_FollowsRoslynPrecedence(string editorConfig, DiagnosticSeverity? expected)
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace();
        workspace.AddEditorConfig("precedence", "root = true\n\n[*.cs]\n" + editorConfig + "\n");
        DocumentId documentId = workspace.AddDocument(
            "precedence/Probe.cs",
            "class Probe\n{\n    int Get(bool open)\n    {\n        if (open)\n            return 1;\n        return 0;\n    }\n}\n");
        Project project = workspace.CreateSolution().GetDocument(documentId).Project;
        Compilation compilation = await project.GetCompilationAsync(CancellationToken.None);
        ImmutableArray<DiagnosticAnalyzer> analyzers = DiagnosticCleanupTestWorkspace.HostAnalyzers
            .Where(analyzer => analyzer.SupportedDiagnostics.Any(descriptor => descriptor.Id == "IDE0011"))
            .ToImmutableArray();

        ImmutableArray<Diagnostic> diagnostics = await compilation
            .WithAnalyzers(analyzers, project.AnalyzerOptions)
            .GetAnalyzerDiagnosticsAsync(CancellationToken.None);

        Assert.Equal(expected, diagnostics.Where(diagnostic => diagnostic.Id == "IDE0011").Select(diagnostic => (DiagnosticSeverity?)diagnostic.Severity).SingleOrDefault());
    }

}
