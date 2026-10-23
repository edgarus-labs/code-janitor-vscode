#nullable disable
using System;
using CodeJanitor.Engine.Comments.Options;
using Xunit;
using Assert = CodeJanitor.Engine.Tests.Steps.Support.MsAssert;
using VsSettings = CodeJanitor.Engine.Tests.Steps.Support.VsSettings;

namespace CodeJanitor.Engine.Tests.Comments;

/// <summary>
/// Class with simple unit tests for formatting XML based comments. This calls the formatter
/// directly, rather than invoking it through the UI as with the integration tests.
/// </summary>
public sealed class XmlFormattingTests
{
    public XmlFormattingTests()
    {
        VsSettings.Default.Reset();
        VsSettings.Default.Formatting_CommentXmlSplitAllTags = false;
    }

    [Fact]
    public void XmlFormattingTests_AddSpaceToInsideTags()
    {
        string input = "<xml><see/></xml>";
        string expected = "<xml><see /></xml>";

        CommentFormatHelper.AssertEqualAfterFormat(input, expected, o =>
        o.Xml.Default.SpaceSelfClosing = true);
    }

    [Fact]
    public void XmlFormattingTests_AddSpaceToTagContent()
    {
        string input = "<xml><c>test</c></xml>";
        string expected = "<xml> <c> test </c> </xml>";

        CommentFormatHelper.AssertEqualAfterFormat(input, expected, o =>
        o.Xml.Default.SpaceContent = true);
    }

    [Fact]
    public void XmlFormattingTests_AddSpaceToTagContentWithSelfClosingTag()
    {
        string input = "<tag1><tag2/></tag1>";
        string expected = "<tag1> <tag2/> </tag1>";

        CommentFormatHelper.AssertEqualAfterFormat(input, expected, o =>
        {
            o.Xml.Default.SpaceContent = true;
            o.Xml.Default.SpaceSelfClosing = false;
        });
    }

    [Fact]
    public void XmlFormattingTests_AddSpaceToTagContentWithSelfClosingTagMultiline()
    {
        // Add space to content should not add a space when tag content is on it's own line.
        string input = "<tag1><tag2/></tag1>";
        string expected =
            "<tag1>" + "\r\n" +
            "<tag2/>" + "\r\n" +
            "</tag1>";

        CommentFormatHelper.AssertEqualAfterFormat(input, expected, o =>
        {
            o.Xml.Default.Split = XmlTagNewLine.Always;
            o.Xml.Default.SpaceContent = true;
            o.Xml.Default.SpaceSelfClosing = false;
        });
    }

    [Fact]
    public void XmlFormattingTests_AddSpaceToTagContentShouldLeaveNoTrailingWhitespace1()
    {
        string input = "<xml>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</xml>";
        string expected =
            "<xml>" + "\r\n" +
            "Lorem ipsum dolor sit amet," + "\r\n" +
            "consectetur adipiscing elit." + "\r\n" +
            "</xml>";

        CommentFormatHelper.AssertEqualAfterFormat(input, expected, o =>
        {
            o.WrapColumn = 30;
            o.Xml.Default.Split = XmlTagNewLine.Always;
            o.Xml.Default.SpaceContent = true;
        });
    }

    [Fact]
    public void XmlFormattingTests_AddSpaceToTagContentShouldLeaveNoTrailingWhitespace2()
    {
        string input =
           "<remarks>" + "\r\n" +
           "Lorem ipsum dolor sit amet, consectetur adipiscing elit." + "\r\n" +
           "</remarks>";

        string expected =
           "<remarks>" + "\r\n" +
           "    Lorem ipsum dolor sit amet, consectetur" + "\r\n" +
           "    adipiscing elit." + "\r\n" +
           "</remarks>";

        CommentFormatHelper.AssertEqualAfterFormat(input, expected, o =>
        {
            o.WrapColumn = 50;
            o.Xml.Default.Indent = 4;
            o.Xml.Default.SpaceContent = true;
        });
    }

