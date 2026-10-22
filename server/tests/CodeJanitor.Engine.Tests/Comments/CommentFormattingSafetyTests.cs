using CodeJanitor.Engine.Comments;
using CodeJanitor.Engine.Comments.Options;
using CodeJanitor.Engine.Steps;
using CodeJanitor.Engine.Steps.Transformations;
using CodeJanitor.Engine.Tests.Steps.Support;
using Xunit;

namespace CodeJanitor.Engine.Tests.Comments;

/// <summary>What the comment formatter keeps as written: XML text, commented-out code, lines outside the range, odd line breaks.</summary>
public sealed class CommentFormattingSafetyTests
{
    private static FormatterOptions Options() => FormatterOptions.FromSettings(new CommentFormatSettings());

    private static string FormatStep(string source, int? startLine = null, int? endLine = null) =>
        FormatCommentsStep.FormatComments(source, StepHarness.Settings(StepHarness.AllOff()), startLine, endLine);

    [Fact]
    public async Task LoneCarriageReturnInACommentBlock_DoesNotHangTheFormatter()
    {
        var words = string.Join(' ', Enumerable.Repeat("word", 60));
        var source = "class C\n{\n    // " + words + "\r    // next\n    void M() { }\n}\n";

        var output = await FinishesAsync(() => CodeComment.FormatComments(source, Options()));

        Assert.Contains("next", output, StringComparison.Ordinal);
    }

    [Fact]
    public async Task CommentLineRegex_FailsFastOnALoneCarriageReturnAfterManyWords()
    {
        var line = "// " + string.Join(' ', Enumerable.Repeat("word", 60)) + "\r// next";

        await FinishesAsync(() => CodeCommentHelper.GetCommentRegex().Match(line).Success);
    }

    private static async Task<T> FinishesAsync<T>(Func<T> work)
    {
        var task = Task.Run(work);
        var finished = await Task.WhenAny(task, Task.Delay(TimeSpan.FromSeconds(10)));

        Assert.True(ReferenceEquals(finished, task), "the comment formatting did not finish within 10 seconds");

        return await task;
    }

    [Fact]
    public void CommentLineRegex_CapturesTheWordsOfALine()
    {
        var match = CodeCommentHelper.GetCommentRegex().Match("  //   one  two\tthree  ");

        Assert.True(match.Success);
        Assert.Equal(["one", "two", "three"], match.Groups["words"].Captures.Select(capture => capture.Value));
        Assert.Equal("one  two\tthree  ", match.Groups["line"].Value);
    }

    [Fact]
    public void XmlText_KeepsAGreaterThanSignAsWritten()
    {
        const string Source = "/// <summary>\n/// Returns a > b and x -> y.\n/// </summary>\n";

        var output = CommentTextFormatter.Format(Source, "///", null, null, null);

        Assert.Contains("Returns a > b and x -> y.", output, StringComparison.Ordinal);
        Assert.DoesNotContain("&gt;", output, StringComparison.Ordinal);
    }

    [Fact]
    public void XmlText_KeepsEntityReferencesAsWritten()
    {
        const string Source = "/// <summary>\n/// Quote &quot;q&quot; &apos;a&apos; &#65; &#x42; &amp; &lt;T&gt;.\n/// </summary>\n";

        var output = CommentTextFormatter.Format(Source, "///", null, null, null);

        Assert.Contains("Quote &quot;q&quot; &apos;a&apos; &#65; &#x42; &amp; &lt;T&gt;.", output, StringComparison.Ordinal);
    }

    [Fact]
    public void XmlText_KeepsAnEntityAfterAnInlineTag()
    {
        const string Source = "/// <summary>\n/// See <see cref=\"List{T}\" /> for a &amp; b &gt; c.\n/// </summary>\n";

        var output = CommentTextFormatter.Format(Source, "///", null, null, null);

        Assert.Contains("for a &amp; b &gt; c.", output, StringComparison.Ordinal);
        Assert.Contains("cref=\"List{T}\"", output, StringComparison.Ordinal);
    }

    [Fact]
    public void CommentedOutCode_WithoutASpaceAfterTheSlashes_IsNotReflowed()
    {
        const string Source = "class C\n{\n    //if (x)\n    //{\n    //    y();\n    //}\n    void M() { }\n}\n";

        Assert.Equal(Source, FormatStep(Source));
    }

    [Fact]
    public void CommentedOutStatement_WithoutASpaceAfterTheSlashes_IsNotSpaced()
    {
        const string Source = "class C\n{\n    void M()\n    {\n        //Console.WriteLine(x);\n    }\n}\n";

        Assert.Equal(Source, FormatStep(Source));
        Assert.Equal(Source, new CommentFormatConverter().Apply(Source));
    }

    [Fact]
    public void ProseWithoutASpaceAfterTheSlashes_IsStillSpaced()
    {
        Assert.Equal(
            "class C\n{\n    // first comment\n    void M() { }\n    // second comment\n}\n",
            FormatStep("class C\n{\n    //first comment\n    void M() { }\n    //second comment\n}\n"));
    }

    [Fact]
    public void ProseNextToCommentedOutCode_IsSpacedWhileTheCodeIsKept()
    {
        Assert.Equal(
            "class C\n{\n    // explains the block\n    void M()\n    {\n        //if (x)\n        //{\n        //}\n    }\n}\n",
            FormatStep("class C\n{\n    //explains the block\n    void M()\n    {\n        //if (x)\n        //{\n        //}\n    }\n}\n"));
    }

    [Theory]
    [InlineData(1, 1, "// aaa\n// bbb\n// ccc\n")]
    [InlineData(2, 2, "// aaa\n// bbb\n// ccc\n")]
    [InlineData(0, 0, "// aaa bbb ccc\n")]
    [InlineData(null, null, "// aaa bbb ccc\n")]
    public void Range_FormatsOnlyTheCommentsThatStartInIt(int? startLine, int? endLine, string expected)
    {
        Assert.Equal(expected, CodeComment.FormatComments("// aaa\n// bbb\n// ccc\n", Options(), startLine, endLine));
    }

    [Fact]
    public void Range_StartingInsideACommentLeavesItsFirstLinesAlone()
    {
        const string Source = "class C\n{\n    // aaa\n    // bbb\n    void M() { }\n    // ccc\n    // ddd\n}\n";

        Assert.Equal("class C\n{\n    // aaa\n    // bbb\n    void M() { }\n    // ccc ddd\n}\n", CodeComment.FormatComments(Source, Options(), 3, 6));
    }
}
