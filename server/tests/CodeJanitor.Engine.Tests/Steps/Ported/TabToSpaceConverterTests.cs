#nullable disable
using CodeJanitor.Engine.Steps.Transformations;
using Xunit;
using Assert = CodeJanitor.Engine.Tests.Steps.Support.MsAssert;

namespace CodeJanitor.Engine.Tests.Steps;

/// <summary>
/// Unit tests for <see cref="TabToSpaceConverter" />. Verifies that indentation/whitespace tabs
/// are expanded to the next tab stop while tabs inside string/char literals and comments are preserved.
/// </summary>
public sealed class TabToSpaceConverterTests
{
    [Fact]
    public void IndentationTab_ExpandedToFourSpacesByDefault()
    {
        TabToSpaceConverter converter = new TabToSpaceConverter();
        string input = "class C\n{\n\tint x;\n}\n";
        string expected = "class C\n{\n    int x;\n}\n";

        Assert.AreEqual(expected, converter.Convert(input));
    }

    [Fact]
    public void IndentationTab_ExpandedToCustomTabSize()
    {
        TabToSpaceConverter converter = new TabToSpaceConverter(2);
        string input = "class C\n{\n\tint x;\n}\n";
        string expected = "class C\n{\n  int x;\n}\n";

        Assert.AreEqual(expected, converter.Convert(input));
    }

    [Fact]
    public void TabInsideStringLiteral_Preserved()
    {
        TabToSpaceConverter converter = new TabToSpaceConverter();
        string input = "class C\n{\n\tstring s = \"a\tb\";\n}\n";
        string expected = "class C\n{\n    string s = \"a\tb\";\n}\n";

        Assert.AreEqual(expected, converter.Convert(input));
    }

    [Fact]
    public void TabInsideVerbatimString_Preserved()
    {
        TabToSpaceConverter converter = new TabToSpaceConverter();
        string input = "class C\n{\n\tstring s = @\"a\tb\";\n}\n";
        string expected = "class C\n{\n    string s = @\"a\tb\";\n}\n";

        Assert.AreEqual(expected, converter.Convert(input));
    }

    [Fact]
    public void NoTabs_Unchanged()
    {
        TabToSpaceConverter converter = new TabToSpaceConverter();
        string input = "class C\n{\n    int x;\n}\n";

        Assert.AreEqual(input, converter.Convert(input));
    }

    [Fact]
    public void EmptySource_Unchanged()
    {
        TabToSpaceConverter converter = new TabToSpaceConverter();

        Assert.AreEqual(string.Empty, converter.Convert(string.Empty));
    }

    [Fact]
    public void NullSource_ReturnsNull()
    {
        TabToSpaceConverter converter = new TabToSpaceConverter();

        Assert.IsNull(converter.Convert(null));
    }

    [Fact]
    public void ImplementsSourceTransformation_ApplyMatchesConvert()
    {
        ISourceTransformation transformation = new TabToSpaceConverter();
        string input = "class C\n{\n\tint x;\n}\n";
        string expected = "class C\n{\n    int x;\n}\n";

        Assert.AreEqual(expected, transformation.Apply(input));
        Assert.AreEqual("Convert tabs to spaces", transformation.Name);
    }

    [Fact]
    public void Constructor_InvalidTabSize_ThrowsArgumentOutOfRangeException()
    {
        try
        {
            _ = new TabToSpaceConverter(0);
            Assert.Fail("Expected ArgumentOutOfRangeException was not thrown.");
        }
        catch (System.ArgumentOutOfRangeException)
        {
            // Expected
        }
    }

    [Fact]
    public void TabSize_ReportsTheConfiguredWidth()
    {
        Assert.AreEqual(4, new TabToSpaceConverter().TabSize);
        Assert.AreEqual(2, new TabToSpaceConverter(2).TabSize);
    }

    [Fact]
    public void TopLevelStatementsFile_TabsInCommentsAndStringLiteralsAreKept()
    {
        string input =
            "using System;\n\nConsole.WriteLine(\"a\tb\");\nstatic void Local()\n{\n" +
            "\t// comment\twith tab\n\tvar s = @\"x\ty\";\n\tvar i = $\"{s}\t!\";\n\tvar r = \"\"\"\n\t\traw\ttab\n\t\t\"\"\";\n}\n";
        string expected =
            "using System;\n\nConsole.WriteLine(\"a\tb\");\nstatic void Local()\n{\n" +
            "    // comment\twith tab\n    var s = @\"x\ty\";\n    var i = $\"{s}\t!\";\n    var r = \"\"\"\n\t\traw\ttab\n\t\t\"\"\";\n}\n";

        Assert.AreEqual(expected, new TabToSpaceConverter().Convert(input));
    }

