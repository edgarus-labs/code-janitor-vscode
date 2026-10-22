#nullable disable
using System.Collections.Generic;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace CodeJanitor.Engine.Steps.Transformations;

/// <summary>
/// Inserts a blank line before a <c>return</c> or <c>throw</c> statement when it is preceded
/// by at least one other statement within the same braced block (i.e. the block contains more
/// instructions than just this return/throw), visually separating the exit/failure path from
/// the preceding logic. Idempotent - does nothing when a blank line already precedes it, or
/// when the return/throw is the first (or only) statement in its block. Comments directly above the
/// return/throw stay attached to it (the blank line goes above them), a return/throw that does not
/// start its own line is left alone, and so is one directly below a preprocessor directive.
/// Only statements of a braced block count: top-level statements, switch sections and embedded
/// statements are not blocks and are never padded.
/// </summary>
/// <remarks>
/// This is a pure text transformation, which keeps it unit-testable in isolation.
/// </remarks>
internal sealed class ReturnThrowBlankLinePaddingConverter : ISourceTransformation
{
    /// <inheritdoc />
    public string Name => "Blank Line Before Return/Throw";

    /// <inheritdoc />
    public string Apply(string source)
    {
        if (string.IsNullOrEmpty(source))
        {
            return source;
        }

        var tree = CSharpSyntaxTree.ParseText(source);
        var text = tree.GetText();
        var root = tree.GetRoot();

        var candidateLineIndexes = new SortedSet<int>();

        foreach (var statement in root.DescendantNodes().OfType<StatementSyntax>())
        {
            if (!(statement is ReturnStatementSyntax) && !(statement is ThrowStatementSyntax))
            {
                continue;
            }

            if (!(statement.Parent is BlockSyntax block))
            {
                continue;
            }

            var index = block.Statements.IndexOf(statement);
            if (index <= 0)
            {
                // Either the only statement in the block, or the first one - there is
                // nothing preceding it to separate it from.
                continue;
            }

            var startPosition = GetStartIncludingAttachedComments(statement, text);
            var startLine = text.Lines.GetLineFromPosition(startPosition);
            var previousStatementEndLine = text.Lines.GetLineFromPosition(block.Statements[index - 1].Span.End).LineNumber;
            if (previousStatementEndLine >= startLine.LineNumber ||
                !string.IsNullOrWhiteSpace(text.ToString(TextSpan.FromBounds(startLine.Start, startPosition))))
            {
                // Shares its line with the previous statement (for example a single-line method body)
                // or with the end of a comment: there is no line of its own to separate.
                continue;
            }

            candidateLineIndexes.Add(startLine.LineNumber);
        }

        var directiveLines = new HashSet<int>(
            root.DescendantTrivia().Where(trivia => trivia.IsDirective)
                .Select(trivia => text.Lines.GetLineFromPosition(trivia.SpanStart).LineNumber));

        var changes = new List<TextChange>();
        foreach (var lineIndex in candidateLineIndexes)
        {
            var previousLine = text.Lines[lineIndex - 1];
            if (string.IsNullOrWhiteSpace(text.ToString(previousLine.Span)) || directiveLines.Contains(lineIndex - 1))
            {
                // Already has a blank line before it, or directly follows a preprocessor directive
                // (#if/#else/#region/#endif), which a blank line would cut off from the code it introduces.
                continue;
            }

            // The blank line reuses the line break of the line above, so the file's line endings are kept.
            var lineBreak = text.ToString(TextSpan.FromBounds(previousLine.End, previousLine.EndIncludingLineBreak));
            changes.Add(new TextChange(new TextSpan(text.Lines[lineIndex].Start, 0), lineBreak));
        }

        return changes.Count == 0 ? source : text.WithChanges(changes).ToString();
    }

    /// <summary>
    /// The start of the statement, moved up over the comments directly above it (no blank line in between).
    /// </summary>
    private static int GetStartIncludingAttachedComments(StatementSyntax statement, SourceText text)
    {
        var start = statement.SpanStart;
        var leadingTrivia = statement.GetLeadingTrivia();

        for (var i = leadingTrivia.Count - 1; i >= 0; i--)
        {
            var trivia = leadingTrivia[i];
            if (trivia.IsKind(SyntaxKind.WhitespaceTrivia) || trivia.IsKind(SyntaxKind.EndOfLineTrivia))
            {
                continue;
            }

            if (!trivia.IsKind(SyntaxKind.SingleLineCommentTrivia) &&
                !trivia.IsKind(SyntaxKind.MultiLineCommentTrivia) &&
                !trivia.IsKind(SyntaxKind.SingleLineDocumentationCommentTrivia) &&
                !trivia.IsKind(SyntaxKind.MultiLineDocumentationCommentTrivia))
            {
                break;
            }

            // The full span of a documentation comment starts at its /// or /** and a single-line one includes its line
            // break, so the comment's last line is the one of its last character.
            var commentEndLine = text.Lines.GetLineFromPosition(trivia.FullSpan.End - 1).LineNumber;
            if (commentEndLine < text.Lines.GetLineFromPosition(start).LineNumber - 1)
            {
                break;
            }

            start = trivia.FullSpan.Start;
        }

        return start;
    }
}