    [Fact]
    public void XmlFormattingTests_AllRootLevelTagsOnNewLine()
    {
        string input = "<tag1>abc</tag1><tag2>abc</tag2>";
        string expected =
            "<tag1>abc</tag1>" + "\r\n" +
            "<tag2>abc</tag2>";

        CommentFormatHelper.AssertEqualAfterFormat(input, expected);
    }

    [Fact]
    public void XmlFormattingTests_BreakAllTags()
    {
        string input = "<tag1></tag1><tag2></tag2>";
        string expected =
            "<tag1>" + "\r\n" +
            "</tag1>" + "\r\n" +
            "<tag2>" + "\r\n" +
            "</tag2>";

        CommentFormatHelper.AssertEqualAfterFormat(input, expected, o =>
        {
            o.Xml.Default.Indent = 0;
            o.Xml.Default.Split = XmlTagNewLine.Always;
        });
    }

    [Fact]
    public void XmlFormattingTests_BreakLongParagraphs()
    {
        string input = "<example><para>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Vivamus nisi neque, placerat sed neque vitae.</para></example>";
        string expected =
            "<example>" + "\r\n" +
            "<para>" + "\r\n" +
            "Lorem ipsum dolor sit amet, consectetur adipiscing elit." + "\r\n" +
            "Vivamus nisi neque, placerat sed neque vitae." + "\r\n" +
            "</para>" + "\r\n" +
            "</example>";

        CommentFormatHelper.AssertEqualAfterFormat(input, expected, o => o.WrapColumn = 60);
    }

    [Fact]
    public void XmlFormattingTests_BreakTagsWhenContainsParagraphs()
    {
        string input = "<example><para>test</para></example>";
        string expected =
            "<example>" + "\r\n" +
            "<para>test</para>" + "\r\n" +
            "</example>";

        CommentFormatHelper.AssertEqualAfterFormat(input, expected);
    }

    /// <summary>
    /// If XML tag indenting is set, this should not affect any literal content. However, content
    /// after the literal should be indented as normal.
    /// </summary>
    [Fact]
    public void XmlFormattingTests_DoesIndentAfterLiteralContent()
    {
        string input =
           "<example>" + "\r\n" +
           "Example usage :" + "\r\n" +
           "<code source=\"..\\MyExamples\\Examples.cs\" region=\"Example1\" language=\"cs\"/>" + "\r\n" +
           "Example usage with a location parameter and a location function:" + "\r\n" +
           "<code source=\"..\\MyExamples\\Examples.cs\" region=\"Example2\" language=\"cs\"/>" + "\r\n" +
           "And some final text that should also be formatted." + "\r\n" +
           "</example>";

        string expected =
           "<example>" + "\r\n" +
           "    Example usage :" + "\r\n" +
           "    <code source=\"..\\MyExamples\\Examples.cs\" region=\"Example1\" language=\"cs\"/>" + "\r\n" +
           "    Example usage with a location parameter and a location function:" + "\r\n" +
           "    <code source=\"..\\MyExamples\\Examples.cs\" region=\"Example2\" language=\"cs\"/>" + "\r\n" +
           "    And some final text that should also be formatted." + "\r\n" +
           "</example>";

        VsSettings.Default.Formatting_CommentXmlValueIndent = 4;
        VsSettings.Default.Formatting_CommentXmlKeepTagsTogether = true;
        VsSettings.Default.Formatting_CommentXmlSpaceSingleTags = false;

        // First pass.
        string result = CommentFormatHelper.AssertEqualAfterFormat(input, expected);

        // Second pass.
        CommentFormatHelper.AssertEqualAfterFormat(result, expected);
    }

    [Fact]
    public void XmlFormattingTests_DoesNotIndentCloseTag()
    {
        string input = "<tag1></tag1><tag2></tag2>";
        string expected =
            "<tag1>" + "\r\n" +
            "</tag1>" + "\r\n" +
            "<tag2></tag2>";

        CommentFormatHelper.AssertEqualAfterFormat(input, expected, o =>
        {
            o.Xml.Default.Indent = 4;
            o.Xml.Default.KeepTogether = true;

            o.Xml.Tags.Clear();
            o.Xml.Tags["tag1"] = new FormatterOptionsXmlTag { Split = XmlTagNewLine.Always };
        });
    }

