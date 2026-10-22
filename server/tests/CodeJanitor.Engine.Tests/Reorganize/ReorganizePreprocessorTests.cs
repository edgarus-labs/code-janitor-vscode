using CodeJanitor.Engine.Reorganize;
using Xunit;
using static CodeJanitor.Engine.Tests.Reorganize.ReorganizeHarness;

namespace CodeJanitor.Engine.Tests.Reorganize;

public sealed class ReorganizePreprocessorTests
{

    // Files with preprocessor conditionals are only reorganized when PerformWhenPreprocessorConditionals is Yes.
    private const string WithConditional = "class C\n{\n    void B() { }\n#if DEBUG\n    void Debug() { }\n#endif\n    int _f;\n}\n";

    // reorganize: preprocessor conditionals
    [Fact]
    public void DetectsTheDirectivesTheVisualStudioCheckLooksFor()
    {
        Assert.True(Reorganizer.HasPreprocessorConditionals("  #if X\n"));
        Assert.True(Reorganizer.HasPreprocessorConditionals("#else\n"));
        Assert.True(Reorganizer.HasPreprocessorConditionals("#elif X\n"));
        Assert.True(Reorganizer.HasPreprocessorConditionals("#endif\n"));
        Assert.True(Reorganizer.HasPreprocessorConditionals("\t#pragma warning disable CS0169\n"));
        Assert.False(Reorganizer.HasPreprocessorConditionals("#region X\n#endregion\n#nullable enable\n// #if not a directive\n"));
    }

    [Fact]
    public void DetectsADirectiveWrittenWithWhitespaceAfterTheHash()
    {
        var spaced = WithConditional.Replace("#if DEBUG", "# if DEBUG").Replace("#endif", "#\tendif");
        var result = Detailed(spaced, new ReorganizeSettings { PerformWhenPreprocessorConditionals = PreprocessorPolicy.Ask }, ReorganizeCleanup.WithoutPadding);

        Assert.True(Reorganizer.HasPreprocessorConditionals("  # pragma warning disable CS0169\n"));
        Assert.True(result.BlockedByPreprocessor);
        Assert.Equal(spaced, result.Output);
    }

    [Theory]
    [InlineData(PreprocessorPolicy.Ask)]
    [InlineData(PreprocessorPolicy.No)]
    public void LeavesAFileWithConditionalsAloneWhenThePolicyIsAskOrNo(PreprocessorPolicy policy)
    {
        var result = Detailed(WithConditional, new ReorganizeSettings { PerformWhenPreprocessorConditionals = policy }, ReorganizeCleanup.WithoutPadding);

        Assert.Equal(WithConditional, result.Output);
        Assert.True(result.BlockedByPreprocessor);
    }

    [Fact]
    public void MovesAIfBlockTogetherWithItsMemberWhenThePolicyIsYes()
    {
        Assert.Equal("class C\n{\n    int _f;\n    void B() { }\n#if DEBUG\n    void Debug() { }\n#endif\n}\n", Run(WithConditional, new ReorganizeSettings { PerformWhenPreprocessorConditionals = PreprocessorPolicy.Yes }));
    }

    [Fact]
    public void MovesAIfElseBlockAsOneMemberAndSortsItAsItsFirstMember()
    {
        var source = "class C\n{\n#if A\n    void Z() { }\n#else\n    void Z(int x) { }\n#endif\n    void B() { }\n    int _f;\n}\n";

        Assert.Equal("class C\n{\n    int _f;\n    void B() { }\n#if A\n    void Z() { }\n#else\n    void Z(int x) { }\n#endif\n}\n", Run(source, new ReorganizeSettings { PerformWhenPreprocessorConditionals = PreprocessorPolicy.Yes }));
    }

    [Fact]
    public void KeepsTheCommentAboveAIfBlockWithIt()
    {
        var source = "class C\n{\n    // debug only\n#if DEBUG\n    void Debug() { }\n#endif\n    int _f;\n}\n";

        Assert.Equal("class C\n{\n    int _f;\n    // debug only\n#if DEBUG\n    void Debug() { }\n#endif\n}\n", Run(source, new ReorganizeSettings { PerformWhenPreprocessorConditionals = PreprocessorPolicy.Yes }));
    }

