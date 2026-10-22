#nullable disable
using System;
using Xunit;
using Assert = CodeJanitor.Engine.Tests.Steps.Support.MsAssert;
using VsSettings = CodeJanitor.Engine.Tests.Steps.Support.VsSettings;

namespace CodeJanitor.Engine.Tests.Comments;

/// <summary>
/// Class with simple unit tests for formatting. This calls the formatter directly, rather than
/// invoking it through the UI as with the integration tests.
/// </summary>
public sealed class SimpleFormattingTests
{
    public SimpleFormattingTests() => VsSettings.Default.Reset();

    [Fact]
    public void SimpleFormattingTests_DoesNotCreateText() => CommentFormatHelper.AssertEqualAfterFormat(string.Empty, string.Empty);

    [Fact]
    public void SimpleFormattingTests_DoesNotWrapShortLines()
    {
        string input = "Lorem ipsum dolor sit amet.";

        CommentFormatHelper.AssertEqualAfterFormat(input);
    }

    [Fact]
    public void SimpleFormattingTests_PreservesMultipleBlankLine()
    {
        string input = "Lorem ipsum\r\n\r\n\r\ndolor sit amet.";

        CommentFormatHelper.AssertEqualAfterFormat(input);
    }

    [Fact]
    public void SimpleFormattingTests_PreservesSingleBlankLine()
    {
        string input = "Lorem ipsum\r\n\r\ndolor sit amet.";

        CommentFormatHelper.AssertEqualAfterFormat(input);
    }

    [Fact]
    public void SimpleFormattingTests_NoTrailingWhitespace()
    {
        string input =
            "Lorem ipsum " + "\r\n" + " " +
            "\r\n" + " " +
            "dolor sit amet. ";

        string expected =
            "Lorem ipsum" + "\r\n" +
            "\r\n" +
            "dolor sit amet.";

        CommentFormatHelper.AssertEqualAfterFormat(input, expected);
    }

    [Fact]
    public void SimpleFormattingTests_RemoveBlankLinesAfter()
    {
        string input = "Lorem ipsum dolor sit amet.\r\n\r\n";
        string expected = "Lorem ipsum dolor sit amet.";

        CommentFormatHelper.AssertEqualAfterFormat(input, expected);
    }

    [Fact]
    public void SimpleFormattingTests_RemoveBlankLinesBefore()
    {
        string input = "\r\n\r\nLorem ipsum dolor sit amet.";
        string expected = "Lorem ipsum dolor sit amet.";

        CommentFormatHelper.AssertEqualAfterFormat(input, expected);
    }

    [Fact]
    public void SimpleFormattingTests_RemovesLineBreaks()
    {
        string input = "Lorem ipsum\r\ndolor sit amet.";
        string expected = "Lorem ipsum dolor sit amet.";

        CommentFormatHelper.AssertEqualAfterFormat(input, expected);
    }

    [Fact]
    public void SimpleFormattingTests_SkipWrapOnLastWord()
    {
        string input = "Lorem ipsum dolor sit amet.";
        string expected = "Lorem ipsum\r\ndolor sit amet.";

        CommentFormatHelper.AssertEqualAfterFormat(input, expected, o =>
        {
            o.WrapColumn = 12;
            o.SkipWrapOnLastWord = true;
        });
    }

    [Fact]
    public void SimpleFormattingTests_WrapOnLastWord()
    {
        string input = "Lorem ipsum dolor sit amet.";
        string expected = "Lorem ipsum\r\ndolor sit\r\namet.";

        CommentFormatHelper.AssertEqualAfterFormat(input, expected, o =>
        {
            o.WrapColumn = 12;
            o.SkipWrapOnLastWord = false;
        });
    }

    [Fact]
    public void SimpleFormattingTests_HyperlinkOnNewLine()
    {
        string input = "http://foo";
        CommentFormatHelper.AssertEqualAfterFormat(input);
    }

    [Fact]
    public void SimpleFormattingTests_HyperlinkBetweenWords()
    {
        string input = "Look at this http://foo pretty link.";
        CommentFormatHelper.AssertEqualAfterFormat(input);
    }

    [Fact]
    public void SimpleFormattingTests_WrapsLinesAsExpected()
    {
        string input = "Lorem ipsum dolor sit.";
        string expected = "Lorem ipsum\r\ndolor sit.";

        CommentFormatHelper.AssertEqualAfterFormat(input, expected, o => o.WrapColumn = 12);
    }

    [Fact]
    public void SimpleFormattingTests_MergesHyphenAndNonHyphenLines()
    {
        string input =
            @"-----" + "\r\n" +
            @"Second line to merge onto hyphen line";

        string expected =
            @"----- Second line to merge onto hyphen line";

        CommentFormatHelper.AssertEqualAfterFormat(input, expected);
    }
}
