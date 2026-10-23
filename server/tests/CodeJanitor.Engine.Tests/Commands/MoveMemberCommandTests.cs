using System.Text.Json.Nodes;
using CodeJanitor.Engine.Commands;
using CodeJanitor.Engine.Contracts;
using CodeJanitor.Engine.Tests.Steps.Support;
using Xunit;
using static CodeJanitor.Engine.Tests.Reorganize.ReorganizeHarness;

namespace CodeJanitor.Engine.Tests.Commands;

internal static class MemberCommandRunner
{
    public static async Task<string> RunAsync(IDocumentCommand command, string source, JsonObject arguments)
    {
        var document = await DocumentAsync(source);
        var solution = await command.ExecuteAsync(document, EngineSettings(), arguments, CancellationToken.None);

        return (await solution.GetDocument(document.Id)!.GetTextAsync()).ToString();
    }

    /// <summary>Runs the command on a testbed scenario with the scenario's <paramref name="argumentsKey" /> field as arguments, and checks it.</summary>
    public static async Task<string> ScenarioFailuresAsync(IDocumentCommand command, string id, string argumentsKey)
    {
        var scenario = LocalTestbed.Scenario(id);
        var document = await DocumentAsync(LocalTestbed.Text(scenario), LocalTestbed.FilePath(scenario));
        var solution = await command.ExecuteAsync(document, EngineSettings(), scenario[argumentsKey]!.AsObject().DeepClone().AsObject(), CancellationToken.None);

        return LocalTestbed.Failures(scenario, (await solution.GetDocument(document.Id)!.GetTextAsync()).ToString(), []);
    }
}

/// <summary>The testbed scenarios of Spade's move and delete.</summary>
public sealed class SpadeCommandScenarioTests
{
    [Fact]
    public async Task MoveMember_Scenario() =>
        Assert.Equal(string.Empty, await MemberCommandRunner.ScenarioFailuresAsync(new MoveMemberCommand(), "MoveMember", "move"));

    [Fact]
    public async Task DeleteMember_Scenario() =>
        Assert.Equal(string.Empty, await MemberCommandRunner.ScenarioFailuresAsync(new DeleteMemberCommand(), "DeleteMember", "delete"));
}

/// <summary>The <c>moveMember</c> command behind Spade's drag and drop.</summary>
public sealed class MoveMemberCommandTests
{
    private const string Spaced =
        "using System;\n" +
        "class C\n" +
        "{\n" +
        "    /// <summary>A.</summary>\n" +
        "    [Obsolete]\n" +
        "    void A() { }\n" +
        "\n" +
        "    void B() { }\n" +
        "\n" +
        "    // D.\n" +
        "    void D() { }\n" +
        "}\n";

    private static Task<string> Move(string source, int line, string name, int targetLine, string targetName, string position) =>
        MemberCommandRunner.RunAsync(new MoveMemberCommand(), source, new JsonObject
        {
            ["line"] = line,
            ["name"] = name,
            ["targetLine"] = targetLine,
            ["targetName"] = targetName,
            ["position"] = position,
        });

    [Fact]
    public async Task MovesAMemberAfterASibling_WithItsDocumentationAttributesAndBlankLineSeparation()
    {
        var moved = await Move(Spaced, 4, "A", 10, "D", "after");

        Assert.Equal(
            "using System;\nclass C\n{\n    void B() { }\n\n    // D.\n    void D() { }\n\n    /// <summary>A.</summary>\n    [Obsolete]\n    void A() { }\n}\n",
            moved);
    }

    [Fact]
    public async Task MovesAMemberBeforeASibling_WithItsComment()
    {
        var moved = await Move(Spaced, 10, "D", 7, "B", "before");

        Assert.Equal(
            "using System;\nclass C\n{\n    /// <summary>A.</summary>\n    [Obsolete]\n    void A() { }\n\n    // D.\n    void D() { }\n\n    void B() { }\n}\n",
            moved);
    }

    [Fact]
    public async Task KeepsMembersWithoutBlankLinesBetweenThemTogether()
    {
        var moved = await Move("class C\n{\n    int a;\n    int b;\n    int c;\n}\n", 2, "a", 4, "c", "after");

        Assert.Equal("class C\n{\n    int b;\n    int c;\n    int a;\n}\n", moved);
    }

    [Fact]
    public async Task MovesAMemberWithTheWholeBlockCommentAboveIt()
    {
        const string Source = "class C\n{\n    void A() { }\n\n    /*\n    void Old() { }\n    */\n    void B() { }\n}\n";

        var moved = await Move(Source, 7, "B", 2, "A", "before");

        Assert.Equal("class C\n{\n    /*\n    void Old() { }\n    */\n    void B() { }\n\n    void A() { }\n}\n", moved);
    }

    [Fact]
    public async Task LeavesPreprocessorDirectivesInPlace()
    {
        const string Source = "class C\n{\n    void A() { }\n#if DEBUG\n#endif\n    void B() { }\n}\n";

        var moved = await Move(Source, 5, "B", 2, "A", "before");

        Assert.Equal("class C\n{\n    void B() { }\n    void A() { }\n#if DEBUG\n#endif\n}\n", moved);
    }

    [Fact]
    public async Task MovesEnumMembers_KeepingTheCommas()
    {
        var moved = await Move("enum E\n{\n    A,\n    B,\n    C\n}\n", 2, "A", 4, "C", "after");

        Assert.Equal("enum E\n{\n    B,\n    C,\n    A\n}\n", moved);
    }

    [Fact]
    public async Task MovesTypesWithinTheirNamespace()
    {
        var moved = await Move("namespace N;\n\nclass A { }\n\nclass B { }\n", 4, "B", 2, "A", "before");

        Assert.Equal("namespace N;\n\nclass B { }\n\nclass A { }\n", moved);
    }

