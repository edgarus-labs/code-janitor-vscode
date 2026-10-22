using System.Text.Json.Nodes;
using CodeJanitor.Engine.Queries;
using Xunit;

namespace CodeJanitor.Engine.Tests.Queries;

/// <summary>
/// The <c>branches</c> query: the branches of a method and which of them its tests cover.
/// </summary>
public sealed class BranchesQueryTests
{
    private const string FormatName =
        "using System;\n" +
        "class C\n" +
        "{\n" +
        "    public string FormatName(string firstName, string lastName)\n" +
        "    {\n" +
        "        if (firstName == null) throw new ArgumentNullException(nameof(firstName));\n" +
        "        if (lastName == null) return firstName;\n" +
        "        else return firstName + \" \" + lastName;\n" +
        "    }\n" +
        "}\n";

    private static async Task<JsonObject> At(string source, int line, int character = 8, string? testCode = null)
    {
        var arguments = new JsonObject { ["line"] = line, ["character"] = character };
        if (testCode is not null)
        {
            arguments["testCode"] = testCode;
        }

        return (JsonObject)(await QueryRunner.RunAsync(new BranchesQuery(), source, arguments))!;
    }

    private static string[] Field(JsonObject result, string key) =>
        result["branches"]!.AsArray().Select(branch => branch![key]!.ToString()).ToArray();

    [Fact]
    public async Task FindsGuardClausesElseBranchesAndThrows_InTheMemberAtThePosition()
    {
        var result = await At(FormatName, 5);

        var target = result["target"]!;
        Assert.Equal("FormatName", target["name"]!.GetValue<string>());
        Assert.Equal("method", target["kind"]!.GetValue<string>());
        Assert.Equal(3, target["startLine"]!.GetValue<int>());
        Assert.Equal(8, target["endLine"]!.GetValue<int>());
        Assert.Equal(["B1", "B2", "B3", "B4"], Field(result, "id"));
        Assert.Equal(["guardClause", "guardClause", "elseBranch", "throwException"], Field(result, "type"));
        Assert.Equal(["firstName == null", "lastName == null", "!(lastName == null)", "new ArgumentNullException(nameof(firstName))"], Field(result, "condition"));
        Assert.Equal(["5", "6", "7", "5"], Field(result, "line"));
        Assert.Equal("Guard Clause: If (firstName == null) early exit/throw", Field(result, "description")[0]);
        Assert.Equal("Else branch: (lastName == null) is false", Field(result, "description")[2]);
        Assert.Null(result["coverage"]);
    }

    [Fact]
    public async Task FindsSwitchSectionsTernariesAndNullCoalescing()
    {
        const string Source =
            "class C\n" +
            "{\n" +
            "    public int Calculate(int? value, string mode)\n" +
            "    {\n" +
            "        var val = value ?? 0;\n" +
            "        var factor = mode == \"Double\" ? 2 : 1;\n" +
            "        switch (mode)\n" +
            "        {\n" +
            "            case \"A\": return val * 10;\n" +
            "            case \"B\": return val * 20;\n" +
            "            default: return val * factor;\n" +
            "        }\n" +
            "    }\n" +
            "}\n";

        var result = await At(Source, 4);

        Assert.Equal(["switchCase", "switchCase", "switchCase", "ternary", "nullCoalescing"], Field(result, "type"));
        Assert.Equal(["case \"A\":", "case \"B\":", "default:", "mode == \"Double\"", "value is null"], Field(result, "condition"));
        Assert.Equal(["8", "9", "10", "5", "4"], Field(result, "line"));
        Assert.Equal("Null fallback path: value ?? 0", Field(result, "description")[4]);
    }

    [Fact]
    public async Task FindsSwitchExpressionArmsAndCatchClauses()
    {
        const string Source =
            "using System;\n" +
            "class C\n" +
            "{\n" +
            "    public string Process(int state)\n" +
            "    {\n" +
            "        try\n" +
            "        {\n" +
            "            return state switch\n" +
            "            {\n" +
            "                1 => \"One\",\n" +
            "                _ => \"Other\"\n" +
            "            };\n" +
            "        }\n" +
            "        catch (InvalidOperationException)\n" +
            "        {\n" +
            "            return \"Error\";\n" +
            "        }\n" +
            "    }\n" +
            "}\n";

        var result = await At(Source, 5);

        Assert.Equal(["switchCase", "switchCase", "catchBlock"], Field(result, "type"));
        Assert.Equal(["1", "_", "InvalidOperationException"], Field(result, "condition"));
        Assert.Equal(["Switch expression arm: 1", "Switch expression arm: _", "Exception handled: catch (InvalidOperationException)"], Field(result, "description"));
    }

    [Fact]
    public async Task ALinearMember_HasOneHappyPathBranch_OnItsFirstLine()
    {
        var result = await At("class C\n{\n    public void Log()\n    {\n        System.Console.WriteLine(\"hi\");\n    }\n}\n", 4);

        Assert.Equal(["B1"], Field(result, "id"));
        Assert.Equal(["ifBranch"], Field(result, "type"));
        Assert.Equal(["default"], Field(result, "condition"));
        Assert.Equal(["2"], Field(result, "line"));
        Assert.Equal("Standard primary execution path (Happy path)", Field(result, "description")[0]);
    }

