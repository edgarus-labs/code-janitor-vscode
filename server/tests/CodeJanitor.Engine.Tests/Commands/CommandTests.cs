using System.Text.Json.Nodes;
using CodeJanitor.Engine.Commands;
using CodeJanitor.Engine.Contracts;
using CodeJanitor.Engine.Settings;
using CodeJanitor.Engine.Tests.Steps.Support;
using Microsoft.CodeAnalysis;
using Xunit;

namespace CodeJanitor.Engine.Tests.Commands;

/// <summary>The document commands and the one-type-per-file step, on the testbed scenarios and on snippets.</summary>
public sealed class CommandTests
{
    private static async Task<(Solution Solution, string Text, IEffectiveSettings Settings, Document Document)> RunCommandAsync(IDocumentCommand command, JsonObject scenario, JsonObject? arguments = null)
    {
        var path = LocalTestbed.FilePath(scenario);
        var settings = EffectiveSettings.ForFile(path, StepHarness.AllOff());
        var document = StepHarness.Document(LocalTestbed.Text(scenario), path);
        var solution = await command.ExecuteAsync(document, settings, arguments, CancellationToken.None);

        return (solution, await StepHarness.TextOfAsync(solution.GetDocument(document.Id)!), settings, document);
    }

    private static string[] NewFileNames(Solution before, Solution after) => after.Projects.SelectMany(project => project.Documents)
        .Where(document => before.GetDocument(document.Id) is null)
        .Select(document => Path.GetFileName(document.FilePath!))
        .Order(StringComparer.Ordinal)
        .ToArray();

    [Fact]
    public async Task SplitTopLevelTypes_Scenario()
    {
        var scenario = LocalTestbed.Scenario("SplitTopLevelTypes");
        var (solution, text, _, document) = await RunCommandAsync(new SplitTopLevelTypesCommand(), scenario);

        Assert.Equal(string.Empty, LocalTestbed.Failures(scenario, text, []));
        Assert.Equal(scenario["createdFiles"]!.AsArray().Select(node => (string)node!).Order(StringComparer.Ordinal), NewFileNames(document.Project.Solution, solution));
        var again = await new SplitTopLevelTypesCommand().ExecuteAsync(solution.GetDocument(document.Id)!, StepHarness.Settings(StepHarness.AllOff()), null, CancellationToken.None);
        Assert.Empty(NewFileNames(solution, again));
    }

    [Fact]
    public async Task SplitTopLevelTypes_MovesStructsAndRecords_KeepsPartialTypes_AndTheTypeNamedLikeTheFile()
    {
        const string Source = "namespace N;\n\nstruct S { }\nrecord R(int A);\npartial class P { }\nclass Main { }\n";
        var document = StepHarness.Document(Source, "/src/Main.cs");

        var solution = await new SplitTopLevelTypesCommand().ExecuteAsync(document, StepHarness.Settings(StepHarness.AllOff()), null, CancellationToken.None);

        Assert.Equal("namespace N;\npartial class P { }\nclass Main { }\n", (await solution.GetDocument(document.Id)!.GetTextAsync()).ToString());
        Assert.Equal(["R.cs", "S.cs"], NewFileNames(document.Project.Solution, solution));
    }

    [Theory]
    [InlineData("EditorConfigSA1402SingleClassPerFile")]
    [InlineData("EditorConfigMA0048FileNameMatchesType")]
    public async Task OneTypePerFile_Scenario(string id)
    {
        var scenario = LocalTestbed.Scenario(id);
        var path = LocalTestbed.FilePath(scenario);
        var settings = EffectiveSettings.ForFile(path, StepHarness.AllOff());
        var document = StepHarness.Document(LocalTestbed.Text(scenario), path);

        var (solution, text) = await StepHarness.RunAsync(document, settings);

        Assert.Equal(string.Empty, LocalTestbed.Failures(scenario, text, []));
        Assert.Equal(scenario["createdFiles"]!.AsArray().Select(node => (string)node!).Order(StringComparer.Ordinal), NewFileNames(document.Project.Solution, solution));
        Assert.Equal(text, (await StepHarness.RunAsync(solution.GetDocument(document.Id)!, settings)).Text);
    }

    [Fact]
    public async Task OneTypePerFile_SA1649_IsReported_NotFixed()
    {
        var scenario = LocalTestbed.Scenario("EditorConfigSA1649FirstTypeMatchesFileName");
        var path = LocalTestbed.FilePath(scenario);
        var settings = EffectiveSettings.ForFile(path, StepHarness.AllOff());
        var document = StepHarness.Document(LocalTestbed.Text(scenario), path);
        var step = new OneTypePerFileStep();

        var (solution, issues) = await step.ApplyWithIssuesAsync(document, settings, CancellationToken.None);

        Assert.True(step.IsEnabled(settings));
        Assert.Same(document.Project.Solution, solution);
        Assert.Equal(string.Empty, LocalTestbed.Failures(scenario, LocalTestbed.Text(scenario), issues));
    }

    [Fact]
    public void OneTypePerFile_SA1402_MovesClassesOnly()
    {
        var settings = StepHarness.Settings(StepHarness.AllOff(), new Dictionary<string, string> { ["dotnet_diagnostic.sa1402.severity"] = "warning" });

        var outcome = OneTypePerFile.Plan("namespace N;\n\nclass Main { }\nclass Other { }\nenum E { A }\ninterface I { }\n", "/src/Main.cs", settings, []);

        Assert.Equal(["Other.cs"], outcome.Plan.NewFiles.Select(file => Path.GetFileName(file.FilePath)));
        Assert.Empty(outcome.Issues);
    }

