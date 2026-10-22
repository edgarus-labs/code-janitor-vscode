#nullable disable
using CodeJanitor.Engine.Steps.Transformations;
using Xunit;
using Assert = CodeJanitor.Engine.Tests.Steps.Support.MsAssert;
using VsSettings = CodeJanitor.Engine.Tests.Steps.Support.VsSettings;

namespace CodeJanitor.Engine.Tests.Steps;

public sealed class CommentFormatConverterTests
{
    private CommentFormatConverter _converter;

    public CommentFormatConverterTests()
    {
        _converter = new CommentFormatConverter();
    }


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
    public void NoComments_ReturnsUnchanged()
    {
        string source = "public class MyClass { }";
        string result = _converter.Apply(source);
        Assert.AreEqual(source, result);
    }

    [Fact]
    public void SingleLineComment_NormalizesSpacing()
    {
        string source = "//  comment with extra spaces\r\npublic class MyClass { }";
        string result = _converter.Apply(source);
        // Should normalize to single space after //
        Assert.Contains("// comment with extra spaces", result);
    }

    [Fact]
    public void SingleLineCommentWithoutSpace_AddsSpace()
    {
        string source = "//comment\r\npublic class MyClass { }";
        string result = _converter.Apply(source);
        // Should add space after //
        Assert.Contains("// comment", result);
    }

    [Fact]
    public void IndentedComment_PreservesIndentation()
    {
        string source = "    // indented comment\r\npublic class MyClass { }";
        string result = _converter.Apply(source);
        // Should preserve indentation
        Assert.Contains("    // indented comment", result);
    }

    [Fact]
    public void EmptyComment_NormalizesCorrectly()
    {
        string source = "//\r\npublic class MyClass { }";
        string result = _converter.Apply(source);
        Assert.Contains("//", result);
    }

    [Fact]
    public void MultiLineComment_PreservesStructure()
    {
        string source = "/* comment */\r\npublic class MyClass { }";
        string result = _converter.Apply(source);
        Assert.Contains("/* comment */", result);
    }

    [Fact]
    public void MultipleComments_FormatsAll()
    {
        string source = "//  comment1\r\n//  comment2\r\npublic class MyClass { }";
        string result = _converter.Apply(source);
        // Both should be normalized
        Assert.Contains("// comment1", result);
        Assert.Contains("// comment2", result);
    }

    [Fact]
    public void PreservesNewlineStyle()
    {
        string source = "// comment\n// another";
        string result = _converter.Apply(source);
        // Should preserve \n style
        Assert.Contains("\n", result);
        Assert.DoesNotContain("\r\n", result);
    }

    [Fact]
    public void Name_ReturnsCorrectName() => Assert.AreEqual("Format comments", _converter.Name);

    [Fact]
    public void MultiLineComment_WithAsteriskContinuationLines_AlignsWithBaseIndentation()
    {
        string source = "    /*\r\n    * line 1\r\n    * line 2\r\n    */\r\n    public class MyClass { }";
        string result = _converter.Apply(source);

        Assert.Contains("    * line 1", result);
        Assert.Contains("    * line 2", result);
    }

    [Fact]
    public void MultiLineComment_WithoutAsteriskContinuationLines_PreservesLines()
    {
        string source = "    /*\r\n    content line 1\r\n    content line 2\r\n    */\r\n    public class MyClass { }";
        string result = _converter.Apply(source);

        Assert.Contains("    content line 1", result);
        Assert.Contains("    content line 2", result);
    }

    [Fact]
    public void PreservesCarriageReturnNewlineStyle()
    {
        string source = "// comment 1\r// comment 2";
        string result = _converter.Apply(source);

        Assert.Contains("\r", result);
    }