    [Fact]
    public async Task OutsideEveryMember_AnalyzesTheWholeFile()
    {
        var result = await At(FormatName, 0, 0);

        Assert.Equal("file", result["target"]!["kind"]!.GetValue<string>());
        Assert.Equal("Test.cs", result["target"]!["name"]!.GetValue<string>());
        Assert.Equal(0, result["target"]!["startLine"]!.GetValue<int>());
        Assert.Equal(4, Field(result, "id").Length);
    }

    [Fact]
    public async Task AnEmptyFile_HasNoTargetAndNoBranches()
    {
        var result = await At(string.Empty, 0, 0);

        Assert.Null(result["target"]);
        Assert.Empty(result["branches"]!.AsArray());
    }

    [Fact]
    public async Task WithTestCode_EvaluatesTheCoverageOfTheBranches()
    {
        const string Tests =
            "public class FormatNameTests\n" +
            "{\n" +
            "    [Fact]\n" +
            "    public void FormatName_WhenNull_Throws() { }\n" +
            "\n" +
            "    public void Helper() { }\n" +
            "}\n";

        var coverage = (await At(FormatName, 5, testCode: Tests))["coverage"]!;

        Assert.Equal(4, coverage["totalBranches"]!.GetValue<int>());
        Assert.Equal(3, coverage["coveredBranches"]!.GetValue<int>());
        Assert.Equal(75, coverage["percentage"]!.GetValue<int>());
        Assert.Equal(["B1", "B2", "B4"], coverage["covered"]!.AsArray().Select(id => id!.GetValue<string>()));
        Assert.Equal(["B3"], coverage["uncovered"]!.AsArray().Select(id => id!.GetValue<string>()));
        Assert.Equal(["FormatName_WhenNull_Throws"], coverage["scenarios"]!.AsArray().Select(name => name!.GetValue<string>()));
    }
}

/// <summary>The branch coverage heuristics.</summary>
public sealed class BranchCoverageTests
{
    [Fact]
    public void EmptyTestCode_CoversNothing_TestsNamedAfterTheBranches_CoverThem()
    {
        IReadOnlyList<CodeBranch> branches =
        [
            new("B1", CodeBranchType.IfBranch, "Happy path", "valid", 1),
            new("B2", CodeBranchType.GuardClause, "Null check", "arg is null", 2),
        ];
        const string Tests =
            "public class SampleTests\n{\n    [Fact]\n    public void Method_ValidInput_ReturnsSuccess() { }\n\n" +
            "    [Fact]\n    public void Method_WhenNull_ThrowsArgumentNullException() { }\n}\n";

        var empty = BranchCoverage.Evaluate(branches, string.Empty);
        var covered = BranchCoverage.Evaluate(branches, Tests);

        Assert.Equal(0, empty.Percentage);
        Assert.Equal(2, empty.Uncovered.Count);
        Assert.Equal(100, covered.Percentage);
        Assert.Equal(2, covered.Covered.Count);
        Assert.Empty(covered.Uncovered);
    }

    [Fact]
    public void NoBranches_IsFullyCovered_SwitchElseAndCatchBranches_MatchByKeywordOrCaseValue()
    {
        IReadOnlyList<CodeBranch> branches =
        [
            new("B1", CodeBranchType.SwitchCase, "case \"Active\"", "case \"Active\":", 1),
            new("B2", CodeBranchType.ElseBranch, "Else branch", "!isActive", 2),
            new("B3", CodeBranchType.CatchBlock, "catch (IOException)", "IOException", 3),
        ];
        const string Tests =
            "public class ServiceTests\n{\n    [Fact]\n    public void WhenActive_ReturnsTrue() { var status = \"Active\"; }\n\n" +
            "    [Fact]\n    public void WhenNotActive_ReturnsFalse() { }\n\n" +
            "    [Fact]\n    public void WhenExceptionThrown_CatchesError() { }\n}\n";

        Assert.Equal(100, BranchCoverage.Evaluate([], "public void Test() {}").Percentage);
        var result = BranchCoverage.Evaluate(branches, Tests);
        Assert.Equal(3, result.Covered.Count);
        Assert.Equal(100, result.Percentage);
    }

    [Fact]
    public void TestsMatchingNoBranch_StillCoverTheFirstOne()
    {
        IReadOnlyList<CodeBranch> branches =
        [
            new("B1", CodeBranchType.CatchBlock, "catch", "IOException", 1),
            new("B2", CodeBranchType.CatchBlock, "catch", "TimeoutException", 2),
            new("B3", CodeBranchType.CatchBlock, "catch", "FormatException", 3),
        ];

        var result = BranchCoverage.Evaluate(branches, "class T\n{\n    [Test]\n    public void Plain() { }\n}\n");

        Assert.Equal(["B1"], result.Covered.Select(branch => branch.Id));
        Assert.Equal(33, result.Percentage);
    }
}
