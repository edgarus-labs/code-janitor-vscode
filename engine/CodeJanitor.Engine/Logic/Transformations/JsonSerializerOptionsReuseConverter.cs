using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace CodeJanitor.Logic.Transformations;

/// <summary>
/// Applies a conservative CA1869-style optimization by replacing direct allocations of
/// <c>JsonSerializerOptions</c> in <c>JsonSerializer.*</c> call arguments with <c>null</c>.
/// </summary>
/// <remarks>
/// This avoids per-call options allocations while preserving the selected overload. The
/// transformation is intentionally narrow and skips configured options instances.
/// </remarks>

public sealed class JsonSerializerOptionsReuseConverter : ISourceTransformation
{
    /// <inheritdoc />
    public string Name => "CA1869 JsonSerializerOptions Reuse";

    /// <inheritdoc />

    public string Apply(string source)
    {
        if (string.IsNullOrEmpty(source))
        {
            return source;
        }

        var tree = CSharpSyntaxTree.ParseText(source);
        var root = tree.GetRoot();
        var rewritten = new JsonSerializerOptionsReuseRewriter().Visit(root);

        return rewritten.ToFullString();
    }

    /// <summary>
    /// A syntax rewriter that analyzes and transforms C# code to detect JsonSerializer method invocations and direct JsonSerializerOptions instantiations in order to enable reuse of serializer options.
    /// </summary>
    private sealed class JsonSerializerOptionsReuseRewriter : CSharpSyntaxRewriter
    {
        /// <summary>
        /// This method overrides invocation visiting to replace plain JsonSerializerOptions creation arguments with null literals (preserving trivia) in JsonSerializer calls, returning the original node if unchanged or no such arguments exist.
        /// </summary>
        /// <param name="node">The node.</param>
        /// <returns>A SyntaxNode value produced by this method.</returns>

        public override SyntaxNode VisitInvocationExpression(InvocationExpressionSyntax node)
        {
            node = (InvocationExpressionSyntax)base.VisitInvocationExpression(node);

            if (node.ArgumentList is null || node.ArgumentList.Arguments.Count == 0 || !IsJsonSerializerCall(node))
            {
                return node;
            }

            var updatedArgumentList = node.ArgumentList;
            var changed = false;

            for (var i = 0; i < updatedArgumentList.Arguments.Count; i++)
            {
                var argument = updatedArgumentList.Arguments[i];
                if (!IsPlainJsonSerializerOptionsCreation(argument.Expression))
                {
                    continue;
                }

                var replacement = argument.WithExpression(
                    SyntaxFactory.LiteralExpression(SyntaxKind.NullLiteralExpression)
                                 .WithTriviaFrom(argument.Expression));

                updatedArgumentList = updatedArgumentList.WithArguments(
                    updatedArgumentList.Arguments.Replace(argument, replacement));
                changed = true;
            }

            return changed ? node.WithArgumentList(updatedArgumentList) : node;
        }

        /// <summary>
        /// Determines whether the given invocation expression is a call to JsonSerializer by checking if its member access receiver is exactly one of the expected fully qualified names, returning false otherwise with no side effects.
        /// </summary>
        /// <param name="invocation">The invocation.</param>
        /// <returns>A bool value produced by this method.</returns>

        private static bool IsJsonSerializerCall(InvocationExpressionSyntax invocation)
        {
            if (!(invocation.Expression is MemberAccessExpressionSyntax memberAccess))
            {
                return false;
            }

            var receiver = memberAccess.Expression.ToString();

            return receiver == "JsonSerializer"
                   || receiver == "System.Text.Json.JsonSerializer"
                   || receiver == "global::System.Text.Json.JsonSerializer";
        }

        /// <summary>
        /// Determines whether the given expression is a parameterless object creation of JsonSerializerOptions (with no initializer or arguments), returning true only for the specified type name variants and false otherwise.
        /// </summary>
        /// <param name="expression">The expression.</param>
        /// <returns>A bool value produced by this method.</returns>

        private static bool IsPlainJsonSerializerOptionsCreation(ExpressionSyntax expression)
        {
            if (!(expression is ObjectCreationExpressionSyntax creation))
            {
                return false;
            }

            if (creation.Initializer is not null)
            {
                return false;
            }

            if (creation.ArgumentList is not null && creation.ArgumentList.Arguments.Count > 0)
            {
                return false;
            }

            var createdType = creation.Type.ToString();

            return createdType == "JsonSerializerOptions"
                   || createdType == "System.Text.Json.JsonSerializerOptions"
                   || createdType == "global::System.Text.Json.JsonSerializerOptions";
        }
    }
}
