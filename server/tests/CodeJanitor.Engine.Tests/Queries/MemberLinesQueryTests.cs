using System.Text.Json.Nodes;
using CodeJanitor.Engine.Queries;
using Xunit;

namespace CodeJanitor.Engine.Tests.Queries;

/// <summary>The <c>memberLines</c> query behind Spade's Insert Region.</summary>
public sealed class MemberLinesQueryTests
{
    private static Task<JsonNode?> Lines(string source, int line, string name) =>
        QueryRunner.RunAsync(new MemberLinesQuery(), source, new JsonObject { ["line"] = line, ["name"] = name });

    [Fact]
    public async Task TakesInTheCommentsDirectlyAboveAndTheAttributes()
    {
        const string Source = "class C\n{\n    // Note.\n\n    /// <summary>A.</summary>\n    [System.Obsolete]\n    void A()\n    {\n    }\n}\n";

        var lines = (await Lines(Source, 5, "A"))!;

        Assert.Equal(4, lines["startLine"]!.GetValue<int>());
        Assert.Equal(8, lines["endLine"]!.GetValue<int>());
    }

    [Fact]
    public async Task IsNull_ForAMemberSharingItsLines_OrNoMember()
    {
        Assert.Null(await Lines("class C { int a; }\n", 0, "a"));
        Assert.Null(await Lines("class C\n{\n}\n", 1, "x"));
    }
}
