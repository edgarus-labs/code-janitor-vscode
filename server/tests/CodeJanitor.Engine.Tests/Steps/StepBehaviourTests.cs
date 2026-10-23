using System.Text.Json.Nodes;
using CodeJanitor.Engine.Contracts;
using CodeJanitor.Engine.Steps;
using CodeJanitor.Engine.Tests.Steps.Support;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace CodeJanitor.Engine.Tests.Steps;

/// <summary>What Code Janitor's own steps do through <see cref="ICleanupStep" />, gated by their settings.</summary>
public sealed class StepBehaviourTests
{
    private static JsonObject On(params string[] keys) => StepHarness.AllOff(new JsonObject(keys.Select(key => KeyValuePair.Create(key, (JsonNode?)true))));

    private static Dictionary<string, string> EditorConfig(params (string Key, string Value)[] entries) => entries.ToDictionary(entry => entry.Key, entry => entry.Value);

    [Fact]
    public void Steps_AreDiscoverable_WithDistinctPositions()
    {
        Assert.True(StepHarness.Steps.Count >= 25);
        Assert.Equal(StepHarness.Steps.Count, StepHarness.Steps.Select(step => (step.Stage, step.Order)).Distinct().Count());
    }

    [Fact]
    public async Task AllOff_LeavesTextUnchanged_ButEnsuresTheFinalNewline()
    {
        Assert.Equal("class C\n{\n\n    int x;   \n}\n", await StepHarness.CleanAsync("class C\n{\n\n    int x;   \n}", On()));
    }

    [Fact]
    public async Task RemoveByteOrderMark_DropsThePreamble()
    {
        Assert.Equal("class C { }\n", await StepHarness.CleanAsync("\uFEFFclass C { }\n", On("removeByteOrderMark")));
        Assert.Equal("\uFEFFclass C { }\n", await StepHarness.CleanAsync("\uFEFFclass C { }\n", On()));
    }

    [Fact]
    public async Task Charset_DecidesTheByteOrderMark()
    {
        Assert.Equal("\uFEFFclass C { }\n", await StepHarness.CleanAsync("\uFEFFclass C { }\n", On("removeByteOrderMark"), EditorConfig(("charset", "utf-8-bom"))));
        Assert.Equal("\uFEFFclass C { }\n", await StepHarness.CleanAsync("class C { }\n", On(), EditorConfig(("charset", "utf-8-bom"))));
        Assert.Equal("class C { }\n", await StepHarness.CleanAsync("\uFEFFclass C { }\n", On(), EditorConfig(("charset", "utf-8"))));
        Assert.Equal("\uFEFFclass C { }\n", await StepHarness.CleanAsync("\uFEFFclass C { }\n", On("removeByteOrderMark"), EditorConfig(("charset", "latin1"))));
    }

    [Fact]
    public async Task RemoveRegions_OnTheFirstLineAfterAByteOrderMark()
    {
        Assert.Equal("class C { }\n", await StepHarness.CleanAsync("\uFEFF#region R\nclass C { }\n#endregion\n", On("removeRegions", "removeByteOrderMark")));
        Assert.Equal("\uFEFFclass C { }\n", await StepHarness.CleanAsync("\uFEFF#region R\nclass C { }\n#endregion\n", On("removeRegions")));
    }

    [Fact]
    public async Task TrimTrailingWhitespace_FromEditorConfig_DecidesOverTheSetting()
    {
        Assert.Equal("class C\n{\n    int x;\n}\n", await StepHarness.CleanAsync("class C\n{\n    int x;   \n}\n", On("removeEndOfLineWhitespace")));
        Assert.Equal("class C\n{\n    int x;   \n}\n", await StepHarness.CleanAsync("class C\n{\n    int x;   \n}\n", On("removeEndOfLineWhitespace"), EditorConfig(("trim_trailing_whitespace", "false"))));
        Assert.Equal("class C\n{\n    int x;\n}\n", await StepHarness.CleanAsync("class C\n{\n    int x;   \n}\n", On(), EditorConfig(("trim_trailing_whitespace", "true"))));
    }

    [Fact]
    public async Task InsertFinalNewlineFalse_RemovesTheFinalNewline_AndBlankLinesAtBottom()
    {
        Assert.Equal("class C { }", await StepHarness.CleanAsync("class C { }\n\n\n", On("removeBlankLinesAtBottom"), EditorConfig(("insert_final_newline", "false"))));
        Assert.Equal("class C { }\r\n", await StepHarness.CleanAsync("class C { }\r\n\r\n\r\n", On("removeBlankLinesAtBottom")));
    }

