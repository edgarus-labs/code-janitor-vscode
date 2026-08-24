using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace CodeJanitor.Logic.Transformations;

/// <summary>
/// Simplifies lambda bodies that contain exactly one statement from a block body to an
/// expression body.
/// </summary>
/// <remarks>
/// For example: <c>() =&gt; { return Compute(); }</c> becomes <c>() =&gt; Compute()</c>, and
/// <c>() =&gt; { DoWork(); }</c> becomes <c>() =&gt; DoWork()</c>.
/// </remarks>

public sealed class SingleStatementLambdaConverter : ISourceTransformation
{
    /// <inheritdoc />
    public string Name => "Single Statement Lambda";

    /// <inheritdoc />

    public string Apply(string source)
    {
        if (string.IsNullOrEmpty(source))
        {
            return source;
        }

        var tree = CSharpSyntaxTree.ParseText(source);
        var root = tree.GetRoot();
        var rewritten = new SingleStatementLambdaRewriter().Visit(root);

        return rewritten.ToFullString();
    }

    /// <summary>
    /// SingleStatementLambdaRewriter is a rewriter that converts single-statement lambdas into expression-bodied equivalents across anonymous methods, simple lambdas, and parenthesized lambdas.
    /// </summary>
    private sealed class SingleStatementLambdaRewriter : CSharpSyntaxRewriter
    {
        /// <summary>
        /// Converts an anonymous method with a single expression body into an equivalent parenthesized lambda expression, preserving async modifier and syntax trivia, while returning the original node if the body cannot be reduced.
        /// </summary>
        /// <param name="node">The node.</param>
        /// <returns>A SyntaxNode value produced by this method.</returns>

        public override SyntaxNode VisitAnonymousMethodExpression(AnonymousMethodExpressionSyntax node)
        {
            node = (AnonymousMethodExpressionSyntax)base.VisitAnonymousMethodExpression(node);

            var expression = TryExtractSingleExpression(node.Block);
            if (expression is null)
            {
                return node;
            }

            var parameterList = node.ParameterList ??
                                SyntaxFactory.ParameterList(
                                    SyntaxFactory.SeparatedList<ParameterSyntax>());

            var lambda = SyntaxFactory.ParenthesizedLambdaExpression(
                parameterList,
                expression.WithTriviaFrom(node.Block));

            var leadingArrowTrivia = parameterList.Parameters.Count == 0
                ? SyntaxFactory.TriviaList(SyntaxFactory.Space)
                : SyntaxTriviaList.Empty;

            lambda = lambda.WithArrowToken(
                SyntaxFactory.Token(
                    leadingArrowTrivia,
                    SyntaxKind.EqualsGreaterThanToken,
                    SyntaxFactory.TriviaList(SyntaxFactory.Space)));

            if (node.AsyncKeyword.IsKind(SyntaxKind.AsyncKeyword))
            {
                lambda = lambda.WithAsyncKeyword(node.AsyncKeyword);
            }

            return lambda.WithTriviaFrom(node);
        }

        /// <summary>
        /// Overrides the simple lambda expression visitor to first run the base visit and then return the result of attempting to simplify the lambda expression, potentially rewriting the node.
        /// </summary>
        /// <param name="node">The node.</param>
        /// <returns>A SyntaxNode value produced by this method.</returns>

        public override SyntaxNode VisitSimpleLambdaExpression(SimpleLambdaExpressionSyntax node)
        {
            node = (SimpleLambdaExpressionSyntax)base.VisitSimpleLambdaExpression(node);

            return TrySimplifySimpleLambda(node);
        }

        /// <summary>
        /// Visits a parenthesized lambda expression, then attempts to simplify it and returns the resulting (potentially replaced) syntax node.
        /// </summary>
        /// <param name="node">The node.</param>
        /// <returns>A SyntaxNode value produced by this method.</returns>

        public override SyntaxNode VisitParenthesizedLambdaExpression(ParenthesizedLambdaExpressionSyntax node)
        {
            node = (ParenthesizedLambdaExpressionSyntax)base.VisitParenthesizedLambdaExpression(node);

            return TrySimplifyParenthesizedLambda(node);
        }

        /// <summary>
        /// Attempts to simplify a simple lambda by replacing its block body with a single extracted expression when possible, preserving trivia, otherwise returns the original node unchanged.
        /// </summary>
        /// <param name="node">The node.</param>
        /// <returns>A SyntaxNode value produced by this method.</returns>

        private static SyntaxNode TrySimplifySimpleLambda(SimpleLambdaExpressionSyntax node)
        {
            var expression = TryExtractSingleExpression(node.Body as BlockSyntax);

            return expression is null ? node : node.WithBody(expression.WithTriviaFrom(node.Body));
        }

        /// <summary>
        /// Attempts to replace a parenthesized lambda&apos;s block body with a single extracted expression when possible, preserving trivia, otherwise returns the original node with no side effects.
        /// </summary>
        /// <param name="node">The node.</param>
        /// <returns>A SyntaxNode value produced by this method.</returns>

        private static SyntaxNode TrySimplifyParenthesizedLambda(ParenthesizedLambdaExpressionSyntax node)
        {
            var expression = TryExtractSingleExpression(node.Body as BlockSyntax);

            return expression is null ? node : node.WithBody(expression.WithTriviaFrom(node.Body));
        }

        /// <summary>
        /// Returns the single expression from a block containing exactly one expression or return statement, or null if the block is null, has multiple statements, or the statement is unsupported, with no side effects.
        /// </summary>
        /// <param name="block">The block.</param>
        /// <returns>A ExpressionSyntax value produced by this method.</returns>

        private static ExpressionSyntax TryExtractSingleExpression(BlockSyntax block)
        {
            if (block is null || block.Statements.Count != 1)
            {
                return null;
            }

            var statement = block.Statements[0];
            switch (statement)
            {
                case ExpressionStatementSyntax expressionStatement:
                    return expressionStatement.Expression;

                case ReturnStatementSyntax returnStatement when returnStatement.Expression is not null:
                    return returnStatement.Expression;

                default:
                    return null;
            }
        }
    }
}
