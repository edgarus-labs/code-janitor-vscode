#nullable disable
using System;
using Xunit;
using Assert = CodeJanitor.Engine.Tests.Steps.Support.MsAssert;
using VsSettings = CodeJanitor.Engine.Tests.Steps.Support.VsSettings;

namespace CodeJanitor.Engine.Tests.Comments;

/// <summary>
/// </summary>
public sealed class FormatWithPrefixTests
{
    public FormatWithPrefixTests() => VsSettings.Default.Reset();

    [Fact]
    public void SimpleFormatWithPrefixTests_KeepsPrefix()
    {
        string input = "// Lorem ipsum dolor sit amet, consectetur adipiscing elit.";
        string expected =
            "// Lorem ipsum dolor sit amet," + "\r\n" +
            "// consectetur adipiscing elit.";
        CommentFormatHelper.AssertEqualAfterFormat(input, expected, "//", o => o.WrapColumn = 40);
    }

    [Fact]
    public void SimpleFormatWithPrefixTests_TrimsTrailingSpace()
    {
        string input = "// Trailing space  ";
        string expected = "// Trailing space";
        CommentFormatHelper.AssertEqualAfterFormat(input, expected, "//");
    }

    [Fact]
    public void SimpleFormatWithPrefixTests_TrimsTrailingLines()
    {
        string input =
            "// Comment with some trailing lines" + "\r\n" +
            "//" + "\r\n" +
            "//";
        string expected =
            "// Comment with some trailing lines";
        CommentFormatHelper.AssertEqualAfterFormat(input, expected, "//");
    }

    [Fact]
    public void SimpleFormatWithPrefixTests_TrimsLeadingLines()
    {
        string input =
            "//" + "\r\n" +
            "//" + "\r\n" +
            "// Comment with some leading lines";
        string expected =
            "// Comment with some leading lines";

        CommentFormatHelper.AssertEqualAfterFormat(input, expected, "//");
    }

    [Fact]
    public void SimpleFormatWithPrefixTests_KeepsLeadingSpace()
    {
        string input = "    // Lorem ipsum.";
        CommentFormatHelper.AssertEqualAfterFormat(input, input, "    //");
    }

    [Fact]
    public void SimpleFormatWithPrefixTests_AlignsToFirstPrefix()
    {
        string input =
            "    // Lorem ipsum dolor sit amet, consectetur" + "\r\n" +
            "  // adipiscing elit.";
        string expected =
            "    // Lorem ipsum dolor sit amet," + "\r\n" +
            "    // consectetur adipiscing elit.";
        CommentFormatHelper.AssertEqualAfterFormat(input, expected, "    //", o => o.WrapColumn = 40);
    }

    [Fact]
    public void SimpleFormatWithPrefixTests_NoTrailingWhitespaceOnEmptyLine()
    {
        string input =
            "// Lorem ipsum dolor sit amet." + "\r\n" +
            "//" + "\r\n" +
            "// Consectetur adipiscing elit.";
        CommentFormatHelper.AssertEqualAfterFormat(input, input, "//", o => o.WrapColumn = 40);
    }
}