    [Fact]
    public async Task IndentStyle_ConvertsIndentation()
    {
        Assert.Equal("class C\n{\n    int x;\n}\n", await StepHarness.CleanAsync("class C\n{\n\tint x;\n}\n", On(), EditorConfig(("indent_style", "space"))));
        Assert.Equal("class C\n{\n\tint x;\n}\n", await StepHarness.CleanAsync("class C\n{\n  int x;\n}\n", On(), EditorConfig(("indent_style", "tab"), ("indent_size", "2"))));
    }

    [Fact]
    public async Task BlankLinesAfterDocumentationComments_AreAlwaysRemoved()
    {
        Assert.Equal("class C\n{\n    /// <summary>X</summary>\n    void M() { }\n}\n", await StepHarness.CleanAsync("class C\n{\n    /// <summary>X</summary>\n\n    void M() { }\n}\n", On()));
    }

    [Theory]
    [InlineData("documentStart", "insert", "// H\nusing System;\n\nclass C { }\n")]
    [InlineData("afterUsings", "insert", "using System;\n\n// H\n\nclass C { }\n")]
    public async Task FileHeader_InsertsAtThePosition(string position, string mode, string expected)
    {
        var settings = On();
        settings["fileHeaderCSharp"] = "// H";
        settings["fileHeaderPosition"] = position;
        settings["fileHeaderUpdateMode"] = mode;

        var output = await StepHarness.CleanAsync("using System;\n\nclass C { }\n", settings);

        Assert.Equal(expected, output);
        Assert.Equal(output, await StepHarness.CleanAsync(output, settings));
    }

    [Fact]
    public async Task FileHeader_ReplaceMode_ReplacesTheExistingHeader_AndNumbersWork()
    {
        var settings = On();
        settings["fileHeaderCSharp"] = "// New";
        settings["fileHeaderUpdateMode"] = 1;

        Assert.Equal("// New\nclass C { }\n", await StepHarness.CleanAsync("// Old\nclass C { }\n", settings));
    }

    [Fact]
    public async Task FileHeaderTemplate_FromEditorConfig_IsTheHeader()
    {
        Assert.Equal(
            "// Copyright Test.cs\n//\n// MIT\nclass C { }\n",
            await StepHarness.CleanAsync("class C { }\n", On(), EditorConfig(("file_header_template", "Copyright {fileName}\\n\\nMIT"))));
    }

    [Fact]
    public async Task SealClasses_WhenTheSettingOrAnEnforcedCA1852AsksForIt()
    {
        const string Source = "internal class Animal { }\n";
        Assert.Equal("internal sealed class Animal { }\n", await StepHarness.CleanAsync(Source, On("sealClassesWhenSafe")));
        Assert.Equal("internal sealed class Animal { }\n", await StepHarness.CleanAsync(Source, On(), EditorConfig(("dotnet_diagnostic.ca1852.severity", "warning"))));
        Assert.Equal(Source, await StepHarness.CleanAsync(Source, On()));
    }

    [Fact]
    public async Task SealClasses_AnEnforcedCA1852Alone_SealsOnlyTheClassesNotVisibleOutsideTheAssembly()
    {
        const string Source = "public class Animal { }\ninternal class Plant { }\nclass Stone { }\n";
        var ca1852 = EditorConfig(("dotnet_diagnostic.ca1852.severity", "warning"));

        Assert.Equal("public class Animal { }\ninternal sealed class Plant { }\nsealed class Stone { }\n", await StepHarness.CleanAsync(Source, On(), ca1852));
        Assert.Equal("public sealed class Animal { }\ninternal sealed class Plant { }\nsealed class Stone { }\n", await StepHarness.CleanAsync(Source, On("sealClassesWhenSafe"), ca1852));
        Assert.Equal("public sealed class Animal { }\ninternal sealed class Plant { }\nsealed class Stone { }\n", await StepHarness.CleanAsync(Source, On("sealClassesWhenSafe")));
    }

    [Fact]
    public async Task PatternMatchingNullChecks_BeforeCSharp9_ReportsTheInequalitiesLeftUnchanged()
    {
        const string Source = "class C { bool M(object o) => o != null; }\n";
        var document = StepHarness.Document(Source);
        document = document.Project.WithParseOptions(new CSharpParseOptions(LanguageVersion.CSharp8)).GetDocument(document.Id)!;

        var outcome = await new CleanupEngine([new PatternMatchingNullChecksStep()]).CleanupAsync(document, new CleanupRequest(On("convertToPatternMatchingNullChecks"), [], null), CancellationToken.None);

        Assert.Equal(Source, await StepHarness.TextOfAsync(outcome.Solution.GetDocument(document.Id)!));
        Assert.Contains(outcome.Issues, issue => issue.StartsWith("'!= null' checks were left unchanged: 'is not null' patterns need C# 9", StringComparison.Ordinal));
    }

