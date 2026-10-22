#nullable disable
using System;
using Xunit;
using Assert = CodeJanitor.Engine.Tests.Steps.Support.MsAssert;
using VsSettings = CodeJanitor.Engine.Tests.Steps.Support.VsSettings;

namespace CodeJanitor.Engine.Tests.Comments;

/// <summary>
/// Class with list oriented unit tests for formatting. This calls the formatter directly, rather
/// than invoking it through the UI as with the integration tests.
/// </summary>
public sealed class ListFormattingTests
{
    public ListFormattingTests() => VsSettings.Default.Reset();

    [Fact]
    public void ListFormattingTests_DashedList()
    {
        string input =
            @"Some text before." + "\r\n" +
            @"- The first item with enough words to require wrapping." + "\r\n" +
            @"- The second item with enough words to require wrapping." + "\r\n" +
            @"Some trailing text.";

        string expected =
            @"Some text before." + "\r\n" +
            @"- The first item with enough" + "\r\n" +
            @"  words to require wrapping." + "\r\n" +
            @"- The second item with enough" + "\r\n" +
            @"  words to require wrapping." + "\r\n" +
            @"Some trailing text.";

        CommentFormatHelper.AssertEqualAfterFormat(input, expected, o => o.WrapColumn = 30);
    }

    [Fact]
    public void ListFormattingTests_NumberedList()
    {
        string input =
            @"Some text before." + "\r\n" +
            @"1) The first item with enough words to require wrapping." + "\r\n" +
            @"2) The second item with enough words to require wrapping." + "\r\n" +
            @"Some trailing text.";

        string expected =
            @"Some text before." + "\r\n" +
            @"1) The first item with enough" + "\r\n" +
            @"   words to require wrapping." + "\r\n" +
            @"2) The second item with enough" + "\r\n" +
            @"   words to require wrapping." + "\r\n" +
            @"Some trailing text.";

        CommentFormatHelper.AssertEqualAfterFormat(input, expected, o => o.WrapColumn = 30);
    }

    [Fact]
    public void ListFormattingTests_WordList()
    {
        string input =
            @"Some text before." + "\r\n" +
            @"item) The first item with enough words to require wrapping." + "\r\n" +
            @"meti) The second item with enough words to require wrapping." + "\r\n" +
            @"Some trailing text.";

        string expected =
            @"Some text before." + "\r\n" +
            @"item) The first item with enough" + "\r\n" +
            @"      words to require wrapping." + "\r\n" +
            @"meti) The second item with enough" + "\r\n" +
            @"      words to require wrapping." + "\r\n" +
            @"Some trailing text.";

        CommentFormatHelper.AssertEqualAfterFormat(input, expected, o => o.WrapColumn = 35);
    }

    [Fact]
    public void ListFormattingTests_XmlListWithHeader()
    {
        string input =
            "Some text before." + "\r\n" +
            "<list type=\"bullet\">" + "\r\n" +
            "   <listheader>" + "\r\n" +
            "       <term>header term</term>" + "\r\n" +
            "       <description>description</description>" + "\r\n" +
            "   </listheader>" + "\r\n" +
            "   <item>" + "\r\n" +
            "       <term>item term</term>" + "\r\n" +
            "       <description>description</description>" + "\r\n" +
            "   </item>" + "\r\n" +
            "</list>" + "\r\n" +
            "Some trailing text.";

        string expected =
            "Some text before." + "\r\n" +
            "<list type=\"bullet\">" + "\r\n" +
            "<listheader>" + "\r\n" +
            "<term>header term</term>" + "\r\n" +
            "<description>description</description>" + "\r\n" +
            "</listheader>" + "\r\n" +
            "<item>" + "\r\n" +
            "<term>item term</term>" + "\r\n" +
            "<description>description</description>" + "\r\n" +
            "</item>" + "\r\n" +
            "</list>" + "\r\n" +
            "Some trailing text.";

        CommentFormatHelper.AssertEqualAfterFormat(input, expected);
    }

    [Fact]
    public void ListFormattingTests_XmlListWithHeaderAndIndent()
    {
        string input =
            "Some text before." + "\r\n" +
            "<list type=\"bullet\">" + "\r\n" +
            "<listheader>" + "\r\n" +
            "<term>header term</term>" + "\r\n" +
            "<description>description</description>" + "\r\n" +
            "</listheader>" + "\r\n" +
            "<item>" + "\r\n" +
            "<term>item term</term>" + "\r\n" +
            "<description>description</description>" + "\r\n" +
            "</item>" + "\r\n" +
            "</list>" + "\r\n" +
            "Some trailing text.";

        string expected =
            "Some text before." + "\r\n" +
            "<list type=\"bullet\">" + "\r\n" +
            "  <listheader>" + "\r\n" +
            "    <term>header term</term>" + "\r\n" +
            "    <description>description</description>" + "\r\n" +
            "  </listheader>" + "\r\n" +
            "  <item>" + "\r\n" +
            "    <term>item term</term>" + "\r\n" +
            "    <description>description</description>" + "\r\n" +
            "  </item>" + "\r\n" +
            "</list>" + "\r\n" +
            "Some trailing text.";

        CommentFormatHelper.AssertEqualAfterFormat(input, expected, o => o.Xml.Default.Indent = 2);
    }
}
