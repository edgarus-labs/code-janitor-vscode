#nullable disable
using System.Text;
using CodeJanitor.Engine.Steps.Transformations;
using Xunit;
using Assert = CodeJanitor.Engine.Tests.Steps.Support.MsAssert;

namespace CodeJanitor.Engine.Tests.Steps;

public sealed class RegionDirectiveRemoverTests
{
    private RegionDirectiveRemover _remover;

    public RegionDirectiveRemoverTests() => _remover = new RegionDirectiveRemover();

    [Fact]
    public void Name_ReturnsCorrectName() => Assert.AreEqual("Remove region directives", _remover.Name);

    [Fact]
    public void NullOrEmpty_ReturnsOriginal()
    {
        Assert.IsNull(_remover.Apply(null));
        Assert.AreEqual(string.Empty, _remover.Apply(string.Empty));
    }

    [Fact]
    public void RemovesRegionsAndEndRegions_PreservesCode()
    {
        string input = @"#region MyRegion
public class C
{
    public void M() { }
}
";
        string expected = @"public class C
{
    public void M() { }
}
";
        string result = _remover.Apply(input);
        Assert.AreEqual(expected, result);
    }

    [Theory]
    [InlineData(
        "using System;\r\n\r\n#region Startup\r\nConsole.WriteLine(\"#region\");\r\n#endregion\r\n\r\nstatic void Local() { }\r\n",
        "using System;\r\n\r\nConsole.WriteLine(\"#region\");\r\n\r\nstatic void Local() { }\r\n")]
    [InlineData(
        "namespace N;\n\n\t#region Fields\n\tclass C { }\n\t#endregion Fields\n",
        "namespace N;\n\n\tclass C { }\n")]
    [InlineData(
        "class C\r\n{\r\n#if DEBUG\r\n    #region Debug\r\n    void M() { }\r\n    #endregion\r\n#endif\r\n#pragma warning disable CS0169\r\n    int _x;\r\n}\r\n#endregion",
        "class C\r\n{\r\n#if DEBUG\r\n    void M() { }\r\n#endif\r\n#pragma warning disable CS0169\r\n    int _x;\r\n}\r\n")]
    [InlineData(
        "class C\r\n{\r\n    // #region not a directive\r\n    string s = \"#endregion\";\r\n    #regionless\r\n}\r\n",
        "class C\r\n{\r\n    // #region not a directive\r\n    string s = \"#endregion\";\r\n    #regionless\r\n}\r\n")]
    [InlineData("   \r\n", "   \r\n")]
    public void Apply_RemovesOnlyRegionDirectiveLines(string input, string expected) => Assert.AreEqual(expected, _remover.Apply(input));

    [Theory]
    [InlineData("class C\n{\n    string s = @\"\n#region keep me\n\";\n}\n")]
    [InlineData("class C\n{\n    string s = \"\"\"\n        #endregion keep me\n        \"\"\";\n}\n")]
    [InlineData("class C\n{\n    string s = $@\"\n#region {1}\n\";\n}\n")]
    [InlineData("class C\n{\n    /*\n    #region keep me\n    */\n}\n")]
    public void Apply_DoesNotRemoveLinesInsideStringLiteralsOrComments(string input) => Assert.AreEqual(input, _remover.Apply(input));

    [Fact]
    public void Apply_CarriageReturnOnlyLineEndings_RemovesTheDirectiveLines() => Assert.AreEqual("class C { }\r", _remover.Apply("#region A\rclass C { }\r#endregion\r"));

    [Theory]
    [InlineData("#regionX\r\n#region_x\r\n#endregions\r\n#endregion1\r\n# region A\r\n#reg\r\n#\r\n", "#regionX\r\n#region_x\r\n#endregions\r\n#endregion1\r\n# region A\r\n#reg\r\n#\r\n")]
    [InlineData("#region\r\n#region\tA\r\n \t#endregion\r\nx", "x")]
    [InlineData("x\r\n#region", "x\r\n")]
    public void Apply_MatchesOnlyWholeRegionKeywords(string input, string expected) => Assert.AreEqual(expected, _remover.Apply(input));

    [Fact]
    public void RegionLinesInsideVerbatimStringOfInactiveBranch_AreKept()
    {
        string input = "#if DEBUG\r\nconst string T = @\"\r\n#region X\r\nx\r\n#endregion\r\n\";\r\n#endif\r\n";

        Assert.AreEqual(input, _remover.Apply(input));
    }

    [Fact]
    public void DeeplyNestedInactiveBranches_AreScannedInLinearTimeAndKeepRegionLinesInsideLiterals()
    {
        const int Depth = 20;
        StringBuilder input = new System.Text.StringBuilder();
        for (int i = 0; i < Depth; i++)
        {
            input.Append("#if NEVER_").Append(i).Append("\r\n");
        }

        input.Append("const string T = @\"\r\n#region keep me\r\n\";\r\n#region drop me\r\n");
        for (int i = 0; i < Depth; i++)
        {
            input.Append("#endif\r\n");
        }

        string expected = input.ToString().Replace("#region drop me\r\n", string.Empty);

        Assert.AreEqual(expected, _remover.Apply(input.ToString()));
    }
}
