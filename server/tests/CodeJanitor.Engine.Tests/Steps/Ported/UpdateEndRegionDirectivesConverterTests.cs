#nullable disable
using CodeJanitor.Engine.Steps.Transformations;
using Xunit;
using Assert = CodeJanitor.Engine.Tests.Steps.Support.MsAssert;

namespace CodeJanitor.Engine.Tests.Steps;

public sealed class UpdateEndRegionDirectivesConverterTests
{
    private UpdateEndRegionDirectivesConverter _converter;

    public UpdateEndRegionDirectivesConverterTests() => _converter = new UpdateEndRegionDirectivesConverter();

    [Fact]
    public void EmptySource_ReturnsUnchanged()
    {
        string source = "";
        string result = _converter.Apply(source);
        Assert.AreEqual(source, result);
    }

    [Fact]
    public void NullSource_ReturnsUnchanged()
    {
        string result = _converter.Apply(null);
        Assert.IsNull(result);
    }

    [Fact]
    public void NoRegions_ReturnsUnchanged()
    {
        string source = "public class MyClass\r\n{\r\n}\r\n";
        string result = _converter.Apply(source);
        Assert.AreEqual(source, result);
    }

    [Fact]
    public void SingleRegionWithoutName_UpdatesEndregionCorrectly()
    {
        string source = "public class MyClass\r\n{\r\n    #region\r\n    public void MyMethod() { }\r\n    #endregion\r\n}\r\n";
        string result = _converter.Apply(source);
        // Empty region name should result in just "#endregion"
        Assert.Contains("#endregion\r\n", result);
    }

    [Fact]
    public void SingleRegionWithName_UpdatesEndregionToMatchRegionName()
    {
        string source = "public class MyClass\r\n{\r\n    #region MyRegion\r\n    public void MyMethod() { }\r\n    #endregion WrongName\r\n}\r\n";
        string result = _converter.Apply(source);
        Assert.Contains("#endregion MyRegion", result);
    }

    [Fact]
    public void MultipleRegions_UpdatesAllEndregionsCorrectly()
    {
        string source = "public class MyClass\r\n{\r\n    #region Fields\r\n    private int _field;\r\n    #endregion\r\n\r\n    #region Methods\r\n    public void MyMethod() { }\r\n    #endregion\r\n}\r\n";
        string result = _converter.Apply(source);
        Assert.Contains("#endregion Fields", result);
        Assert.Contains("#endregion Methods", result);
    }

    [Fact]
    public void NestedRegions_UpdatesAllEndregionsInStack()
    {
        string source = "#region Outer\r\n#region Inner\r\npublic class MyClass { }\r\n#endregion\r\n#endregion\r\n";
        string result = _converter.Apply(source);
        Assert.Contains("#endregion Inner", result);
        Assert.Contains("#endregion Outer", result);
    }

    [Fact]
    public void RegionWithWhitespaceNormalization_NormalizesWhitespace()
    {
        string source = "#region   MyRegion   \r\ncode\r\n#endregion\r\n";
        string result = _converter.Apply(source);
        // The region name is trimmed, so we should have "#endregion MyRegion"
        Assert.Contains("#endregion MyRegion", result);
    }

    [Fact]
    public void PreservesIndentation()
    {
        string source = "public class MyClass\r\n{\r\n        #region Fields\r\n        private int _field;\r\n        #endregion OldName\r\n}\r\n";
        string result = _converter.Apply(source);
        // Should preserve the 8-space indentation
        Assert.Contains("        #endregion Fields", result);
    }

    [Fact]
    public void MismatchedRegions_KeepsLineAsIs()
    {
        // More endregions than regions - the extra endregion should be kept as-is
        string source = "#region Fields\r\n#endregion WrongName1\r\n#endregion WrongName2\r\n";
        string result = _converter.Apply(source);
        // First endregion should be updated, second should be kept
        Assert.Contains("#endregion Fields", result);
        Assert.Contains("#endregion WrongName2", result);
    }

    [Fact]
    public void RegionWithTrailingSpaceButNoName_EndregionLosesItsStaleName()
    {
        string source = Lines("class C", "{", "    #region ", "    int _x;", "    #endregion Old", "}");

        Assert.AreEqual(Lines("class C", "{", "    #region ", "    int _x;", "    #endregion", "}"), _converter.Apply(source));
    }

    [Fact]
    public void TabIndentedNestedRegionsInTopLevelProgram_AreNamedByTheirRegion_AndOtherLinesStayUnchanged()
    {
        string source = Lines(
            "using System;",
            "#region Startup",
            "Console.WriteLine(\"#endregion\");",
            "#if DEBUG",
            "\t#region Debug helpers",
            "\tstatic void Log() { }",
            "\t#endregion",
            "#endif",
            "#endregion Wrong // comment",
            "record R(int X);");
        string expected = Lines(
            "using System;",
            "#region Startup",
            "Console.WriteLine(\"#endregion\");",
            "#if DEBUG",
            "\t#region Debug helpers",
            "\tstatic void Log() { }",
            "\t#endregion Debug helpers",
            "#endif",
            "#endregion Startup // comment",
            "record R(int X);");

        Assert.AreEqual(expected, _converter.Apply(source));
    }

