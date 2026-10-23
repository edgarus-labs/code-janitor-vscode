#nullable disable

using System;
using System.Collections.Generic;
using System.Linq;
using CodeJanitor.Engine.Diagnostics;
using Microsoft.CodeAnalysis;
using Xunit;

namespace CodeJanitor.Engine.Tests.Diagnostics;

/// <summary>
/// Unit tests for the public result and option types of the diagnostics cleanup: argument validation, the
/// normalization the host relies on, and the log lines produced by <c>ToString</c>.
/// </summary>
public sealed class DiagnosticCleanupModelTests
{
    [Fact]
    public void Options_MissingCategoriesOrNoPass_AreRejected()
    {
        Assert.Equal("enabledCategories", Assert.Throws<ArgumentNullException>(() => new DiagnosticCleanupOptions(null)).ParamName);
        Assert.Equal("maxPasses", Assert.Throws<ArgumentOutOfRangeException>(() => new DiagnosticCleanupOptions(new[] { DiagnosticCleanupCategory.Naming }, 0)).ParamName);
        Assert.Equal("maxPasses", Assert.Throws<ArgumentOutOfRangeException>(() => new DiagnosticCleanupOptions(new[] { DiagnosticCleanupCategory.Naming }, -1)).ParamName);
    }

    [Fact]
    public void Options_NormalizeCategoriesAndCopyTheOverrides()
    {
        Dictionary<string, string> overrides = new Dictionary<string, string> { ["end_of_line"] = "lf" };

        DiagnosticCleanupOptions options = new DiagnosticCleanupOptions(
            new[] { DiagnosticCleanupCategory.Naming, DiagnosticCleanupCategory.Formatting, DiagnosticCleanupCategory.Naming },
            1,
            overrides);
        overrides["end_of_line"] = "crlf";

        Assert.Equal(new[] { DiagnosticCleanupCategory.Formatting, DiagnosticCleanupCategory.Naming }.OrderBy(category => category).ToArray(), options.EnabledCategories.ToArray());
        Assert.Equal(1, options.MaxPasses);
        Assert.False(options.IsEmpty);
        Assert.Equal("lf", options.AnalyzerConfigOverrides["end_of_line"]);
        Assert.Empty(new DiagnosticCleanupOptions(Array.Empty<DiagnosticCleanupCategory>()).AnalyzerConfigOverrides);
        Assert.True(new DiagnosticCleanupOptions(Array.Empty<DiagnosticCleanupCategory>()).IsEmpty);
    }

    [Theory]
    [InlineData(UnresolvedDiagnosticReason.NoCodeFixProvider, true)]
    [InlineData(UnresolvedDiagnosticReason.NoApplicableCodeAction, true)]
    [InlineData(UnresolvedDiagnosticReason.FixRejectedIntroducesCompilerErrors, false)]
    [InlineData(UnresolvedDiagnosticReason.FixRejectedUnsupportedChanges, false)]
    [InlineData(UnresolvedDiagnosticReason.NotConverged, false)]
    [InlineData(UnresolvedDiagnosticReason.FixProviderFailed, false)]
    [InlineData(UnresolvedDiagnosticReason.NotApplied, true)]
    public void Result_IsComplete_OnlyWhenNoUnresolvedDiagnosticBlocks(UnresolvedDiagnosticReason reason, bool expectComplete)
    {
        using AdhocWorkspace workspace = new AdhocWorkspace();
        UnresolvedRoslynDiagnostic unresolved = new UnresolvedRoslynDiagnostic("CJT0300", DiagnosticCleanupCategory.CodeStyle, DiagnosticSeverity.Warning, "A.cs", 1, 1, "Message", reason);

        DiagnosticCleanupResult result = new DiagnosticCleanupResult(
            workspace.CurrentSolution,
            workspace.CurrentSolution,
            Array.Empty<AppliedDiagnosticFix>(),
            new[] { unresolved });

        Assert.Equal(expectComplete, result.IsComplete);
        Assert.False(result.HasChanges);
    }

    [Fact]
    public void UnresolvedDiagnostic_FormatsALogLine()
    {
        UnresolvedRoslynDiagnostic full = new UnresolvedRoslynDiagnostic(
            "IDE0055",
            DiagnosticCleanupCategory.Formatting,
            DiagnosticSeverity.Warning,
            @"C:\repo\Program.cs",
            12,
            5,
            "Fix formatting",
            UnresolvedDiagnosticReason.FixRejectedIntroducesCompilerErrors);

        Assert.Equal(string.Empty, full.Detail);
        Assert.Equal(@"C:\repo\Program.cs(12): Warning IDE0055 [Formatting] FixRejectedIntroducesCompilerErrors: Fix formatting", full.ToString());
        UnresolvedRoslynDiagnostic failed = new UnresolvedRoslynDiagnostic(
            "CJT0301",
            DiagnosticCleanupCategory.AnalyzerFixes,
            DiagnosticSeverity.Warning,
            "A.cs",
            3,
            1,
            "Message",
            UnresolvedDiagnosticReason.FixProviderFailed,
            "BrokenFixer: Boom");
        Assert.Equal("A.cs(3): Warning CJT0301 [AnalyzerFixes] FixProviderFailed: Message (BrokenFixer: Boom)", failed.ToString());
    }

    [Fact]
    public void AppliedDiagnosticFix_FormatsALogLine()
    {
        AppliedDiagnosticFix fix = new AppliedDiagnosticFix("IDE1006", DiagnosticCleanupCategory.Naming, "NamingStyleCodeFixProvider", 3);

        Assert.Equal("NamingStyleCodeFixProvider", fix.ProviderName);
        Assert.Equal("IDE1006 (Naming) fixed 3x by NamingStyleCodeFixProvider", fix.ToString());
    }
}