    /// <summary>
    /// If XML tag indenting is set, this should not affect any literal content. Since whitespace
    /// is preserved on literals, this would increase the indenting with every pass.
    /// </summary>
    [Fact]
    public void XmlFormattingTests_DoesNotIndentLiteralContent()
    {
        string input =
           "<test>" + "\r\n" +
           "<code>" + "\r\n" +
           "    Some code with." + "\r\n" +
           "   funny indenting" + "\r\n" +
           "" + "\r\n" +
           "  and a white line" + "\r\n" +
           "that should not change." + "\r\n" +
           "</code>" + "\r\n" +
           "</test>";

        string expected =
           "<test>" + "\r\n" +
           "    <code>" + "\r\n" +
           "    Some code with." + "\r\n" +
           "   funny indenting" + "\r\n" +
           "" + "\r\n" +
           "  and a white line" + "\r\n" +
           "that should not change." + "\r\n" +
           "    </code>" + "\r\n" +
           "</test>";

        VsSettings.Default.Formatting_CommentXmlValueIndent = 4;

        // First pass.
        string result = CommentFormatHelper.AssertEqualAfterFormat(input, expected);

        // Second pass.
        CommentFormatHelper.AssertEqualAfterFormat(result, expected);
    }

    [Fact]
    public void XmlFormattingTests_DoNotAutoCollapseTags() => CommentFormatHelper.AssertEqualAfterFormat("<xml></xml>");

    [Fact]
    public void XmlFormattingTests_DoNotAutoExpandTags() => CommentFormatHelper.AssertEqualAfterFormat("<xml/>", o => o.Xml.Default.SpaceSelfClosing = false);

    [Fact]
    public void XmlFormattingTests_HyperlinkBetweenWords()
    {
        string input = "<summary>" + "\r\n" + "Look at this http://foo pretty link." + "\r\n" + "</summary>";
        CommentFormatHelper.AssertEqualAfterFormat(input);
    }

    [Fact]
    public void XmlFormattingTests_HyperlinkOnNewLine()
    {
        string input = "<summary>" + "\r\n" + "http://foo" + "\r\n" + "</summary>";
        CommentFormatHelper.AssertEqualAfterFormat(input);
    }

    [Fact]
    public void XmlFormattingTests_IndentsXml()
    {
        string input = "<summary>Lorem ipsum dolor sit amet.</summary>";
        string expected =
            "<summary>" + "\r\n" +
            "    Lorem ipsum dolor sit amet." + "\r\n" +
            "</summary>";

        VsSettings.Default.Formatting_CommentXmlSplitSummaryTagToMultipleLines = true;
        VsSettings.Default.Formatting_CommentXmlValueIndent = 4;

        CommentFormatHelper.AssertEqualAfterFormat(input, expected);
    }

    [Fact]
    public void XmlFormattingTests_IndentsXmlMultiLevel()
    {
        string input = "<summary>Lorem ipsum dolor <para>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Vivamus nisi neque, placerat sed neque vitae.</para> sit amet.</summary>";
        string expected =
            "<summary>" + "\r\n" +
            "    Lorem ipsum dolor" + "\r\n" +
            "    <para>" + "\r\n" +
            "        Lorem ipsum dolor sit amet, consectetur adipiscing" + "\r\n" +
            "        elit. Vivamus nisi neque, placerat sed neque vitae." + "\r\n" +
            "    </para>" + "\r\n" +
            "    sit amet." + "\r\n" +
            "</summary>";

        CommentFormatHelper.AssertEqualAfterFormat(input, expected, o =>
        {
            o.WrapColumn = 60;
            o.Xml.Default.Indent = 4;
        });
    }

