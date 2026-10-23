using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace CodeJanitor.Engine.Queries;

/// <summary>The kind of a decision point, as the <c>branches</c> query names it (camelCase).</summary>
public enum CodeBranchType
{
    IfBranch,
    ElseBranch,
    SwitchCase,
    Ternary,
    NullCoalescing,
    CatchBlock,
    ThrowException,
    GuardClause,
}

/// <summary>A decision point of the code under test; <paramref name="Line" /> is 0-based in the document.</summary>
public sealed record CodeBranch(string Id, CodeBranchType Type, string Description, string Condition, int Line);

/// <summary>
/// The decision points of a member or a file: the Visual Studio extension's <c>RoslynCodeBranchAnalyzer</c>, on the
/// document's syntax tree instead of a re-parsed snippet. Branches are numbered <c>B1</c>, <c>B2</c>… in this order:
/// <c>if</c> statements (a guard clause when the statement is or holds a <c>return</c>/<c>throw</c>) each followed by
/// its final <c>else</c>, switch sections, switch expression arms, conditional expressions, <c>??</c>, <c>catch</c>
/// clauses, then <c>throw</c> statements. Code without any is one happy path branch on <c>happyPathLine</c>.
/// </summary>
internal static class BranchesAnalyzer
{
    public static IReadOnlyList<CodeBranch> Analyze(SyntaxNode scope, int happyPathLine)
    {
        var nodes = scope.DescendantNodes().ToList();
        var branches = new List<CodeBranch>();
        void Add(CodeBranchType type, string description, string condition, SyntaxNode node) =>
            branches.Add(new CodeBranch($"B{branches.Count + 1}", type, description, condition, QuerySyntax.Line(node.SyntaxTree, node.SpanStart)));

        foreach (var @if in nodes.OfType<IfStatementSyntax>())
        {
            var condition = @if.Condition.ToString();
            if (IsGuard(@if.Statement))
            {
                Add(CodeBranchType.GuardClause, $"Guard Clause: If ({condition}) early exit/throw", condition, @if);
            }
            else
            {
                Add(CodeBranchType.IfBranch, $"If branch: ({condition}) is true", condition, @if);
            }

            if (@if.Else is { Statement: not IfStatementSyntax } @else)
            {
                Add(CodeBranchType.ElseBranch, $"Else branch: ({condition}) is false", $"!({condition})", @else);
            }
        }

        foreach (var section in nodes.OfType<SwitchSectionSyntax>())
        {
            var labels = string.Join(", ", section.Labels.Select(label => label.ToString()));
            Add(CodeBranchType.SwitchCase, $"Switch case: {labels}", labels, section);
        }

        foreach (var arm in nodes.OfType<SwitchExpressionArmSyntax>())
        {
            Add(CodeBranchType.SwitchCase, $"Switch expression arm: {arm.Pattern}", arm.Pattern.ToString(), arm);
        }

        foreach (var conditional in nodes.OfType<ConditionalExpressionSyntax>())
        {
            Add(CodeBranchType.Ternary, $"Ternary path: ({conditional.Condition}) ? {conditional.WhenTrue} : {conditional.WhenFalse}", conditional.Condition.ToString(), conditional);
        }

        foreach (var coalesce in nodes.OfType<BinaryExpressionSyntax>().Where(binary => binary.IsKind(SyntaxKind.CoalesceExpression)))
        {
            Add(CodeBranchType.NullCoalescing, $"Null fallback path: {coalesce.Left} ?? {coalesce.Right}", $"{coalesce.Left} is null", coalesce);
        }

        foreach (var @catch in nodes.OfType<CatchClauseSyntax>())
        {
            var exception = @catch.Declaration?.Type.ToString() ?? "Exception";
            Add(CodeBranchType.CatchBlock, $"Exception handled: catch ({exception})", exception, @catch);
        }

        foreach (var @throw in nodes.OfType<ThrowStatementSyntax>())
        {
            var expression = @throw.Expression?.ToString() ?? "throw";
            Add(CodeBranchType.ThrowException, $"Explicit error path: {expression}", expression, @throw);
        }

        if (branches.Count == 0)
        {
            branches.Add(new CodeBranch("B1", CodeBranchType.IfBranch, "Standard primary execution path (Happy path)", "default", happyPathLine));
        }

        return branches;
    }

    private static bool IsGuard(StatementSyntax statement) => statement is BlockSyntax block
        ? block.Statements.Any(inner => inner is ReturnStatementSyntax or ThrowStatementSyntax)
        : statement is ReturnStatementSyntax or ThrowStatementSyntax;
}
