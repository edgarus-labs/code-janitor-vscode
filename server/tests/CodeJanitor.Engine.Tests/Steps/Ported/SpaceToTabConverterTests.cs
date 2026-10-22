#nullable disable
using System;
using System.Linq;
using CodeJanitor.Engine.Steps.Transformations;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;
using Assert = CodeJanitor.Engine.Tests.Steps.Support.MsAssert;

namespace CodeJanitor.Engine.Tests.Steps;

/// <summary>
/// Unit tests for <see cref="SpaceToTabConverter" /> (<c>indent_style = tab</c>): leading indentation spaces become
/// tabs, while lines starting inside multi-line string literals, disabled text or multi-line comments keep their text.
/// </summary>
public sealed class SpaceToTabConverterTests
{
    [Fact]
    public void FullIndentationLevels_BecomeTabs()
    {
        string input = "class C\n{\n    void M()\n    {\n        int x;\n    }\n}\n";
        string expected = "class C\n{\n\tvoid M()\n\t{\n\t\tint x;\n\t}\n}\n";

        Assert.AreEqual(expected, new SpaceToTabConverter(4).Convert(input));
    }

    [Fact]
    public void RemainderSpaces_AreKeptAfterTheTabs_AndMixedIndentationIsMeasuredByTabStops()
    {
        string input = "class C\n{\n    int x =\n          1;\n  \tint y;\n\t  int z;\n}\n";
        string expected = "class C\n{\n\tint x =\n\t\t  1;\n\tint y;\n\t  int z;\n}\n";

        Assert.AreEqual(expected, new SpaceToTabConverter(4).Convert(input));
    }

    [Fact]
    public void TabSize_DecidesHowManySpacesMakeATab()
    {
        string input = "class C\n{\n  int x;\n     int y;\n}\n";
        string expected = "class C\n{\n\tint x;\n\t\t int y;\n}\n";

        Assert.AreEqual(expected, new SpaceToTabConverter(2).Convert(input));
    }

    [Fact]
    public void CrLfLineBreaks_ArePreserved()
    {
        string input = "class C\r\n{\r\n    int x;\r\n}\r\n";
        string expected = "class C\r\n{\r\n\tint x;\r\n}\r\n";

        Assert.AreEqual(expected, new SpaceToTabConverter(4).Convert(input));
    }

    [Fact]
    public void LinesInsideMultiLineStringLiterals_AreUntouched()
    {
        string input =
            "class C\r\n" +
            "{\r\n" +
            "    string Verbatim = @\"first\r\n" +
            "        second\";\r\n" +
            "\r\n" +
            "    string Raw = \"\"\"\r\n" +
            "        raw\r\n" +
            "            indented\r\n" +
            "        \"\"\";\r\n" +
            "\r\n" +
            "    string InterpolatedRaw(int x) => $\"\"\"\r\n" +
            "        {x} raw\r\n" +
            "        \"\"\";\r\n" +
            "}\r\n";
        string expected =
            "class C\r\n" +
            "{\r\n" +
            "\tstring Verbatim = @\"first\r\n" +
            "        second\";\r\n" +
            "\r\n" +
            "\tstring Raw = \"\"\"\r\n" +
            "        raw\r\n" +
            "            indented\r\n" +
            "        \"\"\";\r\n" +
            "\r\n" +
            "\tstring InterpolatedRaw(int x) => $\"\"\"\r\n" +
            "        {x} raw\r\n" +
            "        \"\"\";\r\n" +
            "}\r\n";

        string result = new SpaceToTabConverter(4).Convert(input);

        Assert.AreEqual(expected, result);
        Assert.AreSequenceEqual(GetStringValues(input), GetStringValues(result));
    }

    [Fact]
    public void DisabledTextAndMultiLineCommentContinuationLines_AreUntouched()
    {
        string input = "class C\n{\n#if NEVER\n    int disabled;\n#endif\n    /*\n     * comment\n     */\n    int x;\n}\n";
        string expected = "class C\n{\n#if NEVER\n    int disabled;\n#endif\n\t/*\n     * comment\n     */\n\tint x;\n}\n";

        Assert.AreEqual(expected, new SpaceToTabConverter(4).Convert(input));
    }

    [Fact]
    public void SpacesAfterTheIndentationAndOnBlankLines_AreUntouched()
    {
        string input = "class C\n{\n    int  x = 1;    // aligned\n        \n    /// <summary>\n    /// Doc.\n    /// </summary>\n    int y;\n}\n";
        string expected = "class C\n{\n\tint  x = 1;    // aligned\n        \n\t/// <summary>\n\t/// Doc.\n\t/// </summary>\n\tint y;\n}\n";

        Assert.AreEqual(expected, new SpaceToTabConverter(4).Convert(input));
    }

    [Fact]
    public void TabIndentedSource_ReturnsTheSameInstance()
    {
        string input = "class C\n{\n\tint x;\n\t  int y;\n}\n";

        Assert.AreSame(input, new SpaceToTabConverter(4).Convert(input));
    }

    [Fact]
    public void NullOrEmpty_ReturnsInput()
    {
        SpaceToTabConverter converter = new SpaceToTabConverter(4);

        Assert.IsNull(converter.Convert(null));
        Assert.AreEqual(string.Empty, converter.Convert(string.Empty));
    }

    [Fact]
    public void TabSizeBelowOne_Throws() => Assert.ThrowsExactly<ArgumentOutOfRangeException>(() => new SpaceToTabConverter(0));

    [Fact]
    public void AsSourceTransformation_HasANameAndAppliesTheConversion()
    {
        ISourceTransformation transformation = new SpaceToTabConverter(4);

        Assert.AreEqual("Convert spaces to tabs", transformation.Name);
        Assert.AreEqual("class C\n{\n\tint x;\n}\n", transformation.Apply("class C\n{\n    int x;\n}\n"));
    }

    [Fact]
    public void TopLevelStatementsFileWithLambdaRegionAndDocumentationComments_IsIndentedWithTabs()
    {
        string input =
            "using System;\r\n\r\nRun(() =>\r\n{\r\n    Console.WriteLine();\r\n});\r\n\r\n" +
            "class C\r\n{\r\n    #region R\r\n    /// <summary>\r\n    /// Doc\r\n    /// </summary>\r\n    void M() { }\r\n    #endregion\r\n}\r\n";
        string expected =
            "using System;\r\n\r\nRun(() =>\r\n{\r\n\tConsole.WriteLine();\r\n});\r\n\r\n" +
            "class C\r\n{\r\n\t#region R\r\n\t/// <summary>\r\n\t/// Doc\r\n\t/// </summary>\r\n\tvoid M() { }\r\n\t#endregion\r\n}\r\n";

        Assert.AreEqual(expected, new SpaceToTabConverter(4).Convert(input));
    }

    [Fact]
    public void FileWithSyntaxErrors_IndentationIsStillConverted() => Assert.AreEqual("class C {\r\n\tvoid M( {\r\n", new SpaceToTabConverter(4).Convert("class C {\r\n    void M( {\r\n"));

    private static string[] GetStringValues(string source)
        => CSharpSyntaxTree.ParseText(source).GetRoot().DescendantTokens()
            .Where(token => token.IsKind(SyntaxKind.StringLiteralToken)
                || token.IsKind(SyntaxKind.MultiLineRawStringLiteralToken)
                || token.IsKind(SyntaxKind.InterpolatedStringTextToken)
                || token.IsKind(SyntaxKind.InterpolatedRawStringEndToken))
            .Select(token => token.Text)
            .ToArray();
}
