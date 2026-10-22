#nullable disable
using CodeJanitor.Engine.Steps.Transformations;
using Xunit;
using Assert = CodeJanitor.Engine.Tests.Steps.Support.MsAssert;

namespace CodeJanitor.Engine.Tests.Steps;

/// <summary>
/// Unit tests for <see cref="RemoveTrailingWhitespaceConverter" />. Verifies trailing spaces/tabs
/// and whitespace-only lines are cleaned while indentation and whitespace inside string literals
/// are preserved.
/// </summary>
public sealed class RemoveTrailingWhitespaceConverterTests
{
    private RemoveTrailingWhitespaceConverter _converter;

    public RemoveTrailingWhitespaceConverterTests() => _converter = new RemoveTrailingWhitespaceConverter();

    [Fact]
    public void TrailingSpacesAfterCode_Removed()
    {
        string input = "class C\n{\n    int x;   \n}\n";
        string expected = "class C\n{\n    int x;\n}\n";

        Assert.AreEqual(expected, _converter.Convert(input));
    }

    [Fact]
    public void TrailingTabsAfterCode_Removed()
    {
        string input = "class C\n{\n    int x;\t\t\n}\n";
        string expected = "class C\n{\n    int x;\n}\n";

        Assert.AreEqual(expected, _converter.Convert(input));
    }

    [Fact]
    public void WhitespaceOnlyLine_Emptied()
    {
        string input = "class C\n{\n   \n}\n";
        string expected = "class C\n{\n\n}\n";

        Assert.AreEqual(expected, _converter.Convert(input));
    }

    [Fact]
    public void Indentation_Preserved()
    {
        string input = "class C\n{\n    int x;\n}\n";

        Assert.AreEqual(input, _converter.Convert(input));
    }

    [Fact]
    public void TrailingWhitespaceInsideVerbatimString_Preserved()
    {
        string input = "class C\n{\n    string s = @\"a   \nb\";\n}\n";

        Assert.AreEqual(input, _converter.Convert(input));
    }

    [Fact]
    public void NoTrailingWhitespace_Unchanged()
    {
        string input = "using System;\n\nclass C\n{\n}\n";

        Assert.AreEqual(input, _converter.Convert(input));
    }

    [Fact]
    public void EmptySource_Unchanged() => Assert.AreEqual(string.Empty, _converter.Convert(string.Empty));

    [Fact]
    public void NullSource_ReturnsNull() => Assert.IsNull(_converter.Convert(null));

    [Fact]
    public void ImplementsSourceTransformation()
    {
        ISourceTransformation transformation = new RemoveTrailingWhitespaceConverter();
        string input = "class C\n{\n    int x;   \n}\n";
        string expected = "class C\n{\n    int x;\n}\n";

        Assert.AreEqual(expected, transformation.Apply(input));
        Assert.AreEqual("Remove trailing whitespace", transformation.Name);
    }

    [Fact]
    public void WhitespaceAfterTheFinalLineBreak_Removed() => Assert.AreEqual("class C { }\r\n", _converter.Convert("class C { }\r\n   \t"));

    [Fact]
    public void FileEndingWithACommentWithoutLineBreak_Unchanged()
    {
        string input = "class C { }\r\n// end";

        Assert.AreEqual(input, _converter.Convert(input));
    }

    [Fact]
    public void TopLevelStatementsFile_TrailingWhitespaceRemovedFromEveryCodeLine()
    {
        string input = "using System;   \r\n  \r\nConsole.WriteLine(1);\t\r\nstatic void L() { }  \r\nrecord R(int X); \r\n";
        string expected = "using System;\r\n\r\nConsole.WriteLine(1);\r\nstatic void L() { }\r\nrecord R(int X);\r\n";

        Assert.AreEqual(expected, _converter.Convert(input));
    }

    [Fact]
    public void TrailingWhitespaceInsideRawAndInterpolatedStrings_Preserved()
    {
        string input = "var s = \"\"\"\r\n  a   \r\n  \"\"\";   \r\nvar i = $@\"x  \r\n{s}  \";\r\n";
        string expected = "var s = \"\"\"\r\n  a   \r\n  \"\"\";\r\nvar i = $@\"x  \r\n{s}  \";\r\n";

        Assert.AreEqual(expected, _converter.Convert(input));
    }

    [Theory]
    [InlineData("// hi   \r\nclass C { }\r\n", "// hi\r\nclass C { }\r\n")]
    [InlineData("#region X   \r\nclass C { }\r\n#endregion \t\r\n", "#region X\r\nclass C { }\r\n#endregion\r\n")]
    [InlineData("/// <summary>  \n/// Doc\t\n/// </summary>\nclass C { }\n", "/// <summary>\n/// Doc\n/// </summary>\nclass C { }\n")]
    [InlineData("/* a\n   b   \n   c */\nclass C { }\n", "/* a\n   b\n   c */\nclass C { }\n")]
    [InlineData("class C { }   ", "class C { }")]
    [InlineData("class C { }\r\n// end  ", "class C { }\r\n// end")]
    public void TrailingWhitespaceInTriviaAndOnTheLastLine_Removed(string input, string expected) => Assert.AreEqual(expected, _converter.Convert(input));

    [Fact]
    public void TrailingWhitespaceInsideDisabledText_Preserved()
    {
        string input = "#if NEVER_DEFINED\nstring s = @\"a   \nb\";\n#endif\n";

        Assert.AreEqual(input, _converter.Convert(input));
    }

    [Theory]
    [InlineData("#if NEVER_DEFINED\nconst string S = @\"\n# Title   \nx\";\n#endif\n")]
    [InlineData("#if NEVER_DEFINED\nconst string S = @\"\n# Title\nx   \ny\";\n#endif\n")]
    public void TrailingWhitespaceInsideAStringOfDisabledTextWithAHashLine_Preserved(string input) => Assert.AreEqual(input, _converter.Convert(input));

    [Theory]
    [InlineData("class C\n{\n    int x;   \n\t\n}\n   ")]
    [InlineData("var s = \"\"\"\r\n  a   \r\n  \"\"\";   \r\nvar i = $@\"x  \r\n{s}  \";\r\n")]
    [InlineData("#region X   \r\nclass C { }\r\n#endregion \t\r\n")]
    [InlineData("/* a\n   b   \n   c */\nclass C { }   \n")]
    [InlineData("class C { }\r\n// end  ")]
    public void Apply_IsIdempotent(string input)
    {
        string once = _converter.Convert(input);

        Assert.AreNotEqual(input, once, "The scenario has to change the input at all.");
        Assert.AreEqual(once, _converter.Convert(once));
    }
}