    [Fact]
    public void OneTypePerFile_NeverOverwritesAnExistingFile_AndReportsIt()
    {
        var settings = StepHarness.Settings(StepHarness.AllOff(), new Dictionary<string, string> { ["dotnet_diagnostic.ma0048.severity"] = "error" });

        var outcome = OneTypePerFile.Plan("class Main { }\nclass Other { }\n", "/src/Main.cs", settings, ["Other.cs"]);

        Assert.False(outcome.Plan.HasChanges);
        Assert.Contains(outcome.Issues, issue => issue.StartsWith("MA0048 (error) line 2: type 'Other' was not moved", StringComparison.Ordinal));
    }

    [Fact]
    public async Task RemoveXmlDocumentation_Scenario()
    {
        var scenario = LocalTestbed.Scenario("RemoveXmlDocumentation");
        var (_, text, _, _) = await RunCommandAsync(new RemoveXmlDocumentationCommand(), scenario);

        Assert.Equal(string.Empty, LocalTestbed.Failures(scenario, text, []));
    }

    [Fact]
    public async Task RemoveRegions_InALineRange_Scenario()
    {
        var scenario = LocalTestbed.Scenario("RemoveRegion");
        var lines = scenario["lines"]!.AsArray();
        var (_, text, _, _) = await RunCommandAsync(new RemoveRegionsCommand(), scenario, new JsonObject { ["startLine"] = (int)lines[0]!, ["endLine"] = (int)lines[1]! });

        Assert.Equal(string.Empty, LocalTestbed.Failures(scenario, text, []));
        Assert.Contains("{\n    private static int Twice(int x) => x * 2;\n    public static string Run()", text.Replace("\r\n", "\n", StringComparison.Ordinal), StringComparison.Ordinal);
    }

    [Fact]
    public async Task RemoveRegions_OutsideTheRange_AreKept_AndWithoutRange_AllGo()
    {
        const string Source = "class C\n{\n    #region A\n    int a;\n    #endregion\n\n    #region B\n    int b;\n    #endregion\n}\n";
        var document = StepHarness.Document(Source);
        var settings = StepHarness.Settings(StepHarness.AllOff());

        var ranged = await new RemoveRegionsCommand().ExecuteAsync(document, settings, new JsonObject { ["startLine"] = 2, ["endLine"] = 4 }, CancellationToken.None);
        var all = await new RemoveRegionsCommand().ExecuteAsync(document, settings, null, CancellationToken.None);

        Assert.Equal("class C\n{\n    int a;\n    #region B\n    int b;\n    #endregion\n}\n", (await ranged.GetDocument(document.Id)!.GetTextAsync()).ToString());
        Assert.Equal("class C\n{\n    int a;\n\n    int b;\n}\n", (await all.GetDocument(document.Id)!.GetTextAsync()).ToString());
    }

    [Fact]
    public async Task RemoveRegions_AtALine_RemovesThatRegionOnly_KeepingNestedOnes()
    {
        const string Source = "class C\n{\n    #region Outer\n    #region Inner\n    int a;\n    #endregion\n    #endregion\n}\n";
        var document = StepHarness.Document(Source);

        var solution = await new RemoveRegionsCommand().ExecuteAsync(document, StepHarness.Settings(StepHarness.AllOff()), new JsonObject { ["line"] = 6 }, CancellationToken.None);

        Assert.Equal("class C\n{\n    #region Inner\n    int a;\n    #endregion\n}\n", (await solution.GetDocument(document.Id)!.GetTextAsync()).ToString());
    }

    [Fact]
    public async Task FormatComments_FormatsOnlyTheCommentsOfTheRange_WhateverTheSetting()
    {
        const string Source = "class C\n{\n    //first comment\n    void M() { }\n    //second comment\n}\n";
        var document = StepHarness.Document(Source);
        var settings = StepHarness.Settings(StepHarness.AllOff());

        var ranged = await new FormatCommentsCommand().ExecuteAsync(document, settings, new JsonObject { ["startLine"] = 4, ["endLine"] = 4 }, CancellationToken.None);
        var all = await new FormatCommentsCommand().ExecuteAsync(document, settings, null, CancellationToken.None);

        Assert.Equal("class C\n{\n    //first comment\n    void M() { }\n    // second comment\n}\n", (await ranged.GetDocument(document.Id)!.GetTextAsync()).ToString());
        Assert.Equal("class C\n{\n    // first comment\n    void M() { }\n    // second comment\n}\n", (await all.GetDocument(document.Id)!.GetTextAsync()).ToString());
    }

    [Fact]
    public async Task FormatComments_UsesCommentFormat()
    {
        var user = StepHarness.AllOff();
        user["commentFormat"] = new JsonObject { ["wrapColumn"] = 20, ["xmlSplitSummaryTagToMultipleLines"] = true };
        var document = StepHarness.Document("class C\n{\n    /// <summary>Does one two three four.</summary>\n    void M() { }\n}\n");

        var solution = await new FormatCommentsCommand().ExecuteAsync(document, StepHarness.Settings(user), null, CancellationToken.None);

        Assert.Equal(
            "class C\n{\n    /// <summary>\n    /// Does one two\n    /// three four.\n    /// </summary>\n    void M() { }\n}\n",
            (await solution.GetDocument(document.Id)!.GetTextAsync()).ToString());
    }
}