    [Theory]
    [InlineData("//Entry\nConsole.WriteLine(\"hi\");\n", "// Entry\nConsole.WriteLine(\"hi\");\n")]
    [InlineData("//Entry\r\nConsole.WriteLine(\"hi\");\r\n", "// Entry\r\nConsole.WriteLine(\"hi\");\r\n")]
    [InlineData("//Entry\rConsole.WriteLine(\"hi\");\r", "// Entry\rConsole.WriteLine(\"hi\");\r")]
    public void LineBreakStyleAndFinalLineBreak_ArePreservedExactly(string source, string expected) => Assert.AreEqual(expected, _converter.Apply(source));

    [Fact]
    public void TopLevelStatementsFile_AlreadyFormatted_IsUnchanged()
    {
        string source =
            "using System;\r\n" +
            "\r\n" +
            "// Entry point\r\n" +
            "Console.WriteLine(\"hi\"); // trailing\r\n" +
            "\r\n" +
            "static void Local()\r\n" +
            "{\r\n" +
            "    // body\r\n" +
            "}\r\n" +
            "\r\n" +
            "class Helper { }\r\n";

        Assert.AreEqual(source, _converter.Apply(source));
    }

    [Fact]
    public void TopLevelStatementsFile_FormatsWholeLineCommentsOnly_WithoutAddingOrRemovingLines()
    {
        string source = "using System;\r\n//Entry point\r\nConsole.WriteLine(\"hi\"); //trailing\r\n    //   indented\r\n";
        string expected = "using System;\r\n// Entry point\r\nConsole.WriteLine(\"hi\"); //trailing\r\n    // indented\r\n";

        Assert.AreEqual(expected, _converter.Apply(source));
    }

    [Theory]
    [InlineData("var url = \"http://example.com\";\r\n")]
    [InlineData("var s = \"//not a comment\";\r\n")]
    [InlineData("#region  Fields\r\nint x;\r\n#endregion\r\n")]
    [InlineData("#if DEBUG\r\nint x;\r\n#endif\r\n")]
    [InlineData("   \r\n\t\r\n")]
    [InlineData("class C { int x; /* inline */ }\r\n")]
    public void LinesWithoutWholeLineComments_AreUnchanged(string source) => Assert.AreEqual(source, _converter.Apply(source));

    [Fact]
    public void SingleLineCommentMarkersInsideABlockComment_AreKeptVerbatim()
    {
        string source = "/*\r\n//keep as is\r\n*/\r\n//after\r\n";

        Assert.AreEqual("/*\r\n//keep as is\r\n*/\r\n// after\r\n", _converter.Apply(source));
    }

    [Fact]
    public void BlockCommentClosedOnItsFirstLine_DoesNotSwallowTheFollowingLines()
    {
        string source = "/* a */\r\n//b\r\n";

        Assert.AreEqual("/* a */\r\n// b\r\n", _converter.Apply(source));
    }

    [Fact]
    public void BlockCommentClosingLine_IsKeptAsIs_AndLaterCommentsAreFormatted()
    {
        string source = "/* a\r\n   * b */ int x;\r\n//c\r\n";

        Assert.AreEqual("/* a\r\n   * b */ int x;\r\n// c\r\n", _converter.Apply(source));
    }

    [Fact]
    public void BlockCommentContinuationStars_AreAlignedUnderTheOpeningStar()
    {
        string source = "    /*\r\n    * line 1\r\n      * line 2\r\n    text\r\n    */\r\n";

        Assert.AreEqual("    /*\r\n     * line 1\r\n     * line 2\r\n    text\r\n    */\r\n", _converter.Apply(source));
    }

    [Theory]
    [InlineData("\t//\tcomment", "\t// comment")]
    [InlineData("//   ", "//")]
    [InlineData("    //", "    //")]
    public void CommentSpacing_IsNormalized(string source, string expected) => Assert.AreEqual(expected, _converter.Apply(source));

    [Fact]
    public void FileWithSyntaxErrors_OnlyCommentLinesChange()
    {
        string source = "class C {\r\n//broken\r\n    void M( {\r\n";

        Assert.AreEqual("class C {\r\n// broken\r\n    void M( {\r\n", _converter.Apply(source));
    }

