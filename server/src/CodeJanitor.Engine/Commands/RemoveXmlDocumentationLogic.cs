#nullable disable
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace CodeJanitor.Engine.Commands;

/// <summary>
/// Provides logic for detecting and removing XML documentation comments from C# source code.
/// </summary>
internal static class RemoveXmlDocumentationLogic
{
    /// <summary>
    /// Removes all XML documentation comments from the specified C# source text.
    /// Returns the updated source text and whether any XML documentation comments were removed.
    /// </summary>
    /// <param name="sourceText">The source text.</param>
    /// <param name="updatedSourceText">The updated source text.</param>
    /// <returns>True if XML documentation comments were found and removed, otherwise false.</returns>
    public static bool TryRemoveXmlDocumentation(string sourceText, out string updatedSourceText)
    {
        updatedSourceText = sourceText;

        if (string.IsNullOrWhiteSpace(sourceText))
        {
            return false;
        }

        var tree = CSharpSyntaxTree.ParseText(sourceText);
        var root = tree.GetRoot();

        if (!HasXmlDocumentation(root))
        {
            return false;
        }

        var rewriter = new RemoveXmlDocRewriter();
        var newRoot = rewriter.Visit(root);

        updatedSourceText = newRoot.ToFullString();

        return true;
    }

    /// <summary>
    /// Determines whether the syntax root contains any XML documentation trivia.
    /// </summary>
    /// <param name="root">The syntax node root.</param>
    /// <returns>True if any XML documentation trivia is present, otherwise false.</returns>
    public static bool HasXmlDocumentation(SyntaxNode root)
    {
        if (root is null)
        {
            return false;
        }

        return root.DescendantTrivia(descendIntoTrivia: true).Any(IsXmlDocTrivia);
    }

    /// <summary>
    /// Checks whether a syntax trivia represents an XML documentation comment.
    /// </summary>
    /// <param name="trivia">The trivia.</param>
    /// <returns>True if XML doc trivia, otherwise false.</returns>
    public static bool IsXmlDocTrivia(SyntaxTrivia trivia)
    {
        if (trivia.IsKind(SyntaxKind.SingleLineDocumentationCommentTrivia) ||
            trivia.IsKind(SyntaxKind.MultiLineDocumentationCommentTrivia))
        {
            return true;
        }

        if (trivia.HasStructure)
        {
            var structure = trivia.GetStructure();
            if (structure is not null &&
                (structure.IsKind(SyntaxKind.SingleLineDocumentationCommentTrivia) ||
                 structure.IsKind(SyntaxKind.MultiLineDocumentationCommentTrivia)))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Rewrites C# syntax to remove XML documentation comments from the token stream by filtering relevant trivia.
    /// </summary>
    private sealed class RemoveXmlDocRewriter : CSharpSyntaxRewriter
    {
        /// <summary>
        /// its a syntax token and returns a new token with its leading and trailing trivia filtered when changes occur, otherwise delegating to the base visit implementation.
        /// </summary>
        /// <param name="token">The token.</param>
        /// <returns>The syntax token result.</returns>
        public override SyntaxToken VisitToken(SyntaxToken token)
        {
            var leading = token.LeadingTrivia;
            var trailing = token.TrailingTrivia;

            var newLeading = FilterTriviaList(leading);
            var newTrailing = FilterTriviaList(trailing);

            if (newLeading != leading || newTrailing != trailing)
            {
                return token.WithLeadingTrivia(newLeading).WithTrailingTrivia(newTrailing);
            }

            return base.VisitToken(token);
        }

        /// <summary>
        /// Filters XML documentation comment trivia from the specified syntax trivia list, removing preceding indentation whitespace and trailing end-of-line trivia associated with the stripped comments.
        /// </summary>
        /// <param name="triviaList">The trivia list.</param>
        /// <returns>The syntax trivia list result.</returns>
        private static SyntaxTriviaList FilterTriviaList(SyntaxTriviaList triviaList)
        {
            if (triviaList.Count == 0 || !triviaList.Any(IsXmlDocTrivia))
            {
                return triviaList;
            }

            var result = new List<SyntaxTrivia>();
            for (var i = 0; i < triviaList.Count; i++)
            {
                var trivia = triviaList[i];

                if (IsXmlDocTrivia(trivia))
                {
                    // If the trivia directly before this was whitespace on the same line (indentation of the XMLDoc comment),
                    // remove that preceding whitespace from result list.
                    if (result.Count > 0 && result[result.Count - 1].IsKind(SyntaxKind.WhitespaceTrivia))
                    {
                        result.RemoveAt(result.Count - 1);
                    }

                    // For MultiLineDocumentationCommentTrivia or cases where an EndOfLine immediately follows,
                    // skip the trailing EndOfLine if present.
                    if (i + 1 < triviaList.Count && triviaList[i + 1].IsKind(SyntaxKind.EndOfLineTrivia))
                    {
                        i++;
                    }

                    continue;
                }

                result.Add(trivia);
            }

            return SyntaxFactory.TriviaList(result);
        }
    }
}
