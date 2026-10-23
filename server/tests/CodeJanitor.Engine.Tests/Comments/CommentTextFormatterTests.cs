using System.Text.Json.Nodes;
using CodeJanitor.Engine.Comments;
using Xunit;

namespace CodeJanitor.Engine.Tests.Comments;

public sealed class CommentTextFormatterTests
{
    private static readonly JsonObject Narrow = new() { ["commentFormat"] = new JsonObject { ["wrapColumn"] = 20 } };

    [Fact]
    public void Wraps_a_Visual_Basic_comment()
    {
        Assert.Equal(
            "' one two three four\n' five six\n",
            CommentTextFormatter.Format("' one two three four five six\n", "'", Narrow, null, null));
    }

    [Fact]
    public void Joins_the_lines_of_a_comment_with_the_same_prefix()
    {
        Assert.Equal("# one two three\n", CommentTextFormatter.Format("# one\n# two three\n", "#", null, null, null));
    }

    [Fact]
    public void Keeps_commented_out_code_without_a_space_after_the_prefix()
    {
        const string code = "'Dim x = 1   \n";

        Assert.Equal(code, CommentTextFormatter.Format(code, "'", Narrow, null, null));
    }

    [Fact]
    public void Formats_the_xml_documentation_of_a_Visual_Basic_member()
    {
        Assert.Equal(
            "''' <summary>\n''' Does it.\n''' </summary>\nSub M()\nEnd Sub\n",
            CommentTextFormatter.Format("''' <summary>Does it.</summary>\nSub M()\nEnd Sub\n", "'", null, null, null));
    }

    [Fact]
    public void Ignores_a_prefix_inside_a_line_of_code()
    {
        const string code = "x = \"it's\" ' a   b\n";

        Assert.Equal(code, CommentTextFormatter.Format(code, "'", null, null, null));
    }

    [Fact]
    public void Honours_the_ignore_prefixes()
    {
        var settings = new JsonObject { ["commentFormat"] = new JsonObject { ["wrapColumn"] = 20, ["ignoreLinesStartingWith"] = new JsonArray("KEEP") } };
        const string kept = "// KEEP one two three four five six\n";

        Assert.Equal(kept, CommentTextFormatter.Format(kept, "//", settings, null, null));
    }

    [Fact]
    public void Splits_an_upper_case_summary_it_lower_cases_in_one_pass()
    {
        var settings = new JsonObject { ["commentFormat"] = new JsonObject { ["xmlTagsToLowerCase"] = true } };

        Assert.Equal("/// <summary>\n/// Returns.\n/// </summary>\n", CommentTextFormatter.Format("/// <SUMMARY>Returns.</SUMMARY>\n", "//", settings, null, null));
    }

    [Theory]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData("'\n")]
    public void Rejects_a_prefix_that_is_not_a_comment_marker(string prefix)
    {
        Assert.Throws<ArgumentException>(() => CommentTextFormatter.Format("' a\n", prefix, null, null, null));
    }
}