    [Fact]
    public void XmlFormattingTests_IndentsXmlSingleLevel()
    {
        string input = "<summary>Lorem ipsum dolor <para>Lorem ipsum dolor sit amet.</para> sit amet.</summary>";
        string expected =
            "<summary>" + "\r\n" +
            "    Lorem ipsum dolor" + "\r\n" +
            "    <para>Lorem ipsum dolor sit amet.</para>" + "\r\n" +
            "    sit amet." + "\r\n" +
            "</summary>";

        CommentFormatHelper.AssertEqualAfterFormat(input, expected, o =>
        {
            o.Xml.Default.Indent = 4;
            o.Xml.Tags["summary"] = new FormatterOptionsXmlTag { Split = XmlTagNewLine.Always };
        });
    }

    /// <summary>
    /// Test to make sure there is no spacing is added between an inline XML tag directly
    /// followed by interpunction.
    /// </summary>
    [Fact]
    public void XmlFormattingTests_InterpunctionNoSpacing()
    {
        string input = "<test>Line with <interpunction/>.</test>";

        CommentFormatHelper.AssertEqualAfterFormat(input, o => o.Xml.Default.SpaceSelfClosing = false);
    }

    [Fact]
    public void XmlFormattingTests_KeepShortParagraphs()
    {
        string input =
            "<test>" + "\r\n" +
            "<para>" + "\r\n" +
            "Lorem ipsum dolor sit amet." + "\r\n" +
            "</para>" + "\r\n" +
            "</test>";

        string expected =
            "<test>" + "\r\n" +
            "<para>Lorem ipsum dolor sit amet.</para>" + "\r\n" +
            "</test>";

        CommentFormatHelper.AssertEqualAfterFormat(input, expected);
    }

    [Fact]
    public void XmlFormattingTests_RemoveSpaceFromInsideTags()
    {
        string input = "<xml><see /></xml>";
        string expected = "<xml><see/></xml>";

        CommentFormatHelper.AssertEqualAfterFormat(input, expected, o => o.Xml.Default.SpaceSelfClosing = false);
    }

    [Fact]
    public void XmlFormattingTests_RemoveSpaceFromTagContent()
    {
        string input = "<xml> <c> test </c> </xml>";
        string expected = "<xml><c>test</c></xml>";

        CommentFormatHelper.AssertEqualAfterFormat(input, expected, o => o.Xml.Default.SpaceContent = false);
    }

    [Fact]
    public void XmlFormattingTests_SplitAlwaysOnSingleTag()
    {
        string input = "<tag1></tag1><tag2></tag2>";
        string expected =
            "<tag1>" + "\r\n" +
            "</tag1>" + "\r\n" +
            "<tag2></tag2>";

        CommentFormatHelper.AssertEqualAfterFormat(input, expected, o =>
        {
            o.Xml.Default.Indent = 0;
            o.Xml.Tags.Clear();
            o.Xml.Tags["tag1"] = new FormatterOptionsXmlTag { Split = XmlTagNewLine.Always };
        });
    }

    [Fact]
    public void XmlFormattingTests_SplitsTagsWhenLineDoesNotFit()
    {
        string input = "<test>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Vivamus nisi neque, placerat sed neque vitae</test>";
        string expected = "<test>" + "\r\n" +
            "Lorem ipsum dolor sit amet, consectetur adipiscing" + "\r\n" +
            "elit. Vivamus nisi neque, placerat sed neque vitae" + "\r\n" +
            "</test>";

        CommentFormatHelper.AssertEqualAfterFormat(input, expected, o =>
        {
            o.WrapColumn = 50;
            o.SkipWrapOnLastWord = false;
        });
    }

    [Fact]
    public void XmlFormattingTests_TagCase_Keep()
    {
        string input = "<Xml></Xml>";
        string res = CommentFormatHelper.AssertEqualAfterFormat(input, o => o.Xml.Default.Case = XmlTagCase.Keep);
    }

    [Fact]
    public void XmlFormattingTests_TagCase_Lower()
    {
        string input = "<Xml></Xml>";
        string expected = "<xml></xml>";
        CommentFormatHelper.AssertEqualAfterFormat(input, expected, o => o.Xml.Default.Case = XmlTagCase.LowerCase);
    }

