#nullable disable
using System;
using Xunit;
using Assert = CodeJanitor.Engine.Tests.Steps.Support.MsAssert;
using VsSettings = CodeJanitor.Engine.Tests.Steps.Support.VsSettings;

namespace CodeJanitor.Engine.Tests.Comments;

/// <summary>
/// Class with simple unit tests for formatting header type comments. This calls the formatter
/// directly, rather than invoking it through the UI as with the integration tests.
/// </summary>
public sealed class HeaderFormattingTests
{
    public HeaderFormattingTests() => VsSettings.Default.Reset();

    /// <summary>
    /// Tests the forced indenting of the XML copyright file header.
    /// </summary>
    [Fact]
    public void HeaderFormattingTests_Copyright_Indenting()
    {
        string input =
            @"<copyright file=""NameOfFile.cs"" company=""CompanyName"">" + "\r\n" +
            @"Company copyright tag." + "\r\n" +
            @"</copyright>";

        string expected =
            @"<copyright file=""NameOfFile.cs"" company=""CompanyName"">" + "\r\n" +
            @"    Company copyright tag." + "\r\n" +
            @"</copyright>";

        CommentFormatHelper.AssertEqualAfterFormat(input, expected, o => o.Xml.Default.Indent = 0);
    }

    [Fact]
    public void HeaderFormattingTests_PreservesHyphenLinesWithoutXML()
    {
        string input =
            @"--------------------------------------------------------------------------------------------------------------------" + "\r\n" +
            "\r\n" +
            @"Copyright (c) 2012 - 2013 . All rights reserved." + "\r\n" +
            "\r\n" +
            @"--------------------------------------------------------------------------------------------------------------------";

        CommentFormatHelper.AssertEqualAfterFormat(input);
    }

    [Fact]
    public void HeaderFormattingTests_Copyright_PreservesHyphenLinesWithXML()
    {
        string input =
            @"-----------------------------------------------------------------------" + "\r\n" +
            @"<copyright file=""NameOfFile.cs"" company=""CompanyName"">" + "\r\n" +
            @"    Company copyright tag." + "\r\n" +
            @"</copyright>" + "\r\n" +
            @"-----------------------------------------------------------------------";

        CommentFormatHelper.AssertEqualAfterFormat(input);
    }
}
