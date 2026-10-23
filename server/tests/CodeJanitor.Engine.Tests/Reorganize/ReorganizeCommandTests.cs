using System.Text.Json.Nodes;
using CodeJanitor.Engine.Queries;
using CodeJanitor.Engine.Reorganize;
using Xunit;
using static CodeJanitor.Engine.Tests.Reorganize.ReorganizeHarness;

namespace CodeJanitor.Engine.Tests.Reorganize;

/// <summary>The <c>reorganize</c> command and the <c>reorganizeReport</c> dry run the extension asks first.</summary>
public sealed class ReorganizeCommandTests
{
    private const string WithConditional = "class C\n{\n    void B() { }\n#if DEBUG\n    void Debug() { }\n#endif\n    int _f;\n}\n";

    private static async Task<string> ExecuteAsync(string source, JsonObject settings, JsonObject? arguments = null)
    {
        var document = await DocumentAsync(source);
        var solution = await new ReorganizeCommand().ExecuteAsync(document, EngineSettings(settings), arguments, CancellationToken.None);

        return (await solution.GetDocument(document.Id)!.GetTextAsync()).ToString();
    }

    private static async Task<JsonObject> ReportAsync(string source, JsonObject settings, JsonObject? arguments = null)
    {
        var document = await DocumentAsync(source);

        return (await new ReorganizeReportQuery().QueryAsync(document, EngineSettings(settings), arguments, CancellationToken.None))!.AsObject();
    }

    private static JsonObject NoPadding(JsonObject? reorganize = null)
    {
        var settings = new JsonObject { ["reorganize"] = reorganize ?? [] };
        foreach (var key in ReorganizeCleanup.Defaults.Keys.Where(key => key.StartsWith("insertBlankLinePadding", StringComparison.Ordinal)))
        {
            settings[key] = false;
        }

        return settings;
    }

    [Fact]
    public async Task ReorganizesTheDocumentWithTheReorganizeSettingsAndTheCleanupPadding()
    {
        var source = "class C\n{\n    void B() { }\n    void A() { }\n    int _f;\n}\n";

        Assert.Equal("class C\n{\n    int _f;\n    void A() { }\n    void B() { }\n}\n", await ExecuteAsync(source, NoPadding()));
        Assert.Equal("class C\n{\n    int _f;\n\n    void A() { }\n\n    void B() { }\n}\n", await ExecuteAsync(source, new JsonObject()));
        Assert.Equal("class C\n{\n    int _f;\n    void B() { }\n    void A() { }\n}\n", await ExecuteAsync(source, NoPadding(new JsonObject { ["alphabetizeMembersOfTheSameGroup"] = false })));
    }

    [Fact]
    public async Task LeavesAFileWithConditionalsAloneUnlessTheArgumentsOrTheSettingSayYes()
    {
        Assert.Equal(WithConditional, await ExecuteAsync(WithConditional, NoPadding()));
        Assert.Equal(WithConditional, await ExecuteAsync(WithConditional, NoPadding(new JsonObject { ["performWhenPreprocessorConditionals"] = "yes" }), new JsonObject { ["performWhenPreprocessorConditionals"] = "no" }));
        Assert.StartsWith("class C\n{\n    int _f;", await ExecuteAsync(WithConditional, NoPadding(), new JsonObject { ["performWhenPreprocessorConditionals"] = "yes" }));
        Assert.StartsWith("class C\n{\n    int _f;", await ExecuteAsync(WithConditional, NoPadding(new JsonObject { ["performWhenPreprocessorConditionals"] = "yes" })));
    }

    [Fact]
    public async Task ReportsAFileTheConditionalsPolicyBlocksAndWhatTheCommandWouldChange()
    {
        var blocked = await ReportAsync(WithConditional, NoPadding());
        var allowed = await ReportAsync(WithConditional, NoPadding(), new JsonObject { ["performWhenPreprocessorConditionals"] = "yes" });

        Assert.Equal("""{"blockedByPreprocessor":true,"changed":false,"skipped":[]}""", blocked.ToJsonString());
        Assert.Equal("""{"blockedByPreprocessor":false,"changed":true,"skipped":[]}""", allowed.ToJsonString());
    }

    [Fact]
    public async Task ReportsTheTypesItHadToLeaveAlone()
    {
        var report = await ReportAsync("class C { void B() { } int A; }\nclass D\n{\n    void B() { }\n    int A;\n}\n", NoPadding());

        Assert.True(report["changed"]!.GetValue<bool>());
        Assert.Equal("C (line 1): skipped because of more than one member on a line", Assert.Single(report["skipped"]!.AsArray())!.GetValue<string>());
    }

    [Fact]
    public async Task KeepsTheEncodingOfTheDocument()
    {
        var document = await DocumentAsync("class C\n{\n    void B() { }\n    int _f;\n}\n");
        document = document.WithText(Microsoft.CodeAnalysis.Text.SourceText.From("class C\n{\n    void B() { }\n    int _f;\n}\n", new System.Text.UTF8Encoding(true)));
        var solution = await new ReorganizeCommand().ExecuteAsync(document, EngineSettings(NoPadding()), null, CancellationToken.None);
        var text = await solution.GetDocument(document.Id)!.GetTextAsync();

        Assert.Equal("class C\n{\n    int _f;\n    void B() { }\n}\n", text.ToString());
        Assert.Equal(3, text.Encoding!.GetPreamble().Length);
    }
}