    [Fact]
    public async Task RefusesAMoveThatAddsACompilerError()
    {
        const string Source =
            "enum E\n{\n    A = 1,\n    B,\n    C = 0\n}\n" +
            "class C\n{\n    void M(E e)\n    {\n        switch (e)\n        {\n            case E.B: break;\n            case E.C: break;\n        }\n    }\n}\n";

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => Move(Source, 3, "B", 2, "A", "before"));

        Assert.Contains("CS0152", error.Message, StringComparison.Ordinal);
        Assert.StartsWith("Moving 'B' would add the compiler error", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task RefusesMembersOfDifferentParents()
    {
        const string Source = "class A\n{\n    void M() { }\n}\nclass B\n{\n    void N() { }\n}\n";

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => Move(Source, 2, "M", 6, "N", "before"));

        Assert.Equal("'M' and 'N' are not members of the same parent.", error.Message);
    }

    [Fact]
    public async Task RefusesAMemberThatIsNotFound()
    {
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => Move(Spaced, 1, "Missing", 7, "B", "before"));

        Assert.Equal("There is no member 'Missing' on line 2.", error.Message);
    }
}

/// <summary>The <c>deleteMember</c> command behind Spade's Delete.</summary>
public sealed class DeleteMemberCommandTests
{
    private static Task<string> Delete(string source, int line, string? name = null)
    {
        var arguments = new JsonObject { ["line"] = line };
        if (name is not null)
        {
            arguments["name"] = name;
        }

        return MemberCommandRunner.RunAsync(new DeleteMemberCommand(), source, arguments);
    }

    [Fact]
    public async Task DeletesAMemberWithItsDocumentationAndAttributes_AndOneBlankLine()
    {
        const string Source =
            "using System;\nclass C\n{\n    void A() { }\n\n    /// <summary>B.</summary>\n    [Obsolete]\n    void B()\n    {\n    }\n\n    void D() { }\n}\n";

        Assert.Equal("using System;\nclass C\n{\n    void A() { }\n\n    void D() { }\n}\n", await Delete(Source, 6, "B"));
    }

    [Fact]
    public async Task DeletesTheLastMember_AndTheBlankLineBeforeIt()
    {
        Assert.Equal("class C\n{\n    void A() { }\n}\n", await Delete("class C\n{\n    void A() { }\n\n    void D() { }\n}\n", 4, "D"));
    }

    [Fact]
    public async Task DeletesTheFirstMember_AndTheBlankLineAfterIt()
    {
        Assert.Equal("class C\n{\n    void D() { }\n}\n", await Delete("class C\n{\n    void A() { }\n\n    void D() { }\n}\n", 2, "A"));
    }

    [Fact]
    public async Task DeletesAMemberWithTheWholeBlockCommentAboveIt()
    {
        const string Source = "class C\n{\n    void A() { }\n\n    /*\n    void Old() { }\n    */\n    void B() { }\n}\n";

        Assert.Equal("class C\n{\n    void A() { }\n}\n", await Delete(Source, 7, "B"));
    }

    [Fact]
    public async Task DeletesAMemberWithTheCommentsAboveABlockCommentAboveIt()
    {
        const string Source = "class C\n{\n    void A() { }\n\n    // B.\n    /* old:\n    void Old() { }\n    */\n    void B() { }\n}\n";

        Assert.Equal("class C\n{\n    void A() { }\n}\n", await Delete(Source, 8, "B"));
    }

    [Fact]
    public async Task DeletesOneVariableOfAFieldDeclaringSeveral()
    {
        Assert.Equal("class C\n{\n    int a;\n}\n", await Delete("class C\n{\n    int a, b;\n}\n", 2, "b"));
    }

    [Fact]
    public async Task DeletesAnEnumMember()
    {
        Assert.Equal("enum E\n{\n    A,\n    C\n}\n", await Delete("enum E\n{\n    A,\n    B,\n    C\n}\n", 3, "B"));
    }

    [Fact]
    public async Task DeletesAMemberSharingItsLine()
    {
        Assert.Equal("class C { void B() { } }\n", await Delete("class C { void A() { } void B() { } }\n", 0, "A"));
    }

    [Fact]
    public async Task DeletesAMemberSharingItsLine_KeepingTheDirectiveAboveIt()
    {
        const string Source = "class C\n{\n    #region R\n    public int A; public int B;\n    #endregion\n}\n";

        var deleted = await Delete(Source, 3, "A");

        Assert.Equal(["class C", "{", "#region R", "public int B;", "#endregion", "}"], deleted.Split('\n').Select(line => line.Trim()).Where(line => line.Length > 0));
    }

    [Fact]
    public async Task DeletesOneVariableOfAField_KeepingTheDirectiveBeforeIt()
    {
        const string Source = "class C\n{\n    int a,\n    #region R\n    b;\n    #endregion\n}\n";

        Assert.Equal("class C\n{\n    int a\n    #region R\n;\n    #endregion\n}\n", await Delete(Source, 2, "b"));
    }

    [Fact]
    public async Task DeletesARegionWithItsContent()
    {
        const string Source =
            "class C\n{\n    void A() { }\n\n    #region Helpers\n\n    void B() { }\n\n    #endregion\n\n    void D() { }\n}\n";

        Assert.Equal("class C\n{\n    void A() { }\n\n    void D() { }\n}\n", await Delete(Source, 4));
    }

    [Fact]
    public async Task RefusesALineWithoutMemberOrRegion()
    {
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => Delete("class C\n{\n}\n", 1, "X"));

        Assert.Equal("There is no member 'X' on line 2.", error.Message);
    }
}
