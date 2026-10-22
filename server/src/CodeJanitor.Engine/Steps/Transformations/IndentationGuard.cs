#nullable disable
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace CodeJanitor.Engine.Steps.Transformations;

/// <summary>
/// Tells line-based transformations whether the indentation at the start of a line may be changed. A line whose start
/// lies inside a multi-line string literal (verbatim, raw or interpolated), inside text disabled by <c>#if</c>, or
/// inside a multi-line comment must stay byte-identical: inserting or removing whitespace there would change the
/// string's value, text the compiler does not parse, or the comment's text.
/// </summary>
internal static class IndentationGuard
{
    /// <summary>
    /// Determines whether whitespace may be inserted at, or removed from, <paramref name="lineStart" />.
    /// </summary>
    /// <param name="root">The root of the syntax tree parsed from the source the line belongs to.</param>
    /// <param name="lineStart">The position of the first character of the line.</param>
    /// <returns>False when the line starts inside a string literal, disabled text or a multi-line comment.</returns>
    internal static bool CanChangeIndentation(SyntaxNode root, int lineStart)
    {
        var trivia = root.FindTrivia(lineStart);
        switch (trivia.Kind())
        {
            case SyntaxKind.DisabledTextTrivia:
                if (lineStart >= trivia.SpanStart && lineStart < trivia.Span.End)
                {
                    return false;
                }

                break;

            case SyntaxKind.MultiLineCommentTrivia:
            case SyntaxKind.MultiLineDocumentationCommentTrivia:
                if (lineStart > trivia.SpanStart && lineStart < trivia.Span.End)
                {
                    return false;
                }

                break;
        }

        var token = root.FindToken(lineStart);

        // Only string literal tokens span several lines.
        if (lineStart > token.SpanStart && lineStart < token.Span.End)
        {
            return false;
        }

        return !IsInterpolatedStringContent(token, lineStart);
    }

    /// <summary>
    /// Whether <paramref name="lineStart" /> is part of the text of an interpolated string (whose text, interpolation
    /// braces and closing delimiter are separate tokens without trivia) rather than code inside an interpolation hole.
    /// </summary>
    private static bool IsInterpolatedStringContent(SyntaxToken token, int lineStart)
    {
        for (var node = token.Parent; node is not null; node = node.Parent)
        {
            switch (node)
            {
                case InterpolationSyntax interpolation when lineStart > interpolation.OpenBraceToken.SpanStart:
                    return false;

                case InterpolatedStringExpressionSyntax interpolatedString:
                    return lineStart > interpolatedString.StringStartToken.SpanStart
                        && lineStart <= interpolatedString.StringEndToken.SpanStart;
            }
        }

        return false;
    }
}
