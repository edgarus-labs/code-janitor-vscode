using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace CodeJanitor.Logic.Transformations;

/// <summary>
/// A source transformation that converts string literals matching parameter names in argument/exception constructors to nameof(...) expressions.
/// </summary>
public sealed class NameOfOperatorConverter : ISourceTransformation
{
    private static readonly HashSet<string> TargetExceptionTypes = new HashSet<string>(StringComparer.Ordinal)
    {
        "ArgumentNullException",
        "ArgumentException",
        "ArgumentOutOfRangeException",
        "InvalidEnumArgumentException"
    };

    /// <inheritdoc />
    public string Name => "Convert String Literals to nameof(...)";

    /// <inheritdoc />
    public string Apply(string source)
    {
        if (string.IsNullOrWhiteSpace(source))
        {
            return source;
        }

        var tree = CSharpSyntaxTree.ParseText(source);
        var root = tree.GetRoot();
        var rewriter = new NameOfRewriter();
        var newRoot = rewriter.Visit(root);

        return newRoot.ToFullString();
    }

    /// <summary>
    /// NameOfRewriter is a syntax rewriter that resolves `nameof` expressions by examining object creation expressions and gathering the set of available identifiers in scope.
    /// </summary>
    private sealed class NameOfRewriter : CSharpSyntaxRewriter
    {
        /// <summary>
        /// Overrides the visitor for object creation expressions to replace string literal arguments that match valid identifiers with `nameof()` expressions when the created type is in a configured set of exception types, returning the modified node if any substitutions were made.
        /// </summary>

        /// <param name="node">The node.</param>

        /// <returns>A SyntaxNode value produced by this method.</returns>
        public override SyntaxNode VisitObjectCreationExpression(ObjectCreationExpressionSyntax node)
        {
            var visited = (ObjectCreationExpressionSyntax)base.VisitObjectCreationExpression(node);

            var typeName = visited.Type.ToString();
            // Handle System.ArgumentNullException or ArgumentNullException
            var simpleTypeName = typeName.Contains('.') ? typeName.Substring(typeName.LastIndexOf('.') + 1) : typeName;

            if (!TargetExceptionTypes.Contains(simpleTypeName))
            {
                return visited;
            }

            if (visited.ArgumentList is null || visited.ArgumentList.Arguments.Count == 0)
            {
                return visited;
            }

            var availableIdentifiers = GetAvailableIdentifiers(node);
            if (availableIdentifiers.Count == 0)
            {
                return visited;
            }

            var changed = false;
            var currentArgumentList = visited.ArgumentList;

            foreach (var arg in visited.ArgumentList.Arguments)
            {
                if (arg.Expression is LiteralExpressionSyntax stringLiteral &&
                    stringLiteral.IsKind(SyntaxKind.StringLiteralExpression))
                {
                    var literalValue = stringLiteral.Token.ValueText;
                    if (SyntaxFacts.IsValidIdentifier(literalValue) && availableIdentifiers.Contains(literalValue))
                    {
                        var nameOfExpr = SyntaxFactory.InvocationExpression(
                            SyntaxFactory.IdentifierName("nameof"),
                            SyntaxFactory.ArgumentList(
                                SyntaxFactory.SingletonSeparatedList(
                                    SyntaxFactory.Argument(SyntaxFactory.IdentifierName(literalValue)))))
                            .WithLeadingTrivia(stringLiteral.GetLeadingTrivia())
                            .WithTrailingTrivia(stringLiteral.GetTrailingTrivia());

                        var updatedArg = arg.WithExpression(nameOfExpr);
                        currentArgumentList = currentArgumentList.WithArguments(currentArgumentList.Arguments.Replace(arg, updatedArg));
                        changed = true;
                    }
                }
            }

            if (changed)
            {
                return visited.WithArgumentList(currentArgumentList);
            }

            return visited;
        }

        /// <summary>

        /// Walks up the syntax tree from the given node and collects parameter identifier names from each enclosing method, constructor, local function, or lambda into a case-sensitive HashSet, stopping when the root is reached.
        /// </summary>
        /// <param name="node">The node.</param>
        /// <returns>A HashSet&lt;string&gt; value produced by this method.</returns>
        private static HashSet<string> GetAvailableIdentifiers(SyntaxNode node)
        {
            var identifiers = new HashSet<string>(StringComparer.Ordinal);
            var current = node.Parent;

            while (current is not null)
            {
                if (current is MethodDeclarationSyntax method)
                {
                    foreach (var p in method.ParameterList.Parameters)
                    {
                        identifiers.Add(p.Identifier.Text);
                    }
                }
                else if (current is ConstructorDeclarationSyntax ctor)
                {
                    foreach (var p in ctor.ParameterList.Parameters)
                    {
                        identifiers.Add(p.Identifier.Text);
                    }
                }
                else if (current is LocalFunctionStatementSyntax localFunc)
                {
                    foreach (var p in localFunc.ParameterList.Parameters)
                    {
                        identifiers.Add(p.Identifier.Text);
                    }
                }
                else if (current is AnonymousFunctionExpressionSyntax lambda)
                {
                    if (lambda is SimpleLambdaExpressionSyntax simpleLambda)
                    {
                        identifiers.Add(simpleLambda.Parameter.Identifier.Text);
                    }
                    else if (lambda is ParenthesizedLambdaExpressionSyntax parenLambda)
                    {
                        foreach (var p in parenLambda.ParameterList.Parameters)
                        {
                            identifiers.Add(p.Identifier.Text);
                        }
                    }
                }

                current = current.Parent;
            }

            return identifiers;
        }
    }
}