    [Fact]
    public async Task PatternMatchingNullChecks_FromCSharp9_ReportsNothing()
    {
        var document = StepHarness.Document("class C { bool M(object o) => o != null; }\n");

        var outcome = await new CleanupEngine([new PatternMatchingNullChecksStep()]).CleanupAsync(document, new CleanupRequest(On("convertToPatternMatchingNullChecks"), [], null), CancellationToken.None);

        Assert.Equal("class C { bool M(object o) => o is not null; }\n", await StepHarness.TextOfAsync(outcome.Solution.GetDocument(document.Id)!));
        Assert.Empty(outcome.Issues);
    }

    [Fact]
    public async Task EndOfLine_ConvertsEveryLineBreak()
    {
        Assert.Equal("class C\n{\n}\n", await StepHarness.CleanAsync("class C\r\n{\r}\r\n", On(), EditorConfig(("end_of_line", "lf"))));
        Assert.Equal("class C\r\n{\r\n}\r\n", await StepHarness.CleanAsync("class C\n{\n}\n", On(), EditorConfig(("end_of_line", "crlf"))));
    }

    [Fact]
    public async Task StringFormat_EscapedBracesAreNotPlaceholders()
    {
        var output = await StepHarness.CleanAsync("class C { string M(int a) => string.Format(\"{{0}} {0}\", a); }\n", On("convertStringFormatToInterpolation"));

        Assert.Equal("class C { string M(int a) => $\"{{0}} {a}\"; }\n", output);
    }

    [Theory]
    [InlineData("System.Diagnostics.Debug.Assert(ok, string.Format(\"{0}\", Compute()))")]
    [InlineData("System.Diagnostics.Debug.WriteLineIf(ok, string.Format(\"{0}\", Compute()))")]
    [InlineData("System.Diagnostics.Debug.Assert(ok, (string.Format(\"{0}\", Compute())))")]
    [InlineData("new System.Text.StringBuilder().Append(string.Format(\"{0}\", Compute()))")]
    public async Task StringFormat_PassedWhereAnInterpolatedStringHandlerOverloadExists_IsUnchanged(string call)
    {
        var source = $"class C {{ void M(bool ok) => {call}; string Compute() => \"\"; }}\n";

        Assert.Equal(source, await StepHarness.CleanAsync(source, On("convertStringFormatToInterpolation")));
    }

    [Fact]
    public async Task StringFormat_PassedWhereNoInterpolatedStringHandlerOverloadExists_IsConverted()
    {
        var output = await StepHarness.CleanAsync("class C { void M() => System.Console.WriteLine(string.Format(\"{0}\", Compute())); string Compute() => \"\"; }\n", On("convertStringFormatToInterpolation"));

        Assert.Equal("class C { void M() => System.Console.WriteLine($\"{Compute()}\"); string Compute() => \"\"; }\n", output);
    }

    [Theory]
    [InlineData("object[] a", "string.Format(\"{0}\", a)")]
    [InlineData("string[] a", "string.Format(\"{0}\", a)")]
    [InlineData("object[] a", "string.Format(\"{0} {{x}}\", a)")]
    [InlineData("object[] a", "string.Format(\"{0}\", (object[])a)")]
    [InlineData("object[] a", "string.Format(\"{0}\", null)")]
    public async Task StringFormat_AnArrayPassedAsTheArguments_IsNotAnInterpolationHole(string parameter, string call)
    {
        var source = $"class C {{ string M({parameter}) => {call}; }}\n";

        Assert.Equal(source, await StepHarness.CleanAsync(source, On("convertStringFormatToInterpolation")));
    }

    [Theory]
    [InlineData("int[] a", "string.Format(\"{0}\", a)", "$\"{a}\"")]
    [InlineData("object a", "string.Format(\"{0}\", a)", "$\"{a}\"")]
    [InlineData("object[] a", "string.Format(\"{0} {1}\", a[0], a[1])", "$\"{a[0]} {a[1]}\"")]
    [InlineData("object[] a", "string.Format(\"{0}\", a[0])", "$\"{a[0]}\"")]
    public async Task StringFormat_ValuesListedOneByOne_AreStillConverted(string parameter, string call, string expected)
    {
        var output = await StepHarness.CleanAsync($"class C {{ string M({parameter}) => {call}; }}\n", On("convertStringFormatToInterpolation"));

        Assert.Equal($"class C {{ string M({parameter}) => {expected}; }}\n", output);
    }

