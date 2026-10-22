#nullable disable
using System;
using Xunit;
using Assert = CodeJanitor.Engine.Tests.Steps.Support.MsAssert;
using VsSettings = CodeJanitor.Engine.Tests.Steps.Support.VsSettings;

namespace CodeJanitor.Engine.Tests.Comments;

/// <summary>
/// Test for the ignoring of comments lines starting with certain prefixes.
/// </summary>
public sealed class IgnorePrefixesTests
{
    public IgnorePrefixesTests() => VsSettings.Default.Reset();

    [Fact]
    public void IgnorePrefixesTests_DoesNotWrapSingleLine() => CommentFormatHelper.AssertEqualAfterFormat(@"TODO: Lorem ipsum dolor sit amet, consectetur adipiscing elit.", o => o.WrapColumn = 30);

    [Fact]
    public void IgnorePrefixesTests_DoesNotWrapLineInsideComment()
    {
        string input =
            "Lorem ipsum dolor sit amet, consectetur adipiscing elit." + "\r\n" +
            "TODO: Lorem ipsum dolor sit amet, consectetur adipiscing elit." + "\r\n" +
            "Lorem ipsum dolor sit amet, consectetur adipiscing elit.";

        // Expect all lines to be wrapped except for the one starting with "TODO".
        string expected =
            "Lorem ipsum dolor sit amet," + "\r\n" +
            "consectetur adipiscing elit." + "\r\n" +
            "TODO: Lorem ipsum dolor sit amet, consectetur adipiscing elit." + "\r\n" +
            "Lorem ipsum dolor sit amet," + "\r\n" +
            "consectetur adipiscing elit.";

        CommentFormatHelper.AssertEqualAfterFormat(input, expected, o => o.WrapColumn = 30);
    }

    [Fact]
    public void IgnorePrefixesTests_DoesNotCombineSubsequentLines()
    {
        string input =
            "Lorem ipsum dolor sit amet, consectetur adipiscing elit." + "\r\n" +
            "TODO: Lorem ipsum dolor sit amet, consectetur adipiscing elit." + "\r\n" +
            "TODO: Lorem ipsum dolor sit amet, consectetur adipiscing elit." + "\r\n" +
            "Lorem ipsum dolor sit amet, consectetur adipiscing elit.";

        // Expect every "ignored" line to stay on it's own.
        string expected =
            "Lorem ipsum dolor sit amet," + "\r\n" +
            "consectetur adipiscing elit." + "\r\n" +
            "TODO: Lorem ipsum dolor sit amet, consectetur adipiscing elit." + "\r\n" +
            "TODO: Lorem ipsum dolor sit amet, consectetur adipiscing elit." + "\r\n" +
            "Lorem ipsum dolor sit amet," + "\r\n" +
            "consectetur adipiscing elit.";

        CommentFormatHelper.AssertEqualAfterFormat(input, expected, o => o.WrapColumn = 30);
    }
}
