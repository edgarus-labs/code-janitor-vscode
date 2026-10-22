using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace CodeJanitor.Engine.Queries;

/// <summary>How much of the branches a test suite covers, by the heuristics of <see cref="BranchCoverage" />.</summary>
public sealed record CoverageEvaluation(int Percentage, IReadOnlyList<CodeBranch> Covered, IReadOnlyList<CodeBranch> Uncovered, IReadOnlyList<string> Scenarios);

/// <summary>
/// The estimated branch coverage of generated tests: the Visual Studio extension's <c>BranchCoverageEvaluator</c>. The
/// scenarios are the test methods (an attribute whose name holds <c>Fact</c>, <c>Test</c> or <c>Theory</c>); a branch
/// is covered when a scenario's name holds a keyword of its kind (or, for a switch case, its value appears in the
/// tests), or when the tests hold its condition. Tests covering no branch still cover the first one (the happy path).
/// No branches is 100%, blank tests 0%.
/// </summary>
internal static class BranchCoverage
{
    public static CoverageEvaluation Evaluate(IReadOnlyList<CodeBranch> branches, string testCode)
    {
        if (branches.Count == 0)
        {
            return new CoverageEvaluation(100, [], [], []);
        }

        if (string.IsNullOrWhiteSpace(testCode))
        {
            return new CoverageEvaluation(0, [], branches, []);
        }

        var scenarios = Scenarios(testCode);
        var covered = branches.Where(branch => IsCovered(branch, scenarios, testCode)).ToList();
        if (scenarios.Count > 0 && covered.Count == 0)
        {
            covered.Add(branches[0]);
        }

        var uncovered = branches.Where(branch => !covered.Contains(branch)).ToList();
        var percentage = Math.Min(100, (int)Math.Round((double)covered.Count / branches.Count * 100));

        return new CoverageEvaluation(percentage, covered, uncovered, scenarios);
    }

    private static List<string> Scenarios(string testCode) =>
        CSharpSyntaxTree.ParseText(testCode).GetRoot().DescendantNodes().OfType<MethodDeclarationSyntax>()
            .Where(method => method.AttributeLists.SelectMany(list => list.Attributes).Any(attribute => IsTestAttribute(attribute.Name.ToString())))
            .Select(method => method.Identifier.Text)
            .ToList();

    private static bool IsTestAttribute(string name) =>
        name.Contains("Fact", StringComparison.Ordinal) || name.Contains("Test", StringComparison.Ordinal) || name.Contains("Theory", StringComparison.Ordinal);

    private static bool IsCovered(CodeBranch branch, IReadOnlyList<string> scenarios, string testCode)
    {
        foreach (var scenario in scenarios.Select(scenario => scenario.ToLowerInvariant()))
        {
            var matches = branch.Type switch
            {
                CodeBranchType.GuardClause or CodeBranchType.ThrowException => HasAny(scenario, "throw", "null", "invalid", "empty", "exception", "fail"),
                CodeBranchType.NullCoalescing => HasAny(scenario, "null", "default", "fallback"),
                CodeBranchType.SwitchCase => CaseValue(branch.Condition) is { Length: > 0 } value
                    && (scenario.Contains(value, StringComparison.Ordinal) || testCode.ToLowerInvariant().Contains(value, StringComparison.Ordinal)),
                CodeBranchType.ElseBranch => HasAny(scenario, "false", "else", "other", "not"),
                CodeBranchType.IfBranch or CodeBranchType.Ternary => HasAny(scenario, "valid", "success", "true", "returns", "when"),
                CodeBranchType.CatchBlock => HasAny(scenario, "exception", "error", "catch"),
                _ => false,
            };
            if (matches)
            {
                return true;
            }
        }

        return !string.IsNullOrWhiteSpace(branch.Condition) && testCode.Contains(branch.Condition, StringComparison.OrdinalIgnoreCase);
    }

    private static string CaseValue(string condition) => condition
        .Replace("case", string.Empty, StringComparison.Ordinal)
        .Replace(":", string.Empty, StringComparison.Ordinal)
        .Replace("\"", string.Empty, StringComparison.Ordinal)
        .Trim()
        .ToLowerInvariant();

    private static bool HasAny(string text, params string[] keywords) => keywords.Any(keyword => text.Contains(keyword, StringComparison.Ordinal));
}
