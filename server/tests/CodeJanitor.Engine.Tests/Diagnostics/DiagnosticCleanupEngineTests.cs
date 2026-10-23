#nullable disable
#pragma warning disable RS1010, RS1025, RS1026, RS2008 // Test analyzers and fixers: no release tracking, minimal registration on purpose.

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using CodeJanitor.Engine.Diagnostics;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CodeActions;
using Microsoft.CodeAnalysis.CodeFixes;
using Microsoft.CodeAnalysis.Diagnostics;
using Xunit;

namespace CodeJanitor.Engine.Tests.Diagnostics;

/// <summary>
/// Behavioral tests for <see cref="DiagnosticCleanupEngine" />: .editorconfig + enabled categories decide which
/// Roslyn diagnostics are fixed, and the fixes come from the existing analyzers/CodeFixProviders (the built-in IDE
/// ones from Microsoft.CodeAnalysis.CSharp.Features, hosted the way Visual Studio hosts them). Every assertion is on
/// the exact resulting text, not merely on diagnostics disappearing.
/// </summary>
public sealed class DiagnosticCleanupEngineTests
{
    private static readonly CodeFixProviderCatalog Catalog = new CodeFixProviderCatalog();

    private static readonly string[] UseBraceOnSameLine =
    {
        "end_of_line = lf",
        "csharp_new_line_before_open_brace = none",
        "dotnet_diagnostic.IDE0055.severity = warning",
    };

    [Fact]
    public async Task CleanupAsync_NamingRuleWithPrefix_RenamesPrivateFieldsAndTheirReferences()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace();
        workspace.AddEditorConfig(string.Empty, EditorConfig(PrivateFieldsPrefixRule("m_", "pascal_case")));
        DocumentId documentId = workspace.AddDocument("Counter.cs", Lines(
            "class Counter",
            "{",
            "    private int count;",
            "    private int total;",
            "",
            "    public int Sum()",
            "    {",
            "        return count + total;",
            "    }",
            "}"));

        DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, DiagnosticCleanupCategory.Naming);

        Assert.Equal(Lines(
                "class Counter",
                "{",
                "    private int m_Count;",
                "    private int m_Total;",
                "",
                "    public int Sum()",
                "    {",
                "        return m_Count + m_Total;",
                "    }",
                "}"), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
        Assert.True(result.HasChanges);
        Assert.True(result.IsComplete);
        Assert.Empty(result.Unresolved);
        AppliedDiagnosticFix applied = result.AppliedFixes.Single();
        Assert.Equal("IDE1006", applied.DiagnosticId);
        Assert.Equal(DiagnosticCleanupCategory.Naming, applied.Category);
        Assert.Equal(2, applied.Count);
    }

    [Fact]
    public async Task CleanupAsync_DifferentNamingStyle_UsesConfiguredPrefixCapitalizationAndModifiers()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace();
        workspace.AddEditorConfig(string.Empty, EditorConfig(
            "dotnet_naming_rule.private_static_fields_rule.symbols = private_static_fields",
            "dotnet_naming_rule.private_static_fields_rule.style = s_prefix_camel",
            "dotnet_naming_rule.private_static_fields_rule.severity = warning",
            "dotnet_naming_symbols.private_static_fields.applicable_kinds = field",
            "dotnet_naming_symbols.private_static_fields.applicable_accessibilities = private",
            "dotnet_naming_symbols.private_static_fields.required_modifiers = static",
            "dotnet_naming_style.s_prefix_camel.required_prefix = s_",
            "dotnet_naming_style.s_prefix_camel.capitalization = camel_case"));
        DocumentId documentId = workspace.AddDocument("Registry.cs", Lines(
            "class Registry",
            "{",
            "    private static int Instances;",
            "    private int count;",
            "",
            "    public int Next()",
            "    {",
            "        return ++Instances + count;",
            "    }",
            "}"));

        DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, DiagnosticCleanupCategory.Naming);

        Assert.Equal(Lines(
                "class Registry",
                "{",
                "    private static int s_instances;",
                "    private int count;",
                "",
                "    public int Next()",
                "    {",
                "        return ++s_instances + count;",
                "    }",
                "}"), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
        Assert.True(result.IsComplete);
    }

    [Fact]
    public async Task CleanupAsync_SymbolSpecificationAccessibility_LeavesUnmatchedPublicFieldUnchanged()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace();
        workspace.AddEditorConfig(string.Empty, EditorConfig(PrivateFieldsPrefixRule("m_", "pascal_case")));
        DocumentId documentId = workspace.AddDocument("Account.cs", Lines(
            "class Account",
            "{",
            "    public int balance;",
            "    private int limit;",
            "",
            "    public int Available()",
            "    {",
            "        return balance - limit;",
            "    }",
            "}"));

        DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, DiagnosticCleanupCategory.Naming);

        Assert.Equal(Lines(
                "class Account",
                "{",
                "    public int balance;",
                "    private int m_Limit;",
                "",
                "    public int Available()",
                "    {",
                "        return balance - m_Limit;",
                "    }",
                "}"), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
    }

    [Fact]
    public async Task CleanupAsync_RenameFix_UpdatesReferencesInOtherDocumentsButTargetsOnlyTheCleanedDocument()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace();
        workspace.AddEditorConfig(string.Empty, EditorConfig(PrivateFieldsPrefixRule("m_", "pascal_case")));
        DocumentId cleanedId = workspace.AddDocument("Gauge.cs", Lines(
            "partial class Gauge",
            "{",
            "    private int level;",
            "}"));
        DocumentId otherId = workspace.AddDocument("Gauge.Read.cs", Lines(
            "partial class Gauge",
            "{",
            "    public int Read()",
            "    {",
            "        return level;",
            "    }",
            "}",
            "",
            "class Needle",
            "{",
            "    private int angle;",
            "",
            "    public int Angle()",
            "    {",
            "        return angle;",
            "    }",
            "}"));

        DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), cleanedId, DiagnosticCleanupCategory.Naming);

        Assert.Equal(Lines(
                "partial class Gauge",
                "{",
                "    private int m_Level;",
                "}"), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, cleanedId));
        Assert.Equal(Lines(
                "partial class Gauge",
                "{",
                "    public int Read()",
                "    {",
                "        return m_Level;",
                "    }",
                "}",
                "",
                "class Needle",
                "{",
                "    private int angle;",
                "",
                "    public int Angle()",
                "    {",
                "        return angle;",
                "    }",
                "}"), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, otherId));
        Assert.True(result.IsComplete);
    }

    [Fact]
    public async Task CleanupAsync_FormattingRuleEnabled_AppliesConfiguredBracePlacement()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace();
        workspace.AddEditorConfig(string.Empty, EditorConfig(UseBraceOnSameLine));
        DocumentId documentId = workspace.AddDocument("Widget.cs", Lines(
            "class Widget",
            "{",
            "    void Draw()",
            "    {",
            "    }",
            "}"));

        DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, DiagnosticCleanupCategory.Formatting);

        Assert.Equal(Lines(
                "class Widget {",
                "    void Draw() {",
                "    }",
                "}"), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
        Assert.True(result.IsComplete);
        Assert.Equal(DiagnosticCleanupCategory.Formatting, result.AppliedFixes.Single().Category);
    }

    [Fact]
    public async Task CleanupAsync_FixOnlyMovingCodeWithAnExistingCompilerError_IsApplied()
    {
        // The existing CS0246 moves to another line; the gate still matches it by its unchanged message.
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace();
        workspace.AddEditorConfig(string.Empty, EditorConfig(UseBraceOnSameLine));
        DocumentId documentId = workspace.AddDocument("Widget.cs", Lines(
            "class Widget",
            "{",
            "    void Draw()",
            "    {",
            "        MissingType value = null;",
            "    }",
            "}"));

        DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, DiagnosticCleanupCategory.Formatting);

        Assert.Equal(Lines(
                "class Widget {",
                "    void Draw() {",
                "        MissingType value = null;",
                "    }",
                "}"), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
        Assert.True(result.IsComplete);
    }

    [Fact]
    public async Task CleanupAsync_ExplicitTypePreference_ReplacesVarWithExplicitTypes()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace();
        workspace.AddEditorConfig(string.Empty, EditorConfig(VarPreference(false, "IDE0008", "warning")));
        DocumentId documentId = workspace.AddDocument("Calculator.cs", Lines(
            "class Calculator",
            "{",
            "    int Compute()",
            "    {",
            "        var count = 1;",
            "        var name = \"two\";",
            "        return count + name.Length;",
            "    }",
            "}"));

        DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, DiagnosticCleanupCategory.CodeStyle);

        Assert.Equal(Lines(
                "class Calculator",
                "{",
                "    int Compute()",
                "    {",
                "        int count = 1;",
                "        string name = \"two\";",
                "        return count + name.Length;",
                "    }",
                "}"), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
        Assert.True(result.IsComplete);
    }

    [Fact]
    public async Task CleanupAsync_VarPreference_ReplacesExplicitTypesWithVar()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace();
        workspace.AddEditorConfig(string.Empty, EditorConfig(VarPreference(true, "IDE0007", "warning")));
        DocumentId documentId = workspace.AddDocument("Calculator.cs", Lines(
            "class Calculator",
            "{",
            "    int Compute()",
            "    {",
            "        int count = 1;",
            "        string name = \"two\";",
            "        return count + name.Length;",
            "    }",
            "}"));

        DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, DiagnosticCleanupCategory.CodeStyle);

        Assert.Equal(Lines(
                "class Calculator",
                "{",
                "    int Compute()",
                "    {",
                "        var count = 1;",
                "        var name = \"two\";",
                "        return count + name.Length;",
                "    }",
                "}"), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
    }

    [Theory]
    [InlineData("silent", false)]
    [InlineData("none", false)]
    [InlineData("suggestion", true)]
    [InlineData("warning", true)]
    [InlineData("error", true)]
    public Task CleanupAsync_DotnetDiagnosticSeverity_DecidesWhetherCodeStyleRuleIsApplied(string severity, bool expectChange)
        => AssertExplicitTypeRuleOutcomeAsync(VarPreference(false, "IDE0008", severity), expectChange);

    [Theory]
    [InlineData("silent", false)]
    [InlineData("none", false)]
    [InlineData("suggestion", true)]
    [InlineData("warning", true)]
    [InlineData("error", true)]
    public Task CleanupAsync_OptionSeveritySuffix_DecidesWhetherCodeStyleRuleIsApplied(string severity, bool expectChange)
        => AssertExplicitTypeRuleOutcomeAsync(
            new[]
            {
                "csharp_style_var_for_built_in_types = false:" + severity,
                "csharp_style_var_when_type_is_apparent = false:" + severity,
                "csharp_style_var_elsewhere = false:" + severity,
            },
            expectChange);

    [Theory]
    [InlineData("silent", false)]
    [InlineData("none", false)]
    [InlineData("suggestion", true)]
    [InlineData("warning", true)]
    [InlineData("error", true)]
    public async Task CleanupAsync_NamingRuleSeverity_DecidesWhetherRenameIsApplied(string severity, bool expectChange)
    {
        string input = Lines(
            "class Counter",
            "{",
            "    private int count;",
            "",
            "    public int Get()",
            "    {",
            "        return count;",
            "    }",
            "}");
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace();
        workspace.AddEditorConfig(string.Empty, EditorConfig(PrivateFieldsPrefixRule("m_", "pascal_case", severity)));
        DocumentId documentId = workspace.AddDocument("Counter.cs", input);

        DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, DiagnosticCleanupCategory.Naming);

        string expected = expectChange ? input.Replace("count", "m_Count") : input;
        Assert.Equal(expected, await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
        Assert.Equal(expectChange, result.HasChanges);
        Assert.Empty(result.Unresolved);
    }

    [Fact]
    public async Task CleanupAsync_NestedEditorConfig_OverridesInheritedRuleForFilesBelowIt()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace();
        workspace.AddEditorConfig(string.Empty, EditorConfig(PrivateFieldsPrefixRule("m_", "pascal_case")));
        workspace.AddEditorConfig("Legacy", Lines(
            "[*.cs]",
            "dotnet_naming_style.prefix_style.required_prefix = f_"));
        workspace.AddEditorConfig("Generated", Lines(
            "[*.cs]",
            "dotnet_naming_rule.private_fields_rule.severity = none"));
        DocumentId rootId = workspace.AddDocument("Probe.cs", CounterClass("Probe"));
        DocumentId legacyId = workspace.AddDocument("Legacy/Old.cs", CounterClass("Old"));
        DocumentId generatedId = workspace.AddDocument("Generated/Gen.cs", CounterClass("Gen"));
        Solution solution = workspace.CreateSolution();

        DiagnosticCleanupResult rootResult = await CleanupAsync(solution, rootId, DiagnosticCleanupCategory.Naming);
        DiagnosticCleanupResult legacyResult = await CleanupAsync(solution, legacyId, DiagnosticCleanupCategory.Naming);
        DiagnosticCleanupResult generatedResult = await CleanupAsync(solution, generatedId, DiagnosticCleanupCategory.Naming);

        Assert.Equal(CounterClass("Probe").Replace("count", "m_Count"), await DiagnosticCleanupTestWorkspace.GetTextAsync(rootResult.ChangedSolution, rootId));
        Assert.Equal(CounterClass("Old").Replace("count", "f_Count"), await DiagnosticCleanupTestWorkspace.GetTextAsync(legacyResult.ChangedSolution, legacyId));
        Assert.Equal(CounterClass("Gen"), await DiagnosticCleanupTestWorkspace.GetTextAsync(generatedResult.ChangedSolution, generatedId));
        Assert.False(generatedResult.HasChanges);
    }

    [Fact]
    public async Task CleanupAsync_OnlyNamingEnabled_LeavesFormattingViolationsUntouched()
    {
        (DiagnosticCleanupTestWorkspace workspace, DocumentId documentId) = CreateNamingAndFormattingWorkspace();
        using (workspace)
        {
            DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, DiagnosticCleanupCategory.Naming);

            Assert.Equal(Lines(
                    "class Widget",
                    "{",
                    "    private int m_Size;",
                    "",
                    "    int Measure()",
                    "    {",
                    "        return m_Size;",
                    "    }",
                    "}"), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
            Assert.True(result.AppliedFixes.All(fix => fix.Category == DiagnosticCleanupCategory.Naming));
            Assert.Empty(result.Unresolved);
        }
    }

    [Fact]
    public async Task CleanupAsync_OnlyFormattingEnabled_LeavesNamingViolationsUntouched()
    {
        (DiagnosticCleanupTestWorkspace workspace, DocumentId documentId) = CreateNamingAndFormattingWorkspace();
        using (workspace)
        {
            DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, DiagnosticCleanupCategory.Formatting);

            Assert.Equal(Lines(
                    "class Widget {",
                    "    private int size;",
                    "",
                    "    int Measure() {",
                    "        return size;",
                    "    }",
                    "}"), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
            Assert.True(result.AppliedFixes.All(fix => fix.Category == DiagnosticCleanupCategory.Formatting));
            Assert.Empty(result.Unresolved);
        }
    }

    [Fact]
    public async Task CleanupAsync_NamingAndFormattingEnabled_AppliesBoth()
    {
        (DiagnosticCleanupTestWorkspace workspace, DocumentId documentId) = CreateNamingAndFormattingWorkspace();
        using (workspace)
        {
            DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, DiagnosticCleanupCategory.Naming, DiagnosticCleanupCategory.Formatting);

            Assert.Equal(Lines(
                    "class Widget {",
                    "    private int m_Size;",
                    "",
                    "    int Measure() {",
                    "        return m_Size;",
                    "    }",
                    "}"), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
            Assert.True(result.IsComplete);
        }
    }

    [Fact]
    public async Task CleanupAsync_NoCategoryEnabled_ReturnsInputWithoutRunningAnalysis()
    {
        AnalysisProbeAnalyzer probe = new AnalysisProbeAnalyzer();
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace(probe);
        workspace.AddEditorConfig(string.Empty, EditorConfig(PrivateFieldsPrefixRule("m_", "pascal_case").Concat(UseBraceOnSameLine).ToArray()));
        DocumentId documentId = workspace.AddDocument("Widget.cs", Lines(
            "class Widget",
            "{",
            "    private int size;",
            "}"));
        Solution solution = workspace.CreateSolution();

        DiagnosticCleanupResult result = await CleanupAsync(solution, documentId);

        Assert.Same(solution, result.OriginalSolution);
        Assert.Same(solution, result.ChangedSolution);
        Assert.False(result.HasChanges);
        Assert.True(result.IsComplete);
        Assert.Empty(result.AppliedFixes);
        Assert.Empty(result.Unresolved);
        Assert.Equal(0, probe.AnalyzedTreeCount);

        await CleanupAsync(solution, documentId, DiagnosticCleanupCategory.CodeStyle);

        Assert.True(probe.AnalyzedTreeCount > 0);
    }

    [Fact]
    public async Task CleanupAsync_FixAllCapableRule_FixesEveryViolationInASinglePass()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace();
        workspace.AddEditorConfig(string.Empty, EditorConfig(VarPreference(false, "IDE0008", "warning")));
        DocumentId documentId = workspace.AddDocument("Calculator.cs", Lines(
            "class Calculator",
            "{",
            "    long Compute()",
            "    {",
            "        var a = 1;",
            "        var b = 2;",
            "        var c = 3;",
            "        var d = \"four\";",
            "        var e = 5L;",
            "        return a + b + c + d.Length + e;",
            "    }",
            "}"));

        DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, 1, Catalog, DiagnosticCleanupCategory.CodeStyle);

        Assert.Equal(Lines(
                "class Calculator",
                "{",
                "    long Compute()",
                "    {",
                "        int a = 1;",
                "        int b = 2;",
                "        int c = 3;",
                "        string d = \"four\";",
                "        long e = 5L;",
                "        return a + b + c + d.Length + e;",
                "    }",
                "}"), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
        Assert.True(result.IsComplete);
        AppliedDiagnosticFix applied = result.AppliedFixes.Single();
        Assert.Equal("IDE0008", applied.DiagnosticId);
        Assert.Equal(5, applied.Count);
    }

    [Fact]
    public async Task CleanupAsync_RuleWithoutFixAllProvider_FixesEveryViolationAcrossPasses()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace();
        workspace.AddEditorConfig(string.Empty, EditorConfig(PrivateFieldsPrefixRule("m_", "pascal_case")));
        DocumentId documentId = workspace.AddDocument("Triple.cs", TripleFieldClass());

        DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, DiagnosticCleanupCategory.Naming);

        Assert.Equal(TripleFieldClass().Replace("first", "m_First").Replace("second", "m_Second").Replace("third", "m_Third"), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
        Assert.True(result.IsComplete);
        Assert.Equal(3, result.AppliedFixes.Single().Count);
    }

    [Fact]
    public async Task CleanupAsync_MaxPassesExhausted_ReportsRemainingDiagnosticsAsNotConverged()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace();
        workspace.AddEditorConfig(string.Empty, EditorConfig(PrivateFieldsPrefixRule("m_", "pascal_case")));
        DocumentId documentId = workspace.AddDocument("Triple.cs", TripleFieldClass());

        DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, 1, Catalog, DiagnosticCleanupCategory.Naming);

        Assert.Equal(TripleFieldClass().Replace("first", "m_First"), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
        Assert.False(result.IsComplete);
        Assert.Equal(1, result.AppliedFixes.Single().Count);
        Assert.Equal(new[] { 4, 5 }, result.Unresolved.Select(unresolved => unresolved.Line).ToArray());
        Assert.True(result.Unresolved.All(unresolved =>
            unresolved.Reason == UnresolvedDiagnosticReason.NotConverged
            && unresolved.DiagnosticId == "IDE1006"
            && unresolved.Category == DiagnosticCleanupCategory.Naming));
    }

    [Fact]
    public async Task CleanupAsync_IdeRuleActiveOnlyThroughItsDefaultOption_IsLeftAlone()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace();
        string input = Lines(
            "class Point",
            "{",
            "    public int X;",
            "",
            "    public static Point Create()",
            "    {",
            "        var point = new Point();",
            "        point.X = 1;",
            "        return point;",
            "    }",
            "}");
        DocumentId documentId = workspace.AddDocument("Point.cs", input);

        DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, DiagnosticCleanupCategory.CodeStyle);

        Assert.Equal(input, await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
        Assert.Empty(result.Unresolved);
    }

    [Fact]
    public async Task CleanupAsync_IdeRuleEnabledThroughAnOptionSeveritySuffix_IsFixed()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace();
        workspace.AddEditorConfig(string.Empty, EditorConfig("dotnet_style_object_initializer = true:warning"));
        DocumentId documentId = workspace.AddDocument("Point.cs", Lines(
            "class Point",
            "{",
            "    public int X;",
            "",
            "    public static Point Create()",
            "    {",
            "        var point = new Point();",
            "        point.X = 1;",
            "        return point;",
            "    }",
            "}"));

        DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, DiagnosticCleanupCategory.CodeStyle);

        Assert.Contains("X = 1", await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
        Assert.DoesNotContain("point.X = 1;", await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
    }

    [Fact]
    public async Task CleanupAsync_RuleActiveOnlyByDefault_IsNotConfiguredByTheRepositoryAndIsLeftAlone()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace(new LegacyFieldAnalyzer("CJT0020", "Performance"));
        DocumentId documentId = workspace.AddDocument("Settings.cs", LegacySettingsClass());
        Solution solution = workspace.CreateSolution();

        DiagnosticCleanupResult result = await CleanupAsync(solution, documentId, new RenameLegacyFieldCodeFixProvider("CJT0020"));

        Assert.Same(solution, result.ChangedSolution);
        Assert.Empty(result.Unresolved);
    }

    [Fact]
    public async Task CleanupAsync_RuleConfiguredAtItsDefaultSeverity_IsFixed()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace(new LegacyFieldAnalyzer("CJT0021", "Performance"));
        workspace.ConfigureRuleSeverity("CJT0021", "warning");
        DocumentId documentId = workspace.AddDocument("Settings.cs", LegacySettingsClass());

        DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, new RenameLegacyFieldCodeFixProvider("CJT0021"));

        Assert.Equal(LegacySettingsClass().Replace("legacyValue", "renamedValue"), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task CleanupAsync_RuleConfiguredAsSilent_IsNeitherFixedNorReported(bool hiddenByDefault)
    {
        // Silent is refactoring-only: even an explicit silent severity with an available fix leaves the code alone.
        DiagnosticAnalyzer analyzer = hiddenByDefault
            ? new HiddenLegacyFieldAnalyzer("CJT0030")
            : new LegacyFieldAnalyzer("CJT0030", "Performance");
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace(analyzer);
        workspace.AddEditorConfig(string.Empty, EditorConfig("dotnet_diagnostic.CJT0030.severity = silent"));
        DocumentId documentId = workspace.AddDocument("Settings.cs", LegacySettingsClass());
        Solution solution = workspace.CreateSolution();

        DiagnosticCleanupResult result = await CleanupAsync(solution, documentId, new RenameLegacyFieldCodeFixProvider("CJT0030"));

        Assert.Same(solution, result.ChangedSolution);
        Assert.Empty(result.Unresolved);
    }

    [Fact]
    public async Task CleanupAsync_ActionableDiagnosticWithoutCodeFixProvider_IsReportedAndNeverModified()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace(new LegacyFieldAnalyzer("CJT0001", "Style"));
        workspace.ConfigureRuleSeverity("CJT0001", "warning");
        string input = LegacySettingsClass();
        DocumentId documentId = workspace.AddDocument("Settings.cs", input);
        Solution solution = workspace.CreateSolution();

        DiagnosticCleanupResult result = await CleanupAsync(solution, documentId, DiagnosticCleanupCategory.CodeStyle);

        Assert.Equal(input, await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
        Assert.Same(solution, result.ChangedSolution);
        Assert.False(result.HasChanges);
        Assert.True(result.IsComplete, "An unsupported diagnostic is reported, it does not make the cleanup incomplete.");
        UnresolvedRoslynDiagnostic unresolved = result.Unresolved.Single();
        Assert.Equal("CJT0001", unresolved.DiagnosticId);
        Assert.Equal(DiagnosticCleanupCategory.CodeStyle, unresolved.Category);
        Assert.Equal(DiagnosticSeverity.Warning, unresolved.Severity);
        Assert.Equal(DiagnosticCleanupTestWorkspace.GetPath("Settings.cs"), unresolved.FilePath);
        Assert.Equal(3, unresolved.Line);
        Assert.Equal("Field 'legacyValue' uses the legacy prefix", unresolved.Message);
        Assert.Equal(UnresolvedDiagnosticReason.NoCodeFixProvider, unresolved.Reason);
    }

    [Fact]
    public async Task CleanupAsync_AnalyzerReportingSeveralCategories_OnlyEnabledCategoryIsActionable()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace(new LegacyFieldAnalyzer(("CJT0007", "Style"), ("CJT0008", "Performance")));
        workspace.ConfigureRuleSeverity("CJT0007", "warning");
        workspace.ConfigureRuleSeverity("CJT0008", "warning");
        DocumentId documentId = workspace.AddDocument("Settings.cs", LegacySettingsClass());

        DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, DiagnosticCleanupCategory.AnalyzerFixes);

        UnresolvedRoslynDiagnostic unresolved = result.Unresolved.Single();
        Assert.Equal("CJT0008", unresolved.DiagnosticId);
        Assert.Equal(DiagnosticCleanupCategory.AnalyzerFixes, unresolved.Category);
    }

    [Fact]
    public async Task CleanupAsync_ProviderOffersOnlyNestedActions_ReportsNoApplicableCodeAction()
    {
        using DiagnosticCleanupTestWorkspace workspace = CreateLegacySettingsWorkspace("CJT0003", out DocumentId documentId);
        Solution solution = workspace.CreateSolution();

        DiagnosticCleanupResult result = await CleanupAsync(solution, documentId, new NestedOnlyLegacyFieldCodeFixProvider("CJT0003"));

        Assert.Equal(LegacySettingsClass(), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
        Assert.Same(solution, result.ChangedSolution);
        Assert.True(result.IsComplete);
        Assert.Equal(UnresolvedDiagnosticReason.NoApplicableCodeAction, result.Unresolved.Single().Reason);
    }

    [Fact]
    public async Task CleanupAsync_FixWithoutEffect_IsNotCountedAndReportsNoApplicableCodeAction()
    {
        using DiagnosticCleanupTestWorkspace workspace = CreateLegacySettingsWorkspace("CJT0009", out DocumentId documentId);
        Solution solution = workspace.CreateSolution();

        DiagnosticCleanupResult result = await CleanupAsync(solution, documentId, new NoOpLegacyFieldCodeFixProvider("CJT0009"));

        Assert.Same(solution, result.ChangedSolution);
        Assert.Empty(result.AppliedFixes);
        Assert.True(result.IsComplete);
        Assert.Equal(UnresolvedDiagnosticReason.NoApplicableCodeAction, result.Unresolved.Single().Reason);
    }

    [Fact]
    public async Task CleanupAsync_AlternativeActionsForMoreDiagnosticsThanThePassLimit_FixesAllOfThem()
    {
        string[] fields = Enumerable.Range(0, 60).Select(index => $"    public int legacy{index};").ToArray();
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace(new LegacyFieldAnalyzer("CJT0023", "Performance"));
        workspace.ConfigureRuleSeverity("CJT0023", "warning");
        DocumentId documentId = workspace.AddDocument("Settings.cs", Lines(new[] { "class Settings", "{" }.Concat(fields).Concat(new[] { "}" }).ToArray()));

        CodeFixProviderCatalog catalog = new CodeFixProviderCatalog(new[] { new AlternativesWithoutEquivalenceKeyLegacyFieldCodeFixProvider("CJT0023") });

        DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, 1, catalog, DiagnosticCleanupCategory.AnalyzerFixes);

        string[] expectedFields = Enumerable.Range(0, 60).Select(index => $"    public int first{index};").ToArray();
        Assert.Equal(Lines(new[] { "class Settings", "{" }.Concat(expectedFields).Concat(new[] { "}" }).ToArray()), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
        Assert.Equal(60, result.AppliedFixes.Single().Count);
        Assert.True(result.IsComplete);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task CleanupAsync_AlternativeActionsWithTheSameEquivalenceKey_AppliesOnlyTheChosenActionToEveryDiagnosticInOnePass(bool providerHasFixAll)
    {
        using DiagnosticCleanupTestWorkspace workspace = CreateTwoLegacyFieldsWorkspace("CJT0020", out DocumentId documentId);
        CodeFixProviderCatalog catalog = new CodeFixProviderCatalog(new[] { new AlternativesWithoutEquivalenceKeyLegacyFieldCodeFixProvider("CJT0020", providerHasFixAll) });

        DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, 1, catalog, DiagnosticCleanupCategory.AnalyzerFixes);

        Assert.Equal(TwoLegacyFieldsClass().Replace("legacy", "first"), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
        Assert.True(result.IsComplete);
        Assert.Empty(result.Unresolved);
        Assert.Equal(2, result.AppliedFixes.Single().Count);
    }

    [Theory]
    [InlineData("CJT0021", false)]
    [InlineData("CJT0022", true)]
    public async Task CleanupAsync_SingleActionWithoutEquivalenceKey_StillFixesAllDiagnosticsInOnePassThroughFixAll(string diagnosticId, bool withNestedChoice)
    {
        using DiagnosticCleanupTestWorkspace workspace = CreateTwoLegacyFieldsWorkspace(diagnosticId, out DocumentId documentId);
        CodeFixProviderCatalog catalog = new CodeFixProviderCatalog(new[] { new BatchRenameLegacyFieldCodeFixProvider(diagnosticId, withNestedChoice) });

        DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, 1, catalog, DiagnosticCleanupCategory.AnalyzerFixes);

        Assert.Equal(TwoLegacyFieldsClass().Replace("legacy", "batch"), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
        Assert.True(result.IsComplete);
    }

    [Fact]
    public async Task CleanupAsync_ProviderOffersNestedGroupThenPlainAction_AppliesThePlainAction()
    {
        using DiagnosticCleanupTestWorkspace workspace = CreateLegacySettingsWorkspace("CJT0004", out DocumentId documentId);

        DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, new RenameLegacyFieldCodeFixProvider("CJT0004"));

        Assert.Equal(LegacySettingsClass().Replace("legacyValue", "renamedValue"), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
        Assert.True(result.IsComplete);
        Assert.Empty(result.Unresolved);
        AppliedDiagnosticFix applied = result.AppliedFixes.Single();
        Assert.Equal("CJT0004", applied.DiagnosticId);
        Assert.Equal(DiagnosticCleanupCategory.AnalyzerFixes, applied.Category);
        Assert.Equal(1, applied.Count);
    }

    [Fact]
    public async Task CleanupAsync_FixIntroducingCompilerError_IsRejectedAndOriginalTextPreserved()
    {
        using DiagnosticCleanupTestWorkspace workspace = CreateLegacySettingsWorkspace("CJT0005", out DocumentId documentId);
        Solution solution = workspace.CreateSolution();

        DiagnosticCleanupResult result = await CleanupAsync(solution, documentId, new BreakingLegacyFieldCodeFixProvider("CJT0005"));

        Assert.Equal(LegacySettingsClass(), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
        Assert.Same(solution, result.ChangedSolution);
        Assert.False(result.HasChanges);
        Assert.False(result.IsComplete);
        Assert.Empty(result.AppliedFixes);
        UnresolvedRoslynDiagnostic unresolved = result.Unresolved.Single();
        Assert.Equal("CJT0005", unresolved.DiagnosticId);
        Assert.Equal(UnresolvedDiagnosticReason.FixRejectedIntroducesCompilerErrors, unresolved.Reason);
    }

    [Fact]
    public async Task CleanupAsync_FixThatThrowsWhileComputed_IsRejectedAndTheOtherFixesOfTheFileAreApplied()
    {
        DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace(
            new LegacyFieldAnalyzer("old", ("CJT0040", "Performance")),
            new HiddenLegacyFieldAnalyzer("CJT0041"));
        using (workspace)
        {
            workspace.ConfigureRuleSeverity("CJT0040", "warning");
            workspace.ConfigureRuleSeverity("CJT0041", "warning");
            DocumentId documentId = workspace.AddDocument("Settings.cs", Lines(
                "class Settings",
                "{",
                "    public int oldValue;",
                "    public int legacyValue;",
                "}"));
            CustomOperationsLegacyFieldCodeFixProvider throwing = new CustomOperationsLegacyFieldCodeFixProvider(
                "CJT0040",
                (_, _, _) => throw new System.InvalidOperationException("Sequence contains no elements"));
            CodeFixProviderCatalog catalog = new CodeFixProviderCatalog(new CodeFixProvider[] { throwing, new RenameLegacyFieldCodeFixProvider("CJT0041") });

            DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, 50, catalog, DiagnosticCleanupCategory.AnalyzerFixes);

            Assert.True(result.HasChanges, "The fix of the other rule must still be applied.");
            Assert.Equal("CJT0041", result.AppliedFixes.Single().DiagnosticId);
            Assert.Contains("renamedValue", await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
            Assert.False(result.IsComplete);
            UnresolvedRoslynDiagnostic unresolved = result.Unresolved.Single();
            Assert.Equal("CJT0040", unresolved.DiagnosticId);
            Assert.Equal(UnresolvedDiagnosticReason.FixProviderFailed, unresolved.Reason);
            Assert.Contains(nameof(CustomOperationsLegacyFieldCodeFixProvider), unresolved.Detail);
            Assert.Contains("Sequence contains no elements", unresolved.Detail);
        }
    }

    [Fact]
    public async Task CleanupAsync_ProviderThatThrowsWhileRegisteringFixes_ReportsTheDiagnosticAsProviderFailure()
    {
        using DiagnosticCleanupTestWorkspace workspace = CreateLegacySettingsWorkspace("CJT0042", out DocumentId documentId);
        Solution solution = workspace.CreateSolution();

        DiagnosticCleanupResult result = await CleanupAsync(solution, documentId, new ThrowingLegacyFieldCodeFixProvider("CJT0042"));

        Assert.Same(solution, result.ChangedSolution);
        Assert.False(result.IsComplete);
        UnresolvedRoslynDiagnostic unresolved = result.Unresolved.Single();
        Assert.Equal("CJT0042", unresolved.DiagnosticId);
        Assert.Equal(UnresolvedDiagnosticReason.FixProviderFailed, unresolved.Reason);
        Assert.Contains(nameof(ThrowingLegacyFieldCodeFixProvider), unresolved.Detail);
        Assert.Contains("Sequence contains no elements", unresolved.Detail);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task CleanupAsync_ProviderWithACastBug_ReportsTheDiagnosticAsProviderFailure(bool failsWhileRegistering)
    {
        using DiagnosticCleanupTestWorkspace workspace = CreateLegacySettingsWorkspace("CJT0052", out DocumentId documentId);
        Solution solution = workspace.CreateSolution();

        DiagnosticCleanupResult result = await CleanupAsync(solution, documentId, new CastBugLegacyFieldCodeFixProvider("CJT0052", failsWhileRegistering));

        Assert.Same(solution, result.ChangedSolution);
        UnresolvedRoslynDiagnostic unresolved = result.Unresolved.Single();
        Assert.Equal(UnresolvedDiagnosticReason.FixProviderFailed, unresolved.Reason);
        Assert.Contains(nameof(CastBugLegacyFieldCodeFixProvider), unresolved.Detail);
    }

    [Fact]
    public async Task CleanupAsync_ProviderExceptionMessageWithNewlines_YieldsASingleLineDetail()
    {
        using DiagnosticCleanupTestWorkspace workspace = CreateLegacySettingsWorkspace("CJT0048", out DocumentId documentId);
        Solution solution = workspace.CreateSolution();

        DiagnosticCleanupResult result = await CleanupAsync(solution, documentId, new MultiLineThrowingLegacyFieldCodeFixProvider("CJT0048"));

        UnresolvedRoslynDiagnostic unresolved = result.Unresolved.Single();
        Assert.Equal(UnresolvedDiagnosticReason.FixProviderFailed, unresolved.Reason);
        Assert.Contains("first line second line third line", unresolved.Detail);
        Assert.False(unresolved.Detail.Contains('\r') || unresolved.Detail.Contains('\n'), "The detail is written to one output pane line.");
    }

    [Fact]
    public async Task CleanupAsync_ProviderWhoseGetFixAllProviderThrows_IsRejectedAndTheOtherFixesOfTheFileAreApplied()
    {
        DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace(
            new LegacyFieldAnalyzer("old", ("CJT0044", "Performance")),
            new HiddenLegacyFieldAnalyzer("CJT0045"));
        using (workspace)
        {
            workspace.ConfigureRuleSeverity("CJT0044", "warning");
            workspace.ConfigureRuleSeverity("CJT0045", "warning");
            DocumentId documentId = workspace.AddDocument("Settings.cs", Lines(
                "class Settings",
                "{",
                "    public int oldValue;",
                "    public int legacyValue;",
                "}"));
            CodeFixProviderCatalog catalog = new CodeFixProviderCatalog(new CodeFixProvider[]
            {
                new UnreliableFixAllLegacyFieldCodeFixProvider("CJT0044", FixAllFailure.GetFixAllProvider),
                new RenameLegacyFieldCodeFixProvider("CJT0045"),
            });

            DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, 50, catalog, DiagnosticCleanupCategory.AnalyzerFixes);

            Assert.Equal("CJT0045", result.AppliedFixes.Single().DiagnosticId);
            Assert.Contains("renamedValue", await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
            Assert.False(result.IsComplete);
            UnresolvedRoslynDiagnostic unresolved = result.Unresolved.Single();
            Assert.Equal("CJT0044", unresolved.DiagnosticId);
            Assert.Equal(UnresolvedDiagnosticReason.FixProviderFailed, unresolved.Reason);
            Assert.Contains("Fix-all provider unavailable", unresolved.Detail);
        }
    }

    [Fact]
    public async Task CleanupAsync_ProviderThatThrowsFollowedByWorkingProviderForSameId_AppliesTheWorkingFix()
    {
        using DiagnosticCleanupTestWorkspace workspace = CreateLegacySettingsWorkspace("CJT0046", out DocumentId documentId);
        CodeFixProviderCatalog catalog = new CodeFixProviderCatalog(new CodeFixProvider[]
        {
            new ThrowingLegacyFieldCodeFixProvider("CJT0046"),
            new UnreliableFixAllLegacyFieldCodeFixProvider("CJT0046", FixAllFailure.None),
        });

        DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, 50, catalog, DiagnosticCleanupCategory.AnalyzerFixes);

        Assert.Equal(LegacySettingsClass().Replace("legacyValue", "renamedValue"), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
        Assert.True(result.IsComplete);
        Assert.Empty(result.Unresolved);
        Assert.Equal("CJT0046", result.AppliedFixes.Single().DiagnosticId);
    }

    [Fact]
    public async Task CleanupAsync_FixAllProviderThatThrowsForMultiDiagnosticGroup_ReportsEveryDiagnosticOfTheGroupAsProviderFailure()
    {
        using DiagnosticCleanupTestWorkspace workspace = CreateTwoLegacyFieldsWorkspace("CJT0047", out DocumentId documentId);
        Solution solution = workspace.CreateSolution();
        CodeFixProviderCatalog catalog = new CodeFixProviderCatalog(new CodeFixProvider[]
        {
            new UnreliableFixAllLegacyFieldCodeFixProvider("CJT0047", FixAllFailure.GetFixAsync),
        });

        DiagnosticCleanupResult result = await CleanupAsync(solution, documentId, 50, catalog, DiagnosticCleanupCategory.AnalyzerFixes);

        Assert.Same(solution, result.ChangedSolution);
        Assert.False(result.IsComplete);
        Assert.Equal(2, (result.Unresolved).Count());
        foreach (UnresolvedRoslynDiagnostic unresolved in result.Unresolved)
        {
            Assert.Equal("CJT0047", unresolved.DiagnosticId);
            Assert.Equal(UnresolvedDiagnosticReason.FixProviderFailed, unresolved.Reason);
            Assert.Contains("Fix-all computation failed", unresolved.Detail);
        }
    }

    [Fact]
    public async Task CleanupAsync_ProviderThatCancelsTheCleanupAndThrows_PropagatesTheCancellation()
    {
        using DiagnosticCleanupTestWorkspace workspace = CreateLegacySettingsWorkspace("CJT0043", out DocumentId documentId);
        using CancellationTokenSource cancellation = new CancellationTokenSource();
        DiagnosticCleanupEngine engine = new DiagnosticCleanupEngine(
            new CodeFixProviderCatalog(new CodeFixProvider[] { new CancelingLegacyFieldCodeFixProvider("CJT0043", cancellation) }));

        await Assert.ThrowsAsync<System.OperationCanceledException>(() => engine.CleanupAsync(
            workspace.CreateSolution().GetDocument(documentId),
            new DiagnosticCleanupOptions(new[] { DiagnosticCleanupCategory.AnalyzerFixes }),
            cancellation.Token));
    }

    [Theory]
    [InlineData((int)FixAllFailure.None)]
    [InlineData((int)FixAllFailure.GetFixAllProvider)]
    [InlineData((int)FixAllFailure.GetFixAsync)]
    public async Task CleanupAsync_ProviderBuiltAgainstAnotherRoslyn_IsReportedAsAProviderFailure(int failingStep)
    {
        using DiagnosticCleanupTestWorkspace workspace = CreateLegacySettingsWorkspace("CJT0049", out DocumentId documentId);
        CodeFixProviderCatalog catalog = new CodeFixProviderCatalog(new CodeFixProvider[] { new BindingFailureLegacyFieldCodeFixProvider("CJT0049", (FixAllFailure)failingStep) });
        Solution solution = workspace.CreateSolution();

        // The server hosts its own Roslyn: a NuGet fixer that cannot bind to it is a broken provider, not a broken host.
        DiagnosticCleanupResult result = await CleanupAsync(solution, documentId, 50, catalog, DiagnosticCleanupCategory.AnalyzerFixes);

        Assert.Same(solution, result.ChangedSolution);
        Assert.All(result.Unresolved, unresolved => Assert.Equal(UnresolvedDiagnosticReason.FixProviderFailed, unresolved.Reason));
        Assert.NotEmpty(result.Unresolved);
    }

    [Fact]
    public async Task CleanupAsync_ProviderThatThrowsWhileRegisteringFixes_IsNotInvokedAgainForTheSameDiagnosticInLaterPasses()
    {
        DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace(
            new LegacyFieldAnalyzer("old", ("CJT0050", "Performance")),
            new HiddenLegacyFieldAnalyzer("CJT0051"));
        using (workspace)
        {
            workspace.ConfigureRuleSeverity("CJT0050", "warning");
            workspace.ConfigureRuleSeverity("CJT0051", "warning");
            DocumentId documentId = workspace.AddDocument("Settings.cs", Lines(
                "class Settings",
                "{",
                "    public int oldValue;",
                "    public int legacyValue;",
                "}"));
            CountingThrowingLegacyFieldCodeFixProvider throwing = new CountingThrowingLegacyFieldCodeFixProvider("CJT0050");
            CodeFixProviderCatalog catalog = new CodeFixProviderCatalog(new CodeFixProvider[] { throwing, new RenameLegacyFieldCodeFixProvider("CJT0051") });

            DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, 50, catalog, DiagnosticCleanupCategory.AnalyzerFixes);

            // Pass 1 applies the CJT0051 fix, pass 2 plans the remaining CJT0050 diagnostic again.
            Assert.Equal("CJT0051", result.AppliedFixes.Single().DiagnosticId);
            Assert.Equal(1, throwing.RegisterCalls);
            UnresolvedRoslynDiagnostic unresolved = result.Unresolved.Single();
            Assert.Equal("CJT0050", unresolved.DiagnosticId);
            Assert.Equal(UnresolvedDiagnosticReason.FixProviderFailed, unresolved.Reason);
            Assert.Contains(nameof(CountingThrowingLegacyFieldCodeFixProvider), unresolved.Detail);
            Assert.Contains("Registration failed", unresolved.Detail);
        }
    }

    [Fact]
    public async Task CleanupAsync_FixChangingSolutionStructure_IsRejectedAsUnsupported()
    {
        using DiagnosticCleanupTestWorkspace workspace = CreateLegacySettingsWorkspace("CJT0006", out DocumentId documentId);
        Solution solution = workspace.CreateSolution();

        DiagnosticCleanupResult result = await CleanupAsync(solution, documentId, new AddDocumentLegacyFieldCodeFixProvider("CJT0006"));

        Assert.Same(solution, result.ChangedSolution);
        Assert.False(result.IsComplete);
        Assert.Equal(UnresolvedDiagnosticReason.FixRejectedUnsupportedChanges, result.Unresolved.Single().Reason);
        Assert.Equal(LegacySettingsClass(), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
    }

    [Fact]
    public async Task CleanupAsync_FixesWithHostNotifications_ApplyTheSolutionChangesWithoutExecutingTheNotifications()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace(new LegacyFieldAnalyzer("CJT0010", "Performance"));
        workspace.ConfigureRuleSeverity("CJT0010", "warning");
        DocumentId documentId = workspace.AddDocument("Settings.cs", Lines(
            "class Settings",
            "{",
            "    public int legacyFirst;",
            "    public int legacySecond;",
            "}"));
        CustomOperationsLegacyFieldCodeFixProvider provider = new CustomOperationsLegacyFieldCodeFixProvider(
            "CJT0010",
            (name, _, renamed) => new CodeActionOperation[] { new ApplyChangesOperation(renamed), new HostNotificationOperation(name) });

        DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, provider);

        Assert.Equal(Lines(
                "class Settings",
                "{",
                "    public int renamedFirst;",
                "    public int renamedSecond;",
                "}"), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
        Assert.True(result.IsComplete);
        Assert.Equal(2, result.AppliedFixes.Single().Count);
    }

    [Fact]
    public async Task CleanupAsync_RejectedFixWithHostNotification_KeepsTheSolution()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace(new LegacyFieldAnalyzer("CJT0013", "Performance"));
        workspace.ConfigureRuleSeverity("CJT0013", "warning");
        DocumentId documentId = workspace.AddDocument("Settings.cs", Lines(
            "class Settings",
            "{",
            "    public int legacyValue;",
            "",
            "    public int Read()",
            "    {",
            "        return legacyValue;",
            "    }",
            "}"));
        Solution solution = workspace.CreateSolution();
        CustomOperationsLegacyFieldCodeFixProvider provider = new CustomOperationsLegacyFieldCodeFixProvider(
            "CJT0013",
            (name, _, renamed) => new CodeActionOperation[] { new ApplyChangesOperation(renamed), new HostNotificationOperation(name) });

        DiagnosticCleanupResult result = await CleanupAsync(solution, documentId, provider);

        Assert.Same(solution, result.ChangedSolution);
        Assert.Equal(UnresolvedDiagnosticReason.FixRejectedIntroducesCompilerErrors, result.Unresolved.Single().Reason);
    }

    [Fact]
    public async Task CleanupAsync_FixRemovingOneCompilerErrorButAddingAnother_IsRejected()
    {
        // Renaming only the declaration resolves 'renamedValue' (one CS0103 fewer) but breaks 'legacyValue' (a new
        // CS0103): the error count is unchanged, yet the fix introduces an error.
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace(new LegacyFieldAnalyzer("CJT0014", "Performance"));
        workspace.ConfigureRuleSeverity("CJT0014", "warning");
        DocumentId documentId = workspace.AddDocument("Settings.cs", Lines(
            "class Settings",
            "{",
            "    public int legacyValue;",
            "",
            "    public int Read()",
            "    {",
            "        return legacyValue;",
            "    }",
            "",
            "    public int ReadRenamed()",
            "    {",
            "        return renamedValue;",
            "    }",
            "}"));
        Solution solution = workspace.CreateSolution();
        CustomOperationsLegacyFieldCodeFixProvider provider = new CustomOperationsLegacyFieldCodeFixProvider(
            "CJT0014",
            (_, _, renamed) => new CodeActionOperation[] { new ApplyChangesOperation(renamed) });

        DiagnosticCleanupResult result = await CleanupAsync(solution, documentId, provider);

        Assert.Same(solution, result.ChangedSolution);
        Assert.Equal(UnresolvedDiagnosticReason.FixRejectedIntroducesCompilerErrors, result.Unresolved.Single().Reason);
    }

    [Fact]
    public async Task CleanupAsync_RenameChangingTheMessageOfAnExistingCompilerError_IsApplied()
    {
        // The existing CS0161 names the renamed method, so its message changes ('Widget.doWork()' becomes
        // 'Widget.DoWork()'), but it stays at the same position once mapped through the rename: no error is added.
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace();
        workspace.AddEditorConfig(string.Empty, EditorConfig(
            "dotnet_naming_rule.methods_rule.symbols = methods",
            "dotnet_naming_rule.methods_rule.style = pascal_style",
            "dotnet_naming_rule.methods_rule.severity = warning",
            "dotnet_naming_symbols.methods.applicable_kinds = method",
            "dotnet_naming_symbols.methods.applicable_accessibilities = *",
            "dotnet_naming_style.pascal_style.capitalization = pascal_case"));
        DocumentId documentId = workspace.AddDocument("Widget.cs", Lines(
            "class Widget",
            "{",
            "    int doWork()",
            "    {",
            "    }",
            "}"));

        DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, DiagnosticCleanupCategory.Naming);

        Assert.Equal(Lines(
                "class Widget",
                "{",
                "    int DoWork()",
                "    {",
                "    }",
                "}"), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
        Assert.Empty(result.Unresolved);
        Assert.Equal("IDE1006", result.AppliedFixes.Single().DiagnosticId);
    }

    [Fact]
    public async Task CleanupAsync_RenameAddingASuffixToASymbolNamedByAnExistingCompilerError_IsApplied()
    {
        // The rename is diffed as a pure insertion of 'Async' at the end of 'Get', so the existing CS0161 on the
        // identifier grows to cover the suffix: it must still match, not count as a new error.
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace();
        workspace.AddEditorConfig(string.Empty, EditorConfig(
            "dotnet_naming_rule.methods_rule.symbols = methods",
            "dotnet_naming_rule.methods_rule.style = async_style",
            "dotnet_naming_rule.methods_rule.severity = warning",
            "dotnet_naming_symbols.methods.applicable_kinds = method",
            "dotnet_naming_symbols.methods.applicable_accessibilities = *",
            "dotnet_naming_style.async_style.required_suffix = Async",
            "dotnet_naming_style.async_style.capitalization = pascal_case"));
        DocumentId documentId = workspace.AddDocument("Widget.cs", Lines(
            "class Widget",
            "{",
            "    int Get()",
            "    {",
            "    }",
            "}"));

        DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, DiagnosticCleanupCategory.Naming);

        Assert.Equal(Lines(
                "class Widget",
                "{",
                "    int GetAsync()",
                "    {",
                "    }",
                "}"), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
        Assert.Empty(result.Unresolved);
        Assert.Equal("IDE1006", result.AppliedFixes.Single().DiagnosticId);
    }

    [Fact]
    public async Task CleanupAsync_RenameAddingAPrefixToASymbolNamedByAnExistingCompilerError_IsApplied()
    {
        // The rename is diffed as a pure insertion of 'Try' at the start of 'Get', so the existing CS0161 on the
        // identifier keeps its start and grows to cover the prefix: it must still match, not count as a new error.
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace();
        workspace.AddEditorConfig(string.Empty, EditorConfig(
            "dotnet_naming_rule.methods_rule.symbols = methods",
            "dotnet_naming_rule.methods_rule.style = try_style",
            "dotnet_naming_rule.methods_rule.severity = warning",
            "dotnet_naming_symbols.methods.applicable_kinds = method",
            "dotnet_naming_symbols.methods.applicable_accessibilities = *",
            "dotnet_naming_style.try_style.required_prefix = Try",
            "dotnet_naming_style.try_style.capitalization = pascal_case"));
        DocumentId documentId = workspace.AddDocument("Widget.cs", Lines(
            "class Widget",
            "{",
            "    int Get()",
            "    {",
            "    }",
            "}"));

        DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, DiagnosticCleanupCategory.Naming);

        Assert.Equal(Lines(
                "class Widget",
                "{",
                "    int TryGet()",
                "    {",
                "    }",
                "}"), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
        Assert.Empty(result.Unresolved);
        Assert.Equal("IDE1006", result.AppliedFixes.Single().DiagnosticId);
    }

    [Fact]
    public async Task CleanupAsync_FixWithSeveralSolutionChanges_IsRejectedAsUnsupported()
    {
        using DiagnosticCleanupTestWorkspace workspace = CreateLegacySettingsWorkspace("CJT0011", out DocumentId documentId);
        Solution solution = workspace.CreateSolution();
        CustomOperationsLegacyFieldCodeFixProvider provider = new CustomOperationsLegacyFieldCodeFixProvider(
            "CJT0011",
            (_, _, renamed) => new CodeActionOperation[] { new ApplyChangesOperation(renamed), new ApplyChangesOperation(renamed) });

        DiagnosticCleanupResult result = await CleanupAsync(solution, documentId, provider);

        Assert.Same(solution, result.ChangedSolution);
        Assert.Equal(UnresolvedDiagnosticReason.FixRejectedUnsupportedChanges, result.Unresolved.Single().Reason);
    }

    [Fact]
    public async Task CleanupAsync_FixWithOnlyHostOperations_IsRejectedAsUnsupported()
    {
        using DiagnosticCleanupTestWorkspace workspace = CreateLegacySettingsWorkspace("CJT0012", out DocumentId documentId);
        Solution solution = workspace.CreateSolution();
        CustomOperationsLegacyFieldCodeFixProvider provider = new CustomOperationsLegacyFieldCodeFixProvider(
            "CJT0012",
            (name, _, _) => new CodeActionOperation[] { new HostNotificationOperation(name) });

        DiagnosticCleanupResult result = await CleanupAsync(solution, documentId, provider);

        Assert.Same(solution, result.ChangedSolution);
        Assert.Equal(UnresolvedDiagnosticReason.FixRejectedUnsupportedChanges, result.Unresolved.Single().Reason);
    }

    [Fact]
    public async Task CleanupAsync_ChangedSolution_CanBeAppliedToTheHostWorkspace()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace();
        workspace.AddEditorConfig(string.Empty, EditorConfig(PrivateFieldsPrefixRule("m_", "pascal_case")));
        DocumentId documentId = workspace.AddDocument("Probe.cs", CounterClass("Probe"));

        DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, DiagnosticCleanupCategory.Naming);

        Assert.True(workspace.Workspace.TryApplyChanges(result.ChangedSolution));
        Assert.Equal(CounterClass("Probe").Replace("count", "m_Count"), await DiagnosticCleanupTestWorkspace.GetTextAsync(workspace.Workspace.CurrentSolution, documentId));
    }

    [Fact]
    public async Task CleanupAsync_AnalyzerConfigOverridesWithoutEditorConfig_ApplyTheRuleAndLeaveNoConfigurationInTheResult()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace();
        DocumentId documentId = workspace.AddDocument("Gate.cs", UnbracedGate());
        Solution solution = workspace.CreateSolution();

        DiagnosticCleanupResult result = await CleanupWithOverridesAsync(solution, documentId, BracesOverrides);

        Assert.Equal(BracedGate(), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
        Assert.Same(solution, result.OriginalSolution);
        Assert.DoesNotContain(result.ChangedSolution.GetChanges(solution).GetProjectChanges(), changes =>
            changes.GetAddedAnalyzerConfigDocuments().Any() || changes.GetChangedAnalyzerConfigDocuments().Any());
        Assert.True(workspace.Workspace.TryApplyChanges(result.ChangedSolution));
    }

    [Fact]
    public async Task CleanupAsync_AnalyzerConfigOverrides_BeatASilentEditorConfigEntryInTheDocumentDirectoryWithoutChangingIt()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace();
        string editorConfig = EditorConfig("csharp_prefer_braces = false:silent");
        workspace.AddEditorConfig(string.Empty, editorConfig);
        DocumentId documentId = workspace.AddDocument("Gate.cs", UnbracedGate());
        Solution solution = workspace.CreateSolution();

        DiagnosticCleanupResult result = await CleanupWithOverridesAsync(solution, documentId, BracesOverrides);

        Assert.Equal(BracedGate(), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
        AnalyzerConfigDocument config = result.ChangedSolution.GetDocument(documentId).Project.AnalyzerConfigDocuments.Single();
        Assert.Equal(editorConfig, (await config.GetTextAsync(CancellationToken.None)).ToString());
        Assert.True(workspace.Workspace.TryApplyChanges(result.ChangedSolution));
    }

    [Fact]
    public async Task CleanupAsync_AnalyzerConfigOverrides_BeatAParentEditorConfig()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace();
        workspace.AddEditorConfig(string.Empty, EditorConfig("csharp_prefer_braces = false:silent", "dotnet_diagnostic.IDE0011.severity = none"));
        DocumentId documentId = workspace.AddDocument("Gates/Gate.cs", UnbracedGate());

        DiagnosticCleanupResult result = await CleanupWithOverridesAsync(workspace.CreateSolution(), documentId, BracesOverrides);

        Assert.Equal(BracedGate(), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
    }

    [Fact]
    public async Task CleanupAsync_NoApplicableOverride_ReturnsTheOriginalSolution()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace();
        DocumentId documentId = workspace.AddDocument("Gate.cs", BracedGate());
        Solution solution = workspace.CreateSolution();

        DiagnosticCleanupResult result = await CleanupWithOverridesAsync(solution, documentId, BracesOverrides);

        Assert.False(result.HasChanges);
        Assert.Same(solution, result.ChangedSolution);
    }

    [Fact]
    public async Task Constructor_AndCleanupAsync_RejectMissingArguments()
    {
        using DiagnosticCleanupTestWorkspace workspace = CreateLegacySettingsWorkspace("CJT0060", out DocumentId documentId);
        Document document = workspace.CreateSolution().GetDocument(documentId);
        DiagnosticCleanupEngine engine = new DiagnosticCleanupEngine(Catalog);
        DiagnosticCleanupOptions options = new DiagnosticCleanupOptions(new[] { DiagnosticCleanupCategory.AnalyzerFixes });

        Assert.Equal("catalog", Assert.Throws<System.ArgumentNullException>(() => new DiagnosticCleanupEngine(null)).ParamName);
        Assert.Equal("document", (await Assert.ThrowsAsync<System.ArgumentNullException>(() => engine.CleanupAsync(null, options, CancellationToken.None))).ParamName);
        Assert.Equal("options", (await Assert.ThrowsAsync<System.ArgumentNullException>(() => engine.CleanupAsync(document, null, CancellationToken.None))).ParamName);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CleanupAsync_ProjectWithoutAnyAnalyzerOfAnEnabledCategory_ReturnsTheOriginalSolution(bool withSuppressor)
    {
        using AdhocWorkspace workspace = new AdhocWorkspace();
        Project project = workspace.CurrentSolution.AddProject("Bare", "Bare", LanguageNames.CSharp);
        if (withSuppressor)
        {
            project = project.AddAnalyzerReference(new AnalyzerImageReference(ImmutableArray.Create<DiagnosticAnalyzer>(new LegacyFieldSuppressor("CJT0061"))));
        }

        Document document = project.AddDocument("Settings.cs", LegacySettingsClass());
        Solution solution = document.Project.Solution;

        DiagnosticCleanupResult result = await new DiagnosticCleanupEngine(Catalog).CleanupAsync(
            document,
            new DiagnosticCleanupOptions(new[] { DiagnosticCleanupCategory.AnalyzerFixes, DiagnosticCleanupCategory.CodeStyle, DiagnosticCleanupCategory.Formatting, DiagnosticCleanupCategory.Naming }),
            CancellationToken.None);

        Assert.Same(solution, result.OriginalSolution);
        Assert.Same(solution, result.ChangedSolution);
        Assert.True(result.IsComplete);
        Assert.Empty(result.Unresolved);
    }

    [Fact]
    public async Task CleanupAsync_DiagnosticSuppressedByASuppressor_IsNeitherFixedNorReported()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace(new LegacyFieldAnalyzer("CJT0062", "Performance"), new LegacyFieldSuppressor("CJT0062"));
        workspace.ConfigureRuleSeverity("CJT0062", "warning");
        DocumentId documentId = workspace.AddDocument("Settings.cs", LegacySettingsClass());
        Solution solution = workspace.CreateSolution();

        DiagnosticCleanupResult result = await CleanupAsync(solution, documentId, new RenameLegacyFieldCodeFixProvider("CJT0062"));

        Assert.Same(solution, result.ChangedSolution);
        Assert.Empty(result.AppliedFixes);
        Assert.Empty(result.Unresolved);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("Gate.cs")]
    public async Task CleanupAsync_AnalyzerConfigOverridesForADocumentWithoutAnAbsolutePath_Throws(string filePath)
    {
        using AdhocWorkspace workspace = new AdhocWorkspace();
        ProjectId projectId = ProjectId.CreateNewId();
        DocumentId documentId = DocumentId.CreateNewId(projectId);
        Solution solution = workspace.CurrentSolution
            .AddProject(projectId, "Bare", "Bare", LanguageNames.CSharp)
            .AddDocument(documentId, "Gate.cs", Microsoft.CodeAnalysis.Text.SourceText.From(UnbracedGate()), filePath: filePath);

        System.InvalidOperationException exception = await Assert.ThrowsAsync<System.InvalidOperationException>(() => CleanupWithOverridesAsync(solution, documentId, BracesOverrides));

        Assert.Contains("'Gate.cs'", exception.Message);
    }

    [Theory]
    [InlineData("")]
    [InlineData("root = true\n\n[*.cs]\ncsharp_prefer_braces = false:silent")]
    public async Task CleanupAsync_AnalyzerConfigOverrides_AppendToAnyExistingEditorConfigWithoutChangingIt(string editorConfig)
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace();
        workspace.AddEditorConfig(string.Empty, editorConfig);
        DocumentId documentId = workspace.AddDocument("Gate.cs", UnbracedGate());

        DiagnosticCleanupResult result = await CleanupWithOverridesAsync(workspace.CreateSolution(), documentId, BracesOverrides);

        Assert.Equal(BracedGate(), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
        AnalyzerConfigDocument config = result.ChangedSolution.GetDocument(documentId).Project.AnalyzerConfigDocuments.Single();
        Assert.Equal(editorConfig, (await config.GetTextAsync(CancellationToken.None)).ToString());
    }

    [Fact]
    public async Task CleanupAsync_SameAnalyzerTypeReferencedTwice_ReportsEachDiagnosticOnce()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace(new LegacyFieldAnalyzer("CJT0063", "Performance"), new LegacyFieldAnalyzer("CJT0063", "Performance"));
        workspace.ConfigureRuleSeverity("CJT0063", "warning");
        DocumentId documentId = workspace.AddDocument("Settings.cs", LegacySettingsClass());

        DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, DiagnosticCleanupCategory.AnalyzerFixes);

        UnresolvedRoslynDiagnostic unresolved = result.Unresolved.Single();
        Assert.Equal("CJT0063", unresolved.DiagnosticId);
        Assert.Equal(UnresolvedDiagnosticReason.NoCodeFixProvider, unresolved.Reason);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task CleanupAsync_AnalyzerWithBrokenSupportedDiagnostics_IsSkippedAndOtherFixesStillApply(bool throws)
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace(new BrokenDescriptorsAnalyzer(throws), new LegacyFieldAnalyzer("CJT0064", "Performance"));
        workspace.ConfigureRuleSeverity("CJT0064", "warning");
        DocumentId documentId = workspace.AddDocument("Settings.cs", LegacySettingsClass());

        DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, new RenameLegacyFieldCodeFixProvider("CJT0064"));

        Assert.Equal(LegacySettingsClass().Replace("legacyValue", "renamedValue"), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
        Assert.True(result.IsComplete);
    }

    [Fact]
    public async Task CleanupAsync_AnalyzerWhoseSupportedDiagnosticsThrow_IsReportedAsAnIssue()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace(new BrokenDescriptorsAnalyzer(throws: true), new LegacyFieldAnalyzer("CJT0064", "Performance"));
        workspace.ConfigureRuleSeverity("CJT0064", "warning");
        DocumentId documentId = workspace.AddDocument("Settings.cs", LegacySettingsClass());

        DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, new RenameLegacyFieldCodeFixProvider("CJT0064"));

        string issue = Assert.Single(result.AnalyzerFailures);
        Assert.Contains("BrokenDescriptorsAnalyzer", issue);
        Assert.Contains("InvalidOperationException: Broken analyzer.", issue);
    }

    [Fact]
    public async Task CleanupAsync_AnalyzerThatThrowsWhileAnalyzing_IsReportedAsAnIssueAndOtherFixesStillApply()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace(new ThrowingAnalysisAnalyzer(), new LegacyFieldAnalyzer("CJT0064", "Performance"));
        workspace.ConfigureRuleSeverity("CJT0064", "warning");
        DocumentId documentId = workspace.AddDocument("Settings.cs", LegacySettingsClass());

        DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, new RenameLegacyFieldCodeFixProvider("CJT0064"));

        Assert.Equal(LegacySettingsClass().Replace("legacyValue", "renamedValue"), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
        string issue = Assert.Single(result.AnalyzerFailures);
        Assert.Contains("ThrowingAnalysisAnalyzer", issue);
        Assert.Contains("InvalidOperationException: Analysis exploded.", issue);
    }

    [Fact]
    public async Task CleanupAsync_WhenAnAnalyzerAssemblyCouldNotBeLoaded_ADiagnosticWithoutAFixSaysSo()
    {
        using DiagnosticCleanupTestWorkspace workspace = CreateLegacySettingsWorkspace("CJT0076", out DocumentId documentId);
        CodeFixProviderCatalog catalog = new CodeFixProviderCatalog(hostReferences: new AnalyzerReference[] { new AnalyzerFileReference(System.IO.Path.Combine(System.IO.Path.GetTempPath(), "Missing.Analyzers.dll"), new MissingAssemblyLoader()) });

        DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, 50, catalog, DiagnosticCleanupCategory.AnalyzerFixes);

        UnresolvedRoslynDiagnostic unresolved = result.Unresolved.Single();
        Assert.Equal(UnresolvedDiagnosticReason.NoCodeFixProvider, unresolved.Reason);
        Assert.Contains("Missing.Analyzers.dll could not be loaded", unresolved.Detail);
    }

    [Fact]
    public async Task CleanupAsync_ProviderWithoutDeclaredFixableIds_IsIgnoredAndOtherProvidersStillFix()
    {
        using DiagnosticCleanupTestWorkspace workspace = CreateLegacySettingsWorkspace("CJT0065", out DocumentId documentId);
        CodeFixProviderCatalog catalog = new CodeFixProviderCatalog(new CodeFixProvider[] { new UndeclaredIdsCodeFixProvider(), new RenameLegacyFieldCodeFixProvider("CJT0065") });

        DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, 50, catalog, DiagnosticCleanupCategory.AnalyzerFixes);

        Assert.Equal(LegacySettingsClass().Replace("legacyValue", "renamedValue"), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
        Assert.Equal("RenameLegacyFieldCodeFixProvider", result.AppliedFixes.Single().ProviderName);
    }

    [Fact]
    public async Task CleanupAsync_AnalyzerAlsoReportingACompilerCategoryRule_OnlyTheNonCompilerRuleIsActionable()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace(new LegacyFieldAnalyzer(("CJT0066", "Performance"), ("CJT0067", "Compiler")));
        workspace.ConfigureRuleSeverity("CJT0066", "warning");
        workspace.ConfigureRuleSeverity("CJT0067", "warning");
        DocumentId documentId = workspace.AddDocument("Settings.cs", LegacySettingsClass());

        DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, DiagnosticCleanupCategory.AnalyzerFixes);

        Assert.Equal("CJT0066", result.Unresolved.Single().DiagnosticId);
    }

    [Fact]
    public async Task CleanupAsync_GroupRejectedInAnEarlierPass_IsNotRetriedWhileOtherFixesContinue()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace(new LegacyFieldAnalyzer(("CJT0068", "Performance"), ("CJT0069", "Performance")));
        workspace.ConfigureRuleSeverity("CJT0068", "warning");
        workspace.ConfigureRuleSeverity("CJT0069", "warning");
        DocumentId documentId = workspace.AddDocument("Settings.cs", TwoLegacyFieldsClass());
        CodeFixProviderCatalog catalog = new CodeFixProviderCatalog(new CodeFixProvider[] { new BreakingLegacyFieldCodeFixProvider("CJT0068"), new RenameLegacyFieldCodeFixProvider("CJT0069") });

        DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, 50, catalog, DiagnosticCleanupCategory.AnalyzerFixes);

        Assert.Equal(TwoLegacyFieldsClass().Replace("legacy", "renamed"), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
        AppliedDiagnosticFix applied = result.AppliedFixes.Single();
        Assert.Equal("CJT0069", applied.DiagnosticId);
        Assert.Equal(2, applied.Count);
        Assert.Equal("RenameLegacyFieldCodeFixProvider", applied.ProviderName);
        Assert.True(result.IsComplete);
    }

    [Fact]
    public async Task CleanupAsync_DiagnosticIdsFilter_FixesOnlyTheIncludedIdOfAnAnalyzerReportingSeveral()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace(new LegacyFieldAnalyzer(("CJT0073", "Performance"), ("CJT0074", "Performance")));
        workspace.ConfigureRuleSeverity("CJT0073", "warning");
        workspace.ConfigureRuleSeverity("CJT0074", "warning");
        DocumentId documentId = workspace.AddDocument("Settings.cs", LegacySettingsClass());
        DiagnosticCleanupEngine engine = new DiagnosticCleanupEngine(
            new CodeFixProviderCatalog(new CodeFixProvider[] { new BatchRenameLegacyFieldCodeFixProvider("CJT0073"), new RenameLegacyFieldCodeFixProvider("CJT0074") }));

        DiagnosticCleanupResult result = await engine.CleanupAsync(
            workspace.CreateSolution().GetDocument(documentId),
            new DiagnosticCleanupOptions(new[] { DiagnosticCleanupCategory.AnalyzerFixes }, diagnosticIds: new[] { "CJT0074" }),
            CancellationToken.None);

        Assert.Equal(LegacySettingsClass().Replace("legacyValue", "renamedValue"), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
        AppliedDiagnosticFix applied = result.AppliedFixes.Single();
        Assert.Equal("CJT0074", applied.DiagnosticId);
        Assert.Equal("RenameLegacyFieldCodeFixProvider", applied.ProviderName);
        Assert.Empty(result.Unresolved);
        Assert.True(result.IsComplete);
    }

    [Fact]
    public async Task CleanupAsync_FixWithoutAnyOperation_ReportsNoApplicableCodeAction()
    {
        using DiagnosticCleanupTestWorkspace workspace = CreateLegacySettingsWorkspace("CJT0070", out DocumentId documentId);
        Solution solution = workspace.CreateSolution();
        CustomOperationsLegacyFieldCodeFixProvider provider = new CustomOperationsLegacyFieldCodeFixProvider("CJT0070", (_, _, _) => new CodeActionOperation[0]);

        DiagnosticCleanupResult result = await CleanupAsync(solution, documentId, provider);

        Assert.Same(solution, result.ChangedSolution);
        Assert.True(result.IsComplete);
        Assert.Equal(UnresolvedDiagnosticReason.NoApplicableCodeAction, result.Unresolved.Single().Reason);
    }

    [Theory]
    [InlineData("AddProject")]
    [InlineData("RemoveProject")]
    [InlineData("AddSolutionAnalyzerReference")]
    [InlineData("RemoveSolutionAnalyzerReference")]
    [InlineData("RenameDocument")]
    [InlineData("MoveDocumentFile")]
    [InlineData("MakeDocumentAScript")]
    public async Task CleanupAsync_FixChangingMoreThanDocumentTexts_IsRejectedAsUnsupported(string change)
    {
        using DiagnosticCleanupTestWorkspace workspace = CreateLegacySettingsWorkspace("CJT0071", out DocumentId documentId);
        Solution solution = workspace.CreateSolution();
        CustomOperationsLegacyFieldCodeFixProvider provider = new CustomOperationsLegacyFieldCodeFixProvider(
            "CJT0071",
            (_, _, renamed) => new CodeActionOperation[] { new ApplyChangesOperation(ChangeMoreThanText(renamed, documentId, change)) });

        DiagnosticCleanupResult result = await CleanupAsync(solution, documentId, provider);

        Assert.Same(solution, result.ChangedSolution);
        Assert.False(result.IsComplete);
        Assert.Equal(UnresolvedDiagnosticReason.FixRejectedUnsupportedChanges, result.Unresolved.Single().Reason);
    }

    [Fact]
    public async Task CleanupAsync_CustomFixAllProvider_OnlySeesTheGroupDiagnosticsOfTheCleanedDocument()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace(new LegacyFieldAnalyzer("CJT0072", "Performance"));
        workspace.ConfigureRuleSeverity("CJT0072", "warning");
        DocumentId documentId = workspace.AddDocument("Settings.cs", TwoLegacyFieldsClass());
        DocumentId otherDocumentId = workspace.AddDocument("Other.cs", Lines("class Other", "{", "    public int legacyOther;", "}"));
        Solution solution = workspace.CreateSolution().AddProject("Unrelated", "Unrelated", LanguageNames.CSharp).Solution;
        ProbingFixAllLegacyFieldCodeFixProvider provider = new ProbingFixAllLegacyFieldCodeFixProvider("CJT0072");

        DiagnosticCleanupResult result = await CleanupAsync(solution, documentId, provider);

        Assert.Equal(new[] { "document Other.cs: 0", "document Settings.cs: 2", "project-only: 0", "all TestProject: 2", "all Unrelated: 0" }, provider.Observations.Take(5).ToArray());
        Assert.Equal(TwoLegacyFieldsClass().Replace("legacy", "probed"), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
        Assert.Equal(Lines("class Other", "{", "    public int legacyOther;", "}"), await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, otherDocumentId));
    }

    [Fact]
    public async Task CleanupAsync_TopLevelStatementsFile_RenamesFieldsOfTheTypesAfterTheStatementsOnly()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace();
        workspace.AddEditorConfig(string.Empty, EditorConfig(PrivateFieldsPrefixRule("m_", "pascal_case")));
        DocumentId documentId = workspace.AddDocument("Program.cs", "using System;\r\n\r\nvar counter = new Counter();\r\nint local = Twice(counter.Next());\r\n\r\nstatic int Twice(int value) => value * 2;\r\n\r\n/// <summary>Counts.</summary>\r\nclass Counter\r\n{\r\n    // count is the state\r\n    private int count;\r\n\r\n    public int Next() => ++count + \"private int count;\".Length;\r\n}\r\n");

        DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, DiagnosticCleanupCategory.Naming);

        Assert.Equal("using System;\r\n\r\nvar counter = new Counter();\r\nint local = Twice(counter.Next());\r\n\r\nstatic int Twice(int value) => value * 2;\r\n\r\n/// <summary>Counts.</summary>\r\nclass Counter\r\n{\r\n    // count is the state\r\n    private int m_Count;\r\n\r\n    public int Next() => ++m_Count + \"private int count;\".Length;\r\n}\r\n", await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
        Assert.True(result.IsComplete);
    }

    private static Solution ChangeMoreThanText(Solution renamed, DocumentId documentId, string change)
    {
        switch (change)
        {
            case "AddProject":
                return renamed.AddProject("Extra", "Extra", LanguageNames.CSharp).Solution;

            case "RemoveProject":
                return renamed.RemoveProject(documentId.ProjectId);

            case "AddSolutionAnalyzerReference":
                return renamed.AddAnalyzerReference(new AnalyzerImageReference(ImmutableArray.Create<DiagnosticAnalyzer>(new AnalysisProbeAnalyzer())));

            case "RemoveSolutionAnalyzerReference":
                return renamed.RemoveAnalyzerReference(renamed.AnalyzerReferences.First());

            case "RenameDocument":
                return renamed.WithDocumentName(documentId, "Renamed.cs");

            case "MoveDocumentFile":
                return renamed.WithDocumentFilePath(documentId, DiagnosticCleanupTestWorkspace.GetPath("Moved/Settings.cs"));

            case "MoveDocumentToFolder":
                return renamed.WithDocumentFolders(documentId, new[] { "Moved" });

            default:
                return renamed.WithDocumentSourceCodeKind(documentId, SourceCodeKind.Script);
        }
    }

    private static readonly IReadOnlyDictionary<string, string> BracesOverrides = new Dictionary<string, string>
    {
        ["end_of_line"] = "lf",
        ["csharp_prefer_braces"] = "true:suggestion",
        ["dotnet_diagnostic.IDE0011.severity"] = "suggestion",
    };

    private static Task<DiagnosticCleanupResult> CleanupWithOverridesAsync(Solution solution, DocumentId documentId, IReadOnlyDictionary<string, string> overrides)
        => new DiagnosticCleanupEngine(Catalog).CleanupAsync(
            solution.GetDocument(documentId),
            new DiagnosticCleanupOptions(new[] { DiagnosticCleanupCategory.CodeStyle }, analyzerConfigOverrides: overrides),
            CancellationToken.None);

    private static string UnbracedGate() => Lines(
        "class Gate",
        "{",
        "    int Check(bool open)",
        "    {",
        "        if (open)",
        "            return 1;",
        "        return 0;",
        "    }",
        "}");

    private static string BracedGate() => Lines(
        "class Gate",
        "{",
        "    int Check(bool open)",
        "    {",
        "        if (open)",
        "        {",
        "            return 1;",
        "        }",
        "",
        "        return 0;",
        "    }",
        "}");

    private static async Task AssertExplicitTypeRuleOutcomeAsync(string[] editorConfigProperties, bool expectChange)
    {
        string input = Lines(
            "class Calculator",
            "{",
            "    int Compute()",
            "    {",
            "        var count = 1;",
            "        return count;",
            "    }",
            "}");
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace();
        workspace.AddEditorConfig(string.Empty, EditorConfig(editorConfigProperties));
        DocumentId documentId = workspace.AddDocument("Calculator.cs", input);

        DiagnosticCleanupResult result = await CleanupAsync(workspace.CreateSolution(), documentId, DiagnosticCleanupCategory.CodeStyle);

        string expected = expectChange ? input.Replace("var count", "int count") : input;
        Assert.Equal(expected, await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
        Assert.Equal(expectChange, result.HasChanges);
        Assert.Empty(result.Unresolved);
    }

    private static Task<DiagnosticCleanupResult> CleanupAsync(Solution solution, DocumentId documentId, params DiagnosticCleanupCategory[] categories)
        => CleanupAsync(solution, documentId, 50, Catalog, categories);

    private static Task<DiagnosticCleanupResult> CleanupAsync(Solution solution, DocumentId documentId, int maxPasses, CodeFixProviderCatalog catalog, params DiagnosticCleanupCategory[] categories)
    {
        DiagnosticCleanupEngine engine = new DiagnosticCleanupEngine(catalog);

        return engine.CleanupAsync(solution.GetDocument(documentId), new DiagnosticCleanupOptions(categories, maxPasses), CancellationToken.None);
    }

    private static Task<DiagnosticCleanupResult> CleanupAsync(Solution solution, DocumentId documentId, CodeFixProvider hostProvider)
        => CleanupAsync(solution, documentId, 50, new CodeFixProviderCatalog(new[] { hostProvider }), DiagnosticCleanupCategory.AnalyzerFixes);

    private static DiagnosticCleanupTestWorkspace CreateLegacySettingsWorkspace(string diagnosticId, out DocumentId documentId)
    {
        DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace(new LegacyFieldAnalyzer(diagnosticId, "Performance"));
        workspace.ConfigureRuleSeverity(diagnosticId, "warning");
        documentId = workspace.AddDocument("Settings.cs", LegacySettingsClass());

        return workspace;
    }

    private static (DiagnosticCleanupTestWorkspace Workspace, DocumentId DocumentId) CreateNamingAndFormattingWorkspace()
    {
        DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace();
        workspace.AddEditorConfig(string.Empty, EditorConfig(PrivateFieldsPrefixRule("m_", "pascal_case").Concat(UseBraceOnSameLine).ToArray()));
        DocumentId documentId = workspace.AddDocument("Widget.cs", Lines(
            "class Widget",
            "{",
            "    private int size;",
            "",
            "    int Measure()",
            "    {",
            "        return size;",
            "    }",
            "}"));

        return (workspace, documentId);
    }

    private static string[] PrivateFieldsPrefixRule(string prefix, string capitalization, string severity = "warning") => new[]
    {
        "dotnet_naming_rule.private_fields_rule.symbols = private_fields",
        "dotnet_naming_rule.private_fields_rule.style = prefix_style",
        "dotnet_naming_rule.private_fields_rule.severity = " + severity,
        "dotnet_naming_symbols.private_fields.applicable_kinds = field",
        "dotnet_naming_symbols.private_fields.applicable_accessibilities = private",
        "dotnet_naming_style.prefix_style.required_prefix = " + prefix,
        "dotnet_naming_style.prefix_style.capitalization = " + capitalization,
    };

    private static string[] VarPreference(bool useVar, string diagnosticId, string severity)
    {
        string value = useVar ? "true" : "false";

        return new[]
        {
            "csharp_style_var_for_built_in_types = " + value,
            "csharp_style_var_when_type_is_apparent = " + value,
            "csharp_style_var_elsewhere = " + value,
            "dotnet_diagnostic." + diagnosticId + ".severity = " + severity,
        };
    }

    private static string CounterClass(string className) => Lines(
        "class " + className,
        "{",
        "    private int count;",
        "",
        "    public int Get()",
        "    {",
        "        return count;",
        "    }",
        "}");

    private static string TripleFieldClass() => Lines(
        "class Triple",
        "{",
        "    private int first;",
        "    private int second;",
        "    private int third;",
        "",
        "    public int Sum()",
        "    {",
        "        return first + second + third;",
        "    }",
        "}");

    private static DiagnosticCleanupTestWorkspace CreateTwoLegacyFieldsWorkspace(string diagnosticId, out DocumentId documentId)
    {
        DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace(new LegacyFieldAnalyzer(diagnosticId, "Performance"));
        workspace.ConfigureRuleSeverity(diagnosticId, "warning");
        documentId = workspace.AddDocument("Settings.cs", TwoLegacyFieldsClass());

        return workspace;
    }

    private static string TwoLegacyFieldsClass() => Lines(
        "class Settings",
        "{",
        "    public int legacyValue;",
        "    public int legacyLimit;",
        "}");

    private static string LegacySettingsClass() => Lines(
        "class Settings",
        "{",
        "    public int legacyValue;",
        "}");

    private static string EditorConfig(params string[] properties)
        => Lines(new[] { "root = true", string.Empty, "[*.cs]" }.Concat(properties).ToArray());

    private static string Lines(params string[] lines) => string.Join("\n", lines) + "\n";

    // A test double handed to the workspace as an instance; the analyzer-authoring rules about shipping compiler
    // extensions do not apply.
#pragma warning disable RS1036, RS1038, RS1041, RS2008

    /// <summary>
    /// Throws with a multi-line message while registering its fixes.
    /// </summary>
    private sealed class MultiLineThrowingLegacyFieldCodeFixProvider : LegacyFieldCodeFixProviderBase
    {
        public MultiLineThrowingLegacyFieldCodeFixProvider(string diagnosticId)
            : base(diagnosticId)
        {
        }

        public override System.Threading.Tasks.Task RegisterCodeFixesAsync(CodeFixContext context)
            => throw new System.InvalidOperationException("first line\r\nsecond line\nthird line");
    }

    /// <summary>
    /// Casts a value to a type it does not have, like a third-party provider with a bug, while registering its fixes or
    /// while computing the registered fix.
    /// </summary>
    private sealed class CastBugLegacyFieldCodeFixProvider : LegacyFieldCodeFixProviderBase
    {
        private readonly bool _failsWhileRegistering;

        public CastBugLegacyFieldCodeFixProvider(string diagnosticId, bool failsWhileRegistering)
            : base(diagnosticId)
        {
            _failsWhileRegistering = failsWhileRegistering;
        }

        public override System.Threading.Tasks.Task RegisterCodeFixesAsync(CodeFixContext context)
        {
            object document = context.Document;
            if (_failsWhileRegistering)
            {
                _ = (SyntaxNode)document;
            }

            context.RegisterCodeFix(
                CodeAction.Create("Rename", _ => System.Threading.Tasks.Task.FromResult((Document)(object)context.Span.ToString()), "CastBugLegacyField"),
                context.Diagnostics);

            return System.Threading.Tasks.Task.CompletedTask;
        }
    }

    /// <summary>
    /// Throws a <see cref="System.MissingMethodException" /> (a Roslyn binding failure of the host) at the chosen step.
    /// </summary>
    private sealed class BindingFailureLegacyFieldCodeFixProvider : LegacyFieldCodeFixProviderBase
    {
        private readonly FixAllFailure _failingStep;

        public BindingFailureLegacyFieldCodeFixProvider(string diagnosticId, FixAllFailure failingStep)
            : base(diagnosticId)
        {
            _failingStep = failingStep;
        }

        public override FixAllProvider GetFixAllProvider() => _failingStep switch
        {
            FixAllFailure.GetFixAllProvider => throw new System.MissingMethodException("GetFixAllProvider"),
            FixAllFailure.GetFixAsync => new ThrowingFixAllProvider(),
            _ => null,
        };

        public override async System.Threading.Tasks.Task RegisterCodeFixesAsync(CodeFixContext context)
        {
            if (_failingStep == FixAllFailure.None)
            {
                throw new System.MissingMethodException("RegisterCodeFixesAsync");
            }

            string name = await GetFieldNameAsync(context.Document, context.Span, context.CancellationToken);
            context.RegisterCodeFix(
                CodeAction.Create("Rename", ct => RenameDeclaratorAsync(context.Document, context.Span, ReplaceLegacyPrefix(name, "renamed"), ct), "BindingFailureLegacyField"),
                context.Diagnostics);
        }

        private sealed class ThrowingFixAllProvider : FixAllProvider
        {
            public override System.Collections.Generic.IEnumerable<FixAllScope> GetSupportedFixAllScopes() => new[] { FixAllScope.Document };

            public override System.Threading.Tasks.Task<CodeAction> GetFixAsync(FixAllContext fixAllContext) => throw new System.MissingMethodException("GetFixAsync");
        }
    }

    /// <summary>
    /// Throws while registering its fixes and counts how often it was asked.
    /// </summary>
    private sealed class CountingThrowingLegacyFieldCodeFixProvider : LegacyFieldCodeFixProviderBase
    {
        public CountingThrowingLegacyFieldCodeFixProvider(string diagnosticId)
            : base(diagnosticId)
        {
        }

        public int RegisterCalls { get; private set; }

        public override System.Threading.Tasks.Task RegisterCodeFixesAsync(CodeFixContext context)
        {
            RegisterCalls++;

            throw new System.InvalidOperationException("Registration failed");
        }
    }

    /// <summary>
    /// Reports every source field whose name starts with <c>legacy</c> with a rule that is hidden by default, like
    /// the refactoring-only rules of the IDE analyzers.
    /// </summary>
    [DiagnosticAnalyzer(LanguageNames.CSharp)]
    private sealed class HiddenLegacyFieldAnalyzer : DiagnosticAnalyzer
    {
        private readonly DiagnosticDescriptor _descriptor;

        public HiddenLegacyFieldAnalyzer(string diagnosticId)
        {
            _descriptor = new DiagnosticDescriptor(
                diagnosticId,
                "Legacy field",
                "Field '{0}' uses the legacy prefix",
                "Performance",
                DiagnosticSeverity.Hidden,
                isEnabledByDefault: true);
        }

        public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(_descriptor);

        public override void Initialize(AnalysisContext context)
        {
            context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
            context.EnableConcurrentExecution();
            context.RegisterSymbolAction(
                symbolContext =>
                {
                    if (symbolContext.Symbol.Name.StartsWith("legacy", System.StringComparison.Ordinal))
                    {
                        symbolContext.ReportDiagnostic(Diagnostic.Create(_descriptor, symbolContext.Symbol.Locations[0], symbolContext.Symbol.Name));
                    }
                },
                SymbolKind.Field);
        }
    }

    private sealed class MissingAssemblyLoader : IAnalyzerAssemblyLoader
    {
        public void AddDependencyLocation(string fullPath)
        {
        }

        public System.Reflection.Assembly LoadFromPath(string fullPath) => throw new System.IO.FileNotFoundException("The assembly is gone.", fullPath);
    }

#pragma warning restore RS1036, RS1038, RS1041, RS2008
}
