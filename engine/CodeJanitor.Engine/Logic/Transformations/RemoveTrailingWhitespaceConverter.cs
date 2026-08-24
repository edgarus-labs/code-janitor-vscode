using System.Collections.Generic;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace CodeJanitor.Logic.Transformations;

/// <summary>
/// Removes trailing whitespace (spaces/tabs at the end of a line) from C# source, including
/// whitespace-only lines, without touching whitespace inside string/char literals (headless-Roslyn
/// block for BL-018). Pure and unit-testable without Visual Studio.
/// </summary>
/// <remarks>
/// Works on syntax trivia: it drops a <see cref="SyntaxKind.WhitespaceTrivia" /> only when it is
/// immediately followed by an end-of-line (or is the final trailing whitespace of the file), so
/// indentation is preserved and trailing spaces that are part of a verbatim/raw string literal
/// token are never removed. Trailing whitespace on a final line that has no line break is only
/// removed reliably when that whitespace lands in the end-of-file token; combine with
/// <see cref="EnsureFinalNewlineConverter" /> for that edge case.
/// </remarks>

public sealed class RemoveTrailingWhitespaceConverter : ISourceTransformation
{
    /// <inheritdoc />
    public string Name => "Remove trailing whitespace";

    /// <inheritdoc />

    public string Apply(string source)
    {
        return Convert(source);
    }

    /// <summary>
    /// Removes trailing whitespace from the given C# source.
    /// </summary>

    public string Convert(string source)
    {
        if (string.IsNullOrEmpty(source))
        {
            return source;
        }

        var root = CSharpSyntaxTree.ParseText(source).GetRoot();
        var newRoot = new TrailingWhitespaceRewriter().Visit(root);

        var result = newRoot.ToFullString();

        return result == source ? source : result;
    }

    /// <summary>
    /// ilingWhitespaceRewriter is a class that removes trailing whitespace from tokens before the end of a line.
    /// </summary>
    private sealed class TrailingWhitespaceRewriter : CSharpSyntaxRewriter
    {
        /// <summary>
        /// Overrides VisitToken to strip trivia before end-of-line from a token&apos;s leading and trailing trivia, additionally removing trailing whitespace from the end-of-file token&apos;s leading trivia, and returns the token with those modified trivia collections.
        /// </summary>
        /// <param name="token">The token.</param>
        /// <returns>A SyntaxToken value produced by this method.</returns>

        public override SyntaxToken VisitToken(SyntaxToken token)
        {
            var leading = StripBeforeEndOfLine(token.LeadingTrivia);
            var trailing = StripBeforeEndOfLine(token.TrailingTrivia);

            // Whitespace at the very end of the file (no trailing newline) can land in the
            // end-of-file token's leading trivia; strip it too.
            if (token.IsKind(SyntaxKind.EndOfFileToken)
                && leading.Count > 0
                && leading[leading.Count - 1].IsKind(SyntaxKind.WhitespaceTrivia))
            {
                leading = leading.RemoveAt(leading.Count - 1);
            }

            return token
                .WithLeadingTrivia(leading)
                .WithTrailingTrivia(trailing);
        }

        /// <summary>
        /// Removes whitespace trivia that directly precedes an end-of-line trivia from the given list, returning a new list without mutating the original, and returns the original list if it is empty.
        /// </summary>
        /// <param name="trivia">The trivia.</param>
        /// <returns>A SyntaxTriviaList value produced by this method.</returns>

        private static SyntaxTriviaList StripBeforeEndOfLine(SyntaxTriviaList trivia)
        {
            if (trivia.Count == 0)
            {
                return trivia;
            }

            var kept = new List<SyntaxTrivia>(trivia.Count);
            for (int i = 0; i < trivia.Count; i++)
            {
                if (trivia[i].IsKind(SyntaxKind.WhitespaceTrivia)
                    && i + 1 < trivia.Count
                    && trivia[i + 1].IsKind(SyntaxKind.EndOfLineTrivia))
                {
                    continue;
                }

                kept.Add(trivia[i]);
            }

            return SyntaxFactory.TriviaList(kept);
        }
    }
}