    [Fact]
    public void XmlFormattingTests_TagCase_Upper()
    {
        string input = "<Xml></Xml>";
        string expected = "<XML></XML>";
        CommentFormatHelper.AssertEqualAfterFormat(input, expected, o => o.Xml.Default.Case = XmlTagCase.UpperCase);
    }

    /// <summary>
    /// If XML tag indenting is set, this should not affect any literal content. Since whitespace
    /// is preserved on literals, this would increase the indenting with every pass.
    /// </summary>
    [Fact]
    public void XmlFormattingTests_Literal_DoesNotIndent()
    {
        string input =
           "<test>" + "\r\n" +
           "<code>" + "\r\n" +
           "    Some code with." + "\r\n" +
           "   funny indenting" + "\r\n" +
           "" + "\r\n" +
           "  and a white line" + "\r\n" +
           "that should not change." + "\r\n" +
           "</code>" + "\r\n" +
           "</test>";

        string expected =
           "<test>" + "\r\n" +
           "    <code>" + "\r\n" +
           "    Some code with." + "\r\n" +
           "   funny indenting" + "\r\n" +
           "" + "\r\n" +
           "  and a white line" + "\r\n" +
           "that should not change." + "\r\n" +
           "    </code>" + "\r\n" +
           "</test>";

        // First pass.
        string result = CommentFormatHelper.AssertEqualAfterFormat(input, expected, o => o.Xml.Default.Indent = 4);

        // Second pass.
        CommentFormatHelper.AssertEqualAfterFormat(result, expected, o => o.Xml.Default.Indent = 4);
    }

    /// <summary>
    /// If XML tag indenting is set, this should not affect any literal content. however, content
    /// after the literal should be indented as normal.
    /// </summary>
    [Fact]
    public void XmlFormattingTests_Literal_IndentsAfterContent()
    {
        string input =
           "<example>" + "\r\n" +
           "Example usage :" + "\r\n" +
           "<code source=\"..\\MyExamples\\Examples.cs\" region=\"Example1\" language=\"cs\"/>" + "\r\n" +
           "Example usage with a location parameter and a location function:" + "\r\n" +
           "<code source=\"..\\MyExamples\\Examples.cs\" region=\"Example2\" language=\"cs\"/>" + "\r\n" +
           "And some final text that should also be formatted." + "\r\n" +
           "</example>";

        string expected =
           "<example>" + "\r\n" +
           "    Example usage :" + "\r\n" +
           "    <code source=\"..\\MyExamples\\Examples.cs\" region=\"Example1\" language=\"cs\"/>" + "\r\n" +
           "    Example usage with a location parameter and a location function:" + "\r\n" +
           "    <code source=\"..\\MyExamples\\Examples.cs\" region=\"Example2\" language=\"cs\"/>" + "\r\n" +
           "    And some final text that should also be formatted." + "\r\n" +
           "</example>";

        // First pass.
        string result = CommentFormatHelper.AssertEqualAfterFormat(input, expected, o =>
        {
            o.Xml.Default.Indent = 4;
            o.Xml.Default.KeepTogether = true;
            o.Xml.Default.SpaceSelfClosing = false;
        });

        // Second pass.
        CommentFormatHelper.AssertEqualAfterFormat(result, expected, o =>
        {
            o.Xml.Default.Indent = 4;
            o.Xml.Default.KeepTogether = true;
            o.Xml.Default.SpaceSelfClosing = false;
        });
    }

    [Fact]
    public void XmlFormattingTests_Literal_KeepFormatting()
    {
        string input =
            "<test>before <code>" + "\r\n" +
            "some" + "\r\n" +
            "  code" + "\r\n" +
            "stuff" + "\r\n" +
            "</code> after</test>";

        string expected =
            "<test>" + "\r\n" +
            "before" + "\r\n" +
            "<code>" + "\r\n" +
            "some" + "\r\n" +
            "  code" + "\r\n" +
            "stuff" + "\r\n" +
            "</code>" + "\r\n" +
            "after" + "\r\n" +
            "</test>";

        CommentFormatHelper.AssertEqualAfterFormat(input, expected);
    }
}
