using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using CodeJanitor.Properties;

namespace CodeJanitor.Logic.Transformations;

/// <summary>
/// Spreads single-line method declarations onto multiple lines by placing the opening brace
/// on a new line, method body content on separate lines, and closing brace on its own line.
/// </summary>

public sealed class UpdateSingleLineMethodsConverter : ISourceTransformation
{
    /// <summary>
    /// Gets the name.
    /// </summary>
    public string Name => "Update single-line methods";

    /// <summary>
    /// Returns the original source unchanged if it is null/empty or the setting is disabled, otherwise parses the source as a C# syntax tree, applies SingleLineMethodRewriter to rewrite single-line methods, and returns the resulting full string.
    /// </summary>
    /// <param name="source">The source.</param>
    /// <returns>A string value produced by this method.</returns>

    public string Apply(string source)
    {
        if (string.IsNullOrEmpty(source) || !Settings.Default.Cleaning_UpdateSingleLineMethods)
        {
            return source;
        }

        var tree = CSharpSyntaxTree.ParseText(source);
        var root = tree.GetRoot();
        var rewriter = new SingleLineMethodRewriter();
        var newRoot = rewriter.Visit(root);

        return newRoot.ToFullString();
    }

    /// <summary>
    /// A rewriter that processes single-line method declarations and reformats them across multiple lines.
    /// </summary>
    private sealed class SingleLineMethodRewriter : CSharpSyntaxRewriter
    {
        /// <summary>
        /// Visits a method declaration and, if it has a non-abstract single-line body, rewrites it across multiple lines, otherwise returns the visited node unchanged.
        /// </summary>
        /// <param name="node">The node.</param>
        /// <returns>A SyntaxNode value produced by this method.</returns>

        public override SyntaxNode VisitMethodDeclaration(MethodDeclarationSyntax node)
        {
            // First visit children
            var visited = (MethodDeclarationSyntax)base.VisitMethodDeclaration(node);

            // Don't process abstract methods or methods in interfaces
            if (visited.Body is null || visited.Modifiers.Any(SyntaxKind.AbstractKeyword))
            {
                return visited;
            }

            // Check if it's a single-line method (return statement or throw)
            if (!IsSingleLineMethodBody(visited.Body))
            {
                return visited;
            }

            // Spread it onto multiple lines

            return SpreadMethodOntoMultipleLines(visited);
        }

        /// <summary>
        /// Returns true if the given block body is non-null, has at least one statement, and its full text spans at most two lines (a heuristic for a single-line method body), otherwise false, with no side effects or thrown exceptions.
        /// </summary>
        /// <param name="body">The body.</param>
        /// <returns>A bool value produced by this method.</returns>

        private bool IsSingleLineMethodBody(BlockSyntax body)
        {
            if (body is null || body.Statements.Count == 0)
                return false;

            // Check if all statements fit on one line (simple heuristic)
            // A single-line method body would have minimal whitespace/newlines
            var bodyText = body.ToFullString();
            var lineCount = bodyText.Split('\n').Length;

            // If body spans only 1-2 lines, consider it single-line
            // (1 for opening brace, 2 includes closing brace)

            return lineCount <= 2;
        }

        /// <summary>
        /// This method returns a new MethodDeclarationSyntax with its body reformatted so each statement appears on a new indented line (using hardcoded \r\n and four spaces) and rebuilds the block via SyntaxFactory.ParseStatement, falling back to returning the original method if there is no body or parsing fails.
        /// </summary>
        /// <param name="method">The method.</param>
        /// <returns>A MethodDeclarationSyntax value produced by this method.</returns>

        private MethodDeclarationSyntax SpreadMethodOntoMultipleLines(MethodDeclarationSyntax method)
        {
            if (method.Body is null)
                return method;

            var newline = "\r\n";
            var indent = "    ";

            // Reconstruct the method body with proper formatting
            var statements = method.Body.Statements;

            // Build formatted body text
            var bodyLines = new System.Collections.Generic.List<string> { "{" };

            foreach (var statement in statements)
            {
                bodyLines.Add(indent + statement.ToString().Trim());
            }

            bodyLines.Add("}");

            var formattedBody = string.Join(newline, bodyLines);

            // Parse the new body
            var newBodySyntax = SyntaxFactory.ParseStatement(formattedBody) as BlockSyntax;
            if (newBodySyntax is null)
            {
                return method;
            }

            return method.WithBody(newBodySyntax);
        }
    }
}
