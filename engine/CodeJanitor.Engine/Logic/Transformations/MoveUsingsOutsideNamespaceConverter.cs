using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using System;
using System.Collections.Generic;
using System.Linq;

namespace CodeJanitor.Logic.Transformations;

/// <summary>
/// Moves using directives from inside namespace declarations (both block-scoped and file-scoped)
/// to the top-level compilation unit (outside namespace), preserving file headers and deduplicating directives.
/// </summary>
public sealed class MoveUsingsOutsideNamespaceConverter : ISourceTransformation
{
    /// <inheritdoc />
    public string Name => "Move using directives outside namespace";

    /// <inheritdoc />
    public string Apply(string source) => MoveUsingsOutside(source);

    /// <summary>
    /// Moves all using directives located inside namespaces to the top of the compilation unit.
    /// </summary>
    /// <param name="source">The C# source code.</param>
    /// <returns>Transformed C# source code with usings at the file level.</returns>
    public string MoveUsingsOutside(string source)
    {
        if (string.IsNullOrEmpty(source))
        {
            return source;
        }

        var tree = CSharpSyntaxTree.ParseText(source);
        if (!(tree.GetRoot() is CompilationUnitSyntax root))
        {
            return source;
        }

        var namespacesWithUsings = root.DescendantNodes()
            .OfType<BaseNamespaceDeclarationSyntax>()
            .Where(ns => ns.Usings.Count > 0)
            .ToList();

        if (namespacesWithUsings.Count == 0)
        {
            return source;
        }

        var newline = source.Contains("\r\n") ? "\r\n" : "\n";
        var lineEndingTrivia = newline == "\r\n" ? SyntaxFactory.CarriageReturnLineFeed : SyntaxFactory.LineFeed;

        // Collect all using directives inside namespaces
        var extractedUsings = new List<UsingDirectiveSyntax>();
        foreach (var ns in namespacesWithUsings)
        {
            extractedUsings.AddRange(ns.Usings);
        }

        // Collect existing top-level usings
        var existingTopUsings = root.Usings.ToList();
        var existingKeys = new HashSet<string>(existingTopUsings.Select(GetUsingKey), StringComparer.Ordinal);

        var newUsingsToAdd = new List<UsingDirectiveSyntax>();
        foreach (var u in extractedUsings)
        {
            var key = GetUsingKey(u);
            if (existingKeys.Add(key))
            {
                var cleanUsing = u.WithoutTrivia().WithTrailingTrivia(lineEndingTrivia);
                newUsingsToAdd.Add(cleanUsing);
            }
        }

        // Remove usings from namespaces
        var rewriter = new RemoveNamespaceUsingsRewriter();
        var updatedRoot = (CompilationUnitSyntax)rewriter.Visit(root);

        // Build merged usings list
        var allUsings = new List<UsingDirectiveSyntax>();
        if (existingTopUsings.Count > 0)
        {
            for (int i = 0; i < updatedRoot.Usings.Count; i++)
            {
                allUsings.Add(updatedRoot.Usings[i].WithoutTrailingTrivia().WithTrailingTrivia(lineEndingTrivia));
            }

            foreach (var u in newUsingsToAdd)
            {
                allUsings.Add(u.WithoutTrailingTrivia().WithTrailingTrivia(lineEndingTrivia));
            }
        }
        else
        {
            // When there were no top-level usings, transfer leading trivia from the first token (e.g. file header)
            // to the first using directive.
            var firstToken = updatedRoot.GetFirstToken();
            var leadingTrivia = firstToken.LeadingTrivia;

            if (newUsingsToAdd.Count > 0)
            {
                var firstUsing = newUsingsToAdd[0].WithLeadingTrivia(leadingTrivia).WithoutTrailingTrivia().WithTrailingTrivia(lineEndingTrivia);
                allUsings.Add(firstUsing);
                for (int i = 1; i < newUsingsToAdd.Count; i++)
                {
                    allUsings.Add(newUsingsToAdd[i].WithoutTrailingTrivia().WithTrailingTrivia(lineEndingTrivia));
                }

                updatedRoot = updatedRoot.ReplaceToken(firstToken, firstToken.WithLeadingTrivia(SyntaxFactory.TriviaList()));
            }
        }

        // Ensure there is an empty line between usings and the next code element
        if (allUsings.Count > 0)
        {
            var lastIndex = allUsings.Count - 1;
            var lastUsing = allUsings[lastIndex];
            allUsings[lastIndex] = lastUsing.WithTrailingTrivia(lineEndingTrivia, lineEndingTrivia);
        }

        if (updatedRoot.Members.Count > 0)
        {
            var firstMemberToken = updatedRoot.Members[0].GetFirstToken();
            var leadingTrivia = firstMemberToken.LeadingTrivia;
            var trimmedTrivia = leadingTrivia.SkipWhile(t => t.IsKind(SyntaxKind.EndOfLineTrivia) || t.IsKind(SyntaxKind.WhitespaceTrivia)).ToList();
            if (trimmedTrivia.Count != leadingTrivia.Count)
            {
                updatedRoot = updatedRoot.ReplaceToken(firstMemberToken, firstMemberToken.WithLeadingTrivia(trimmedTrivia));
            }
        }

        updatedRoot = updatedRoot.WithUsings(SyntaxFactory.List(allUsings));

        return updatedRoot.ToFullString();
    }

    /// <summary>
    /// method generates a normalized string key from a `UsingDirectiveSyntax` node by applying default whitespace formatting, converting the node to its full text representation, and trimming the resulting string.
    /// </summary>
    /// <param name="u">The u.</param>
    /// <returns>A string value produced by this method.</returns>
    private static string GetUsingKey(UsingDirectiveSyntax u)
    {
        return u.NormalizeWhitespace().ToFullString().Trim();
    }

    /// <summary>
    /// presents a syntax rewriter that removes using directives from namespace declarations, supporting both block-scoped and file-scoped namespace syntaxes.
    /// </summary>
    private sealed class RemoveNamespaceUsingsRewriter : CSharpSyntaxRewriter
    {
        /// <summary>
        /// Overrides `VisitNamespaceDeclaration` to strip all `using` directives from any namespace declaration that contains them, while leaving namespaces without usings untouched.
        /// </summary>
        /// <param name="node">The node.</param>
        /// <returns>A SyntaxNode value produced by this method.</returns>
        public override SyntaxNode VisitNamespaceDeclaration(NamespaceDeclarationSyntax node)
        {
            if (node.Usings.Count == 0)
            {
                return base.VisitNamespaceDeclaration(node);
            }

            var visited = (NamespaceDeclarationSyntax)base.VisitNamespaceDeclaration(node);

            return visited.WithUsings(SyntaxFactory.List<UsingDirectiveSyntax>());
        }

        /// <summary>
        /// the file-scoped namespace visitor to strip all `using` directives from the declaration, returning the node unchanged when it contains no usings.
        /// </summary>
        /// <param name="node">The node.</param>
        /// <returns>A SyntaxNode value produced by this method.</returns>
        public override SyntaxNode VisitFileScopedNamespaceDeclaration(FileScopedNamespaceDeclarationSyntax node)
        {
            if (node.Usings.Count == 0)
            {
                return base.VisitFileScopedNamespaceDeclaration(node);
            }

            var visited = (FileScopedNamespaceDeclarationSyntax)base.VisitFileScopedNamespaceDeclaration(node);

            return visited.WithUsings(SyntaxFactory.List<UsingDirectiveSyntax>());
        }
    }
}