    [Theory]
    [InlineData(4, "class C\n{\n  \tint x;\n}\n", "class C\n{\n    int x;\n}\n")]
    [InlineData(4, "class C\n{\n \t\tint x;\n}\n", "class C\n{\n        int x;\n}\n")]
    [InlineData(2, "class C\n{\n \tint x;\n}\n", "class C\n{\n  int x;\n}\n")]
    [InlineData(4, "class C\n{\n    int x;\t// c\n}\n", "class C\n{\n    int x;  // c\n}\n")]
    [InlineData(4, "class C\n{\n    int x;\t\t// c\n}\n", "class C\n{\n    int x;      // c\n}\n")]
    [InlineData(4, "class C\n{\n  \t/// <summary>Doc</summary>\n  \tint x;\n}\n", "class C\n{\n    /// <summary>Doc</summary>\n    int x;\n}\n")]
    [InlineData(4, "class C\n{\n  \t/// <summary>\n  \t/// Doc\n  \t/// </summary>\n  \tint x;\n}\n", "class C\n{\n    /// <summary>\n    /// Doc\n    /// </summary>\n    int x;\n}\n")]
    [InlineData(4, "class C\n{\n\tstring s = \"a\tb\"; int  y;\tint z;\n}\n", "class C\n{\n    string s = \"a\tb\"; int  y; int z;\n}\n")]
    public void ATabIsExpandedToTheNextTabStop(int tabSize, string input, string expected)
    {
        TabToSpaceConverter converter = new TabToSpaceConverter(tabSize);

        Assert.AreEqual(expected, converter.Convert(input));
        Assert.AreEqual(expected, converter.Convert(expected));
    }

    [Fact]
    public void DirectivesSingleLineDocumentationCommentsAndTrailingTabs_AreExpanded()
    {
        string input = "class C\r\n{\r\n\t#region R\r\n\t/// <summary>Doc</summary>\r\n\tint x;\t// trailing\r\n\t#endregion\r\n}\r\n";
        string expected = "class C\r\n{\r\n    #region R\r\n    /// <summary>Doc</summary>\r\n    int x;  // trailing\r\n    #endregion\r\n}\r\n";

        Assert.AreEqual(expected, new TabToSpaceConverter().Convert(input));
    }

    [Fact]
    public void DisabledPreprocessorText_IsKept()
    {
        string input = "#if NEVER_DEFINED\n\tint x;\n#endif\n";

        Assert.AreEqual(input, new TabToSpaceConverter().Convert(input));
    }

    [Fact]
    public void FileWithSyntaxErrors_IndentationIsStillExpanded() => Assert.AreEqual("class C {\r\n    void M( {\r\n", new TabToSpaceConverter().Convert("class C {\r\n\tvoid M( {\r\n"));

    [Fact]
    public void TabIndentationOfDocumentationCommentContinuationLines_IsExpanded()
    {
        string input = "class C\r\n{\r\n\t/// <summary>\r\n\t/// Doc\there\r\n\t/// </summary>\r\n\tint x;\r\n}\r\n";
        string expected = "class C\r\n{\r\n    /// <summary>\r\n    /// Doc\there\r\n    /// </summary>\r\n    int x;\r\n}\r\n";

        Assert.AreEqual(expected, new TabToSpaceConverter().Convert(input));
    }

    [Fact]
    public void TabIndentationOfMultiLineDocumentationCommentContinuationLines_IsExpanded()
    {
        string input = "class C\n{\n\t/**\n\t * <summary>Doc</summary>\n\t */\n\tint x;\n}\n";
        string expected = "class C\n{\n    /**\n     * <summary>Doc</summary>\n     */\n    int x;\n}\n";

        Assert.AreEqual(expected, new TabToSpaceConverter().Convert(input));
    }

    [Theory]
    [InlineData(4, "class C\n{\n\tint x;\n}\n")]
    [InlineData(2, "class C\n{\n\t\tint x;\n}\n")]
    [InlineData(4, "class C\r\n{\r\n\t#region R\r\n\t/// <summary>Doc</summary>\r\n\tint x;\t// trailing\r\n\t#endregion\r\n}\r\n")]
    [InlineData(4, "class C\n{\n\tstring s = \"a\tb\";\n\tstring v = @\"x\ty\";\n}\n")]
    [InlineData(4, "class C\n{\n\t/**\n\t * <summary>Doc</summary>\n\t */\n\tint x;\n}\n")]
    public void Convert_IsIdempotent(int tabSize, string input)
    {
        TabToSpaceConverter converter = new TabToSpaceConverter(tabSize);
        string once = converter.Convert(input);

        Assert.AreNotEqual(input, once, "The scenario has to change the input at all.");
        Assert.AreEqual(once, converter.Convert(once));
    }
}