    [Fact]
    public async Task ARewriteThatAddsACompilerError_IsRejected()
    {
        var document = StepHarness.Document("class C { int M() => 1; }\n");
        var settings = StepHarness.Settings(On());

        var solution = await new BreakingStep().ApplyAsync(document, settings, CancellationToken.None);

        Assert.Equal("class C { int M() => 1; }\n", (await solution.GetDocument(document.Id)!.GetTextAsync()).ToString());
    }

    [Fact]
    public async Task MultiLineAccessors_GetABlankLineBetweenThem()
    {
        const string Source = "class C\n{\n    int P\n    {\n        get\n        {\n            return 1;\n        }\n        set\n        {\n        }\n    }\n}\n";

        var output = await StepHarness.CleanAsync(Source, On("insertBlankLinePaddingBetweenPropertiesMultiLineAccessors"));

        Assert.Contains("            return 1;\n        }\n\n        set\n", output, StringComparison.Ordinal);
        Assert.Equal(output, await StepHarness.CleanAsync(output, On("insertBlankLinePaddingBetweenPropertiesMultiLineAccessors")));
    }

    [Fact]
    public async Task BlankLineSteps_KeepEachLineEnding()
    {
        const string Source = "class C\r\n{\r\n\r\n    void M() { }\n\n}\r\n";

        Assert.Equal("class C\r\n{\r\n    void M() { }\r\n}\r\n", await StepHarness.CleanAsync(Source, On("removeBlankLinesAfterOpeningBrace", "removeBlankLinesBeforeClosingBrace")));
    }

    [Fact]
    public async Task FormatComments_WrapsAtTheConfiguredColumn()
    {
        var settings = On("formatComments");
        settings["commentFormat"] = new JsonObject { ["wrapColumn"] = 30 };

        var output = await StepHarness.CleanAsync("class C\n{\n    //one two three four five six seven eight\n    void M() { }\n}\n", settings);

        Assert.Equal("class C\n{\n    // one two three four five\n    // six seven eight\n    void M() { }\n}\n", output);
        Assert.Equal(output, await StepHarness.CleanAsync(output, settings));
    }

    [Fact]
    public async Task EveryStepTogether_IsIdempotent()
    {
        var settings = StepHarness.AllOff();
        foreach (var key in settings.Select(pair => pair.Key).ToList())
        {
            if (settings[key] is JsonValue value && value.GetValueKind() == System.Text.Json.JsonValueKind.False)
            {
                settings[key] = true;
            }
        }

        settings["fileHeaderCSharp"] = "// Header";
        const string Source = "\uFEFF\r\n\r\nusing System;\r\nnamespace N\r\n{\r\n    #region Members\r\n    [Serializable]\r\n\r\n    public class C   \r\n    {\r\n\r\n        private string _name;\r\n        public string Name { get { return _name; } set\r\n            {\r\n                _name = value;\r\n            }\r\n        }\r\n        //comment\r\n        public void M(object o)\r\n        {\r\n            if (o == null)\r\n            {\r\n                throw new ArgumentNullException(\"o\");\r\n            }\r\n            var s = string.Format(\"{0}\", o);\r\n            switch (s)\r\n            {\r\n                case \"a\":\r\n                    break;\r\n                case \"b\":\r\n                    break;\r\n            }\r\n            return;\r\n        }\r\n\r\n    }\r\n    #endregion\r\n}\r\n\r\n\r\n";

        var once = await StepHarness.CleanAsync(Source, settings);
        var twice = await StepHarness.CleanAsync(once, settings);

        Assert.Equal(once, twice);
        Assert.DoesNotContain("#region", once, StringComparison.Ordinal);
        Assert.StartsWith("// Header", once, StringComparison.Ordinal);
    }

    /// <summary>A step whose rewrite does not compile.</summary>
    private sealed class BreakingStep : SourceTextStep
    {
        public override string Name => "Breaks the code";

        public override string? RuleId => null;

        public override CleanupStage Stage => CleanupStage.Semantic;

        public override int Order => 999;

        protected override bool RejectsNewCompilerErrors => true;

        protected override string Transform(string source, Document document, IEffectiveSettings settings) => source.Replace("=> 1", "=> \"1\"", StringComparison.Ordinal);
    }
}