    [Fact]
    public void NeverMovesMembersAcrossAPragma()
    {
        var source = "class C\n{\n    void B() { }\n#pragma warning disable CS0169\n    int _unused;\n#pragma warning restore CS0169\n    int _a;\n}\n";

        Assert.Equal(source, Run(source, new ReorganizeSettings { PerformWhenPreprocessorConditionals = PreprocessorPolicy.Yes }));
    }

    [Fact]
    public void NeverMovesAIfBlockHoldingANullableOrPragmaWhichChangesTheContextOfTheMembersAfterIt()
    {
        var nullable = "class C\n{\n    string z;\n#if DEBUG\n#nullable enable\n    string a = \"\";\n#endif\n}\n";
        var pragma = "class C\n{\n    int _z;\n#if DEBUG\n#pragma warning disable CS0169\n    int _a;\n#endif\n}\n";

        Assert.Equal(nullable, Run(nullable, new ReorganizeSettings { PerformWhenPreprocessorConditionals = PreprocessorPolicy.Yes }));
        Assert.Equal(pragma, Run(pragma, new ReorganizeSettings { PerformWhenPreprocessorConditionals = PreprocessorPolicy.Yes }));
    }

    [Fact]
    public void SortsTheMembersBetweenTwoPragmas()
    {
        var source = "#pragma warning disable CS1591\nclass C\n{\n#pragma warning disable CS0169\n    void B() { }\n    int _a;\n#pragma warning restore CS0169\n}\n";

        Assert.Equal("#pragma warning disable CS1591\nclass C\n{\n#pragma warning disable CS0169\n    int _a;\n    void B() { }\n#pragma warning restore CS0169\n}\n", Run(source, new ReorganizeSettings { PerformWhenPreprocessorConditionals = PreprocessorPolicy.Yes }));
    }

    [Fact]
    public void LeavesATypeAloneAndReportsItWhenAIfBlockDoesNotEndInsideIt()
    {
        var source = "class C\n{\n    void B() { }\n#if A\n    int _f;\n}\n#endif\n";
        var result = Detailed(source, new ReorganizeSettings { PerformWhenPreprocessorConditionals = PreprocessorPolicy.Yes }, ReorganizeCleanup.Default);

        Assert.Equal(source, result.Output);
        Assert.NotEmpty(result.Skipped);
    }

    [Fact]
    public void LeavesATypeAloneAndReportsItWhenAIfSplitsADeclarationTheParserCannotRead()
    {
        var source = "class C\n{\n    void B() { }\n    int Split\n#if A\n        => 1;\n#else\n        => 2;\n#endif\n    int _f;\n}\n";
        var result = Detailed(source, new ReorganizeSettings { PerformWhenPreprocessorConditionals = PreprocessorPolicy.Yes }, ReorganizeCleanup.WithoutPadding);

        Assert.Equal(source, result.Output);
        Assert.Contains("C (line 1): skipped because of an unbalanced #if directive", result.Skipped);
    }

    [Fact]
    public void KeepsIfDirectivesInsideAMemberBodyWhereTheyAre()
    {
        var source = "class C\n{\n    int B()\n    {\n#if A\n        return 1;\n#else\n        return 2;\n#endif\n    }\n    int _f;\n}\n";

        Assert.Equal("class C\n{\n    int _f;\n    int B()\n    {\n#if A\n        return 1;\n#else\n        return 2;\n#endif\n    }\n}\n", Run(source, new ReorganizeSettings { PerformWhenPreprocessorConditionals = PreprocessorPolicy.Yes }));
    }

    [Fact]
    public void DoesNotTreatRegionsAsConditionals()
    {
        var source = "class C\n{\n    #region R\n    void B() { }\n    int _f;\n    #endregion\n}\n";

        Assert.Equal("class C\n{\n    #region R\n    int _f;\n    void B() { }\n    #endregion\n}\n", Run(source));
        Assert.Equal(PreprocessorPolicy.Ask, new ReorganizeSettings().PerformWhenPreprocessorConditionals);
    }
}