    [Fact]
    public void Apply_IsIdempotent()
    {
        string source = "//a\r\n    /*\r\n    * b\r\n    */\r\nclass C { } //c\r\n";
        string once = _converter.Apply(source);

        Assert.AreEqual(once, _converter.Apply(once));
    }

    [Theory]
    [InlineData("/// <summary>\r\n/// Does X.\r\n/// </summary>\r\nclass C { }\r\n")]
    [InlineData("class C\r\n{\r\n    ///<summary>Does X.</summary>\r\n    void M() { }\r\n}\r\n")]
    public void XmlDocumentationComments_AreUnchanged(string source) => Assert.AreEqual(source, _converter.Apply(source));

    [Theory]
    [InlineData("var s = @\"\r\n//x\r\n\";\r\n")]
    [InlineData("var s = \"\"\"\r\n    //x\r\n    \"\"\";\r\n")]
    [InlineData("var s = @\"\r\n/*\r\n  * x\r\n*/\";\r\n")]
    public void CommentMarkersInsideMultiLineStrings_AreUnchanged(string source) => Assert.AreEqual(source, _converter.Apply(source));

    [Theory]
    [InlineData("// a\r\nint x;\nint y;\r\n", "// a\r\nint x;\nint y;\r\n")]
    [InlineData("//a\nint x;\r\n//b\r\n", "// a\nint x;\r\n// b\r\n")]
    public void MixedLineEndings_ArePreservedLineByLine(string source, string expected) => Assert.AreEqual(expected, _converter.Apply(source));

    [Theory]
    [InlineData("////<summary>\r\n")]
    [InlineData("    //// old code\r\n")]
    public void CommentsStartingWithMoreThanTwoSlashes_AreUnchanged(string source) => Assert.AreEqual(source, _converter.Apply(source));

    [Fact]
    public void BlockCommentOpenedAfterCode_ContentIsUnchanged()
    {
        string source = "int x; /* start\r\n//inner\r\n  * star\r\n*/\r\n";

        Assert.AreEqual(source, _converter.Apply(source));
    }

    [Theory]
    [InlineData("#if DEBUG\r\n//a\r\n    //b\r\n#endif\r\n", "#if DEBUG\r\n// a\r\n    // b\r\n#endif\r\n")]
    [InlineData("#if DEBUG\r\n    /*\r\n    * a\r\n    */\r\n#endif\r\n", "#if DEBUG\r\n    /*\r\n     * a\r\n    */\r\n#endif\r\n")]
    [InlineData("#if DEBUG\r\n//a\r\n#else\r\n//b\r\n#endif\r\n", "#if DEBUG\r\n// a\r\n#else\r\n// b\r\n#endif\r\n")]
    [InlineData("#if DEBUG\r\nvar s = \"//x\";\r\nint y; //c\r\n//d\r\n#endif\r\n", "#if DEBUG\r\nvar s = \"//x\";\r\nint y; //c\r\n// d\r\n#endif\r\n")]
    [InlineData("#if DEBUG\r\nvar s = @\"\r\n//x\r\n\";\r\n#endif\r\n", "#if DEBUG\r\nvar s = @\"\r\n//x\r\n\";\r\n#endif\r\n")]
    public void CommentsInsideAnInactivePreprocessorBranch_AreFormatted(string source, string expected) => Assert.AreEqual(expected, _converter.Apply(source));

    [Theory]
    [InlineData("#if DEBUG\r\nvar s = @\"\r\n#!/usr/bin/env node\r\n//x\r\n\";\r\n#endif\r\n")]
    [InlineData("#if DEBUG\r\nvar s = \"\"\"\r\n    # Title\r\n    //x\r\n    \"\"\";\r\n#endif\r\n")]
    public void CommentLikeTextInsideAStringOfAnInactiveBranchWithAHashLine_IsLeftAlone(string source) => Assert.AreEqual(source, _converter.Apply(source));
}
