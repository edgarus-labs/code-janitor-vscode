using CodeJanitor.Engine.Steps.Transformations;
using Xunit;

namespace CodeJanitor.Engine.Tests.Steps;

/// <summary>The blank-line removals and the file header of <see cref="FileHeaderAndBlankLines" />.</summary>
public sealed class FileHeaderAndBlankLinesTests
{
    private const string VerbatimString = "class C\n{\n    string s = @\"\n{0}\n\";\n}\n";

    public static TheoryData<string, string> TextsInsideLiteralsAndComments() => new()
    {
        { nameof(FileHeaderAndBlankLines.RemoveBlankLinesAfterAttributes), "[Section]\n\nkey=value" },
        { nameof(FileHeaderAndBlankLines.RemoveBlankLinesAfterDocumentationComments), "/// text\n\nmore" },
        { nameof(FileHeaderAndBlankLines.RemoveBlankLinesAfterOpeningBrace), "{\n\nx" },
        { nameof(FileHeaderAndBlankLines.RemoveBlankLinesBeforeClosingBrace), "x\n\n}" },
        { nameof(FileHeaderAndBlankLines.RemoveBlankLinesBetweenChainedStatements), "a\n\nelse b" },
    };

    [Theory]
    [MemberData(nameof(TextsInsideLiteralsAndComments))]
    public void BlankLineRemoval_KeepsTheTextOfAVerbatimString(string removal, string content)
    {
        var source = VerbatimString.Replace("{0}", content, StringComparison.Ordinal);

        Assert.Equal(source, Remove(removal, source));
    }

    [Theory]
    [MemberData(nameof(TextsInsideLiteralsAndComments))]
    public void BlankLineRemoval_KeepsTheTextOfARawStringLiteral(string removal, string content)
    {
        var source = "class C\n{\n    string s = \"\"\"\n" + content + "\n\"\"\";\n}\n";

        Assert.Equal(source, Remove(removal, source));
    }

    [Fact]
    public void BlankLineRemoval_KeepsTheTextOfAnInterpolatedVerbatimString()
    {
        const string Source = "class C\n{\n    string s = $@\"\n[Section]\n\n{x}\n\";\n}\n";

        Assert.Equal(Source, FileHeaderAndBlankLines.RemoveBlankLinesAfterAttributes(Source));
    }

    [Theory]
    [MemberData(nameof(TextsInsideLiteralsAndComments))]
    public void BlankLineRemoval_KeepsTheTextOfABlockComment(string removal, string content)
    {
        var source = "class C\n{\n    /*\n" + content + "\n    */\n    int x;\n}\n";

        Assert.Equal(source, Remove(removal, source));
    }

    [Theory]
    [MemberData(nameof(TextsInsideLiteralsAndComments))]
    public void BlankLineRemoval_KeepsTheTextOfAStringInAnInactiveBranch(string removal, string content)
    {
        var source = "class C\n{\n#if NEVER\n    string s = @\"\n" + content + "\n\";\n#endif\n}\n";

        Assert.Equal(source, Remove(removal, source));
    }

    [Fact]
    public void BlankLineRemoval_StillActsOnTheCodeAroundALiteral()
    {
        const string Source = "class C\n{\n\n    string s = @\"\n{\n\nx\";\n\n    [A]\n\n    int y;\n\n    /// d\n\n    int z;\n\n}\n";

        var output = FileHeaderAndBlankLines.RemoveBlankLinesAfterOpeningBrace(Source);
        output = FileHeaderAndBlankLines.RemoveBlankLinesBeforeClosingBrace(output);
        output = FileHeaderAndBlankLines.RemoveBlankLinesAfterAttributes(output);
        output = FileHeaderAndBlankLines.RemoveBlankLinesAfterDocumentationComments(output);

        Assert.Equal("class C\n{\n    string s = @\"\n{\n\nx\";\n\n    [A]\n    int y;\n\n    /// d\n    int z;\n}\n", output);
    }