    [Fact]
    public void AlreadyMatchingEndregions_AreUnchanged()
    {
        string source = Lines("#region A", "  #region B", "  #endregion B", "#endregion A", string.Empty);

        Assert.AreEqual(source, _converter.Apply(source));
    }

    [Theory]
    [InlineData("#region A\r\nclass C { }\r\n#endregion\r\n", "#region A\r\nclass C { }\r\n#endregion A\r\n")]
    [InlineData("#region A\nclass C { }\n#endregion\n", "#region A\nclass C { }\n#endregion A\n")]
    [InlineData("#region A\rclass C { }\r#endregion\r", "#region A\rclass C { }\r#endregion A\r")]
    [InlineData("#region A\nclass C { }\r\n#endregion", "#region A\nclass C { }\r\n#endregion A")]
    public void Apply_KeepsTheLineEndingsOfTheFile(string source, string expected) => Assert.AreEqual(expected, _converter.Apply(source));

    [Fact]
    public void NamelessNestedRegion_GetsItsOwnEndregion_AndTheOuterKeepsItsName() => Assert.AreEqual(
            "#region Outer\n#region\nclass C { }\n#endregion\n#endregion Outer\n",
            _converter.Apply("#region Outer\n#region\nclass C { }\n#endregion\n#endregion\n"));

    [Fact]
    public void RegionNameSeparatedByATab_IsUsedForTheEndregion() => Assert.AreEqual(
            "#region\tTabbed\nclass C { }\n#endregion Tabbed\n",
            _converter.Apply("#region\tTabbed\nclass C { }\n#endregion\n"));

    [Theory]
    [InlineData("#region A\n#regionX\n#endregionY\n#endregion\n", "#region A\n#regionX\n#endregionY\n#endregion A\n")]
    [InlineData("#region   Padded name  \t\n \t#endregion trailing\n", "#region   Padded name  \t\n \t#endregion Padded name\n")]
    [InlineData("#region A\n#endregion", "#region A\n#endregion A")]
    public void Apply_MatchesWholeKeywordsOnly(string source, string expected) => Assert.AreEqual(expected, _converter.Apply(source));

    [Theory]
    [InlineData(
        "#region A\nclass C\n{\n    string s = @\"\n#endregion keep me\n\";\n}\n#endregion\n",
        "#region A\nclass C\n{\n    string s = @\"\n#endregion keep me\n\";\n}\n#endregion A\n")]
    [InlineData(
        "#region A\nclass C\n{\n    string s = \"\"\"\n        #region inner\n        #endregion keep me\n        \"\"\";\n}\n#endregion\n",
        "#region A\nclass C\n{\n    string s = \"\"\"\n        #region inner\n        #endregion keep me\n        \"\"\";\n}\n#endregion A\n")]
    [InlineData(
        "#region A\nclass C\n{\n    /*\n    #endregion keep me\n    */\n}\n#endregion\n",
        "#region A\nclass C\n{\n    /*\n    #endregion keep me\n    */\n}\n#endregion A\n")]
    public void RegionTextInsideStringsAndComments_IsNotTreatedAsADirective(string source, string expected) => Assert.AreEqual(expected, _converter.Apply(source));

    [Theory]
    [InlineData("#region A\nclass C { }\n#endregion // end of A\n", "#region A\nclass C { }\n#endregion A // end of A\n")]
    [InlineData("#region A\nclass C { }\n#endregion Wrong // end of A\n", "#region A\nclass C { }\n#endregion A // end of A\n")]
    [InlineData("#region A\nclass C { }\n#endregion//end\r\n", "#region A\nclass C { }\n#endregion A //end\r\n")]
    [InlineData("#region\nclass C { }\n#endregion  // end\n", "#region\nclass C { }\n#endregion // end\n")]
    [InlineData("#region A\nclass C { }\n#endregion A // end of A\n", "#region A\nclass C { }\n#endregion A // end of A\n")]
    public void ACommentAfterEndregion_IsKept(string source, string expected)
    {
        Assert.AreEqual(expected, _converter.Apply(source));
        Assert.AreEqual(expected, _converter.Apply(expected));
    }

    private static string Lines(params string[] lines) => string.Join(System.Environment.NewLine, lines);

    [Fact]
    public void RegionLinesInsideVerbatimStringOfInactiveBranch_AreKept()
    {
        string source = Lines("#if DEBUG", "const string T = @\"", "#region X", "x", "#endregion Old", "\";", "#endif", string.Empty);

        Assert.AreEqual(source, _converter.Apply(source));
    }
}