    [Fact]
    public void BlankLineRemoval_ActsOnAMatchRightAfterABlockComment()
    {
        Assert.Equal("class C\n{\n    /* a\n       b */\n}\n", FileHeaderAndBlankLines.RemoveBlankLinesBeforeClosingBrace("class C\n{\n    /* a\n       b */\n\n}\n"));
    }

    [Fact]
    public void FileHeaderReplace_KeepsAnXmlDocumentationCommentAtTheDocumentStart()
    {
        const string Source = "/// <summary>Doc of C</summary>\nclass C { }\n";

        Assert.Equal("// H\n" + Source, FileHeaderAndBlankLines.ApplyFileHeader(Source, "// H", HeaderPosition.DocumentStart, HeaderUpdateMode.Replace));
    }

    [Fact]
    public void FileHeaderReplace_ReplacesTheHeaderButKeepsTheDocumentationCommentThatFollowsIt()
    {
        const string Source = "// Old\n/// <summary>Doc of C</summary>\nclass C { }\n";

        Assert.Equal("// H\n/// <summary>Doc of C</summary>\nclass C { }\n", FileHeaderAndBlankLines.ApplyFileHeader(Source, "// H", HeaderPosition.DocumentStart, HeaderUpdateMode.Replace));
    }

    [Fact]
    public void FileHeaderReplace_KeepsAnXmlDocumentationCommentAfterTheUsings()
    {
        const string Source = "using System;\n\n/// <summary>Doc of C</summary>\nclass C { }\n";

        var output = FileHeaderAndBlankLines.ApplyFileHeader(Source, "// H", HeaderPosition.AfterUsings, HeaderUpdateMode.Replace);

        Assert.Equal("using System;\n\n// H\n\n/// <summary>Doc of C</summary>\nclass C { }\n", output);
        Assert.Equal(output, FileHeaderAndBlankLines.ApplyFileHeader(output, "// H", HeaderPosition.AfterUsings, HeaderUpdateMode.Replace));
    }

    [Fact]
    public void FileHeaderReplace_KeepsABlockDocumentationComment()
    {
        const string Source = "/** <summary>Doc of C</summary> */\nclass C { }\n";

        Assert.Equal("// H\n" + Source, FileHeaderAndBlankLines.ApplyFileHeader(Source, "// H", HeaderPosition.DocumentStart, HeaderUpdateMode.Replace));
    }

    [Theory]
    [InlineData("//////////\n// Old\n//////////\nclass C { }\n")]
    [InlineData("/* Old */\nclass C { }\n")]
    [InlineData("/***********\n * Old\n ***********/\nclass C { }\n")]
    public void FileHeaderReplace_StillReplacesOtherCommentHeaders(string source)
    {
        Assert.Equal("// H\nclass C { }\n", FileHeaderAndBlankLines.ApplyFileHeader(source, "// H", HeaderPosition.DocumentStart, HeaderUpdateMode.Replace));
    }

    private static string Remove(string removal, string source) => removal switch
    {
        nameof(FileHeaderAndBlankLines.RemoveBlankLinesAfterAttributes) => FileHeaderAndBlankLines.RemoveBlankLinesAfterAttributes(source),
        nameof(FileHeaderAndBlankLines.RemoveBlankLinesAfterDocumentationComments) => FileHeaderAndBlankLines.RemoveBlankLinesAfterDocumentationComments(source),
        nameof(FileHeaderAndBlankLines.RemoveBlankLinesAfterOpeningBrace) => FileHeaderAndBlankLines.RemoveBlankLinesAfterOpeningBrace(source),
        nameof(FileHeaderAndBlankLines.RemoveBlankLinesBeforeClosingBrace) => FileHeaderAndBlankLines.RemoveBlankLinesBeforeClosingBrace(source),
        nameof(FileHeaderAndBlankLines.RemoveBlankLinesBetweenChainedStatements) => FileHeaderAndBlankLines.RemoveBlankLinesBetweenChainedStatements(source),
        _ => throw new ArgumentOutOfRangeException(nameof(removal), removal, null),
    };
}
