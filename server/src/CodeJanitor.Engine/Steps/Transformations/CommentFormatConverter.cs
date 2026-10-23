#nullable disable
using System;
using System.Collections.Generic;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;

namespace CodeJanitor.Engine.Steps.Transformations;

/// <summary>
/// Formats comments in C# source code by applying consistent spacing and alignment rules.
/// Handles both single-line (//) and multi-line (/* */) comments.
/// </summary>
internal sealed class CommentFormatConverter : ISourceTransformation
{
    /// <summary>
    /// Gets the name.
    /// </summary>
    public string Name => "Format comments";

    /// <summary>
    /// Puts exactly one space after the <c>//</c> of every comment that starts its line and aligns the
    /// <c>*</c> continuation lines of block comments that start their line. Only real comment trivia is
    /// changed: string literals, <c>///</c> documentation comments, comments starting with more than two slashes,
    /// runs of comment lines that are commented-out code (a line without a space after <c>//</c> and a line ending
    /// a statement or a block) and the line endings of the file are left as they are.
    /// </summary>
    /// <param name="source">The source.</param>
    /// <returns>The source with its comments formatted.</returns>
    public string Apply(string source)
    {
        if (string.IsNullOrEmpty(source))
        {
            return source;
        }

        var text = SourceText.From(source);
        var changes = new List<TextChange>();
        var root = CSharpSyntaxTree.ParseText(text).GetRoot();
        var singleLineComments = new List<SingleLineComment>();
        AddCommentChanges(text, root, 0, changes, singleLineComments);
        AddSingleLineCommentChanges(singleLineComments, changes);

        if (changes.Count > 0 && root.ContainsDirectives)
        {
            // A disabled-text trivia parsed on its own can start inside a string literal of its branch.
            var literalSpans = RegionDirectiveRemover.FindMultiLineLiteralSpans(source);
            changes.RemoveAll(change => RegionDirectiveRemover.StartsInside(literalSpans, change.Span.Start));
        }

        if (changes.Count == 0)
        {
            return source;
        }

        changes.Sort((left, right) => left.Span.Start.CompareTo(right.Span.Start));

        return text.WithChanges(changes).ToString();
    }

    /// <summary>
    /// Adds the changes for the comments of <paramref name="root" />, whose text starts at
    /// <paramref name="offset" /> in <paramref name="text" />.
    /// </summary>
    private static void AddCommentChanges(SourceText text, SyntaxNode root, int offset, List<TextChange> changes, List<SingleLineComment> singleLineComments)
    {
        foreach (var trivia in root.DescendantTrivia(descendIntoTrivia: true))
        {
            var span = new TextSpan(offset + trivia.SpanStart, trivia.Span.Length);
            if (trivia.IsKind(SyntaxKind.SingleLineCommentTrivia))
            {
                AddSingleLineComment(text, span, singleLineComments);
            }
            else if (trivia.IsKind(SyntaxKind.MultiLineCommentTrivia) || trivia.IsKind(SyntaxKind.MultiLineDocumentationCommentTrivia))
            {
                AddMultiLineCommentChanges(text, span, changes);
            }
            else if (trivia.IsKind(SyntaxKind.DisabledTextTrivia))
            {
                // An inactive #if branch is kept as plain text; parsing it on its own finds its comments
                // while its string literals stay strings.
                AddCommentChanges(text, CSharpSyntaxTree.ParseText(trivia.ToString()).GetRoot(), span.Start, changes, singleLineComments);
            }
        }
    }

    private static void AddSingleLineComment(SourceText text, TextSpan span, List<SingleLineComment> comments)
    {
        var line = text.Lines.GetLineFromPosition(span.Start);
        if (!IsWhitespace(text, line.Start, span.Start))
        {
            // Trailing comments after code are left alone.
            return;
        }

        var comment = text.ToString(span);
        if (comment.StartsWith("///", StringComparison.Ordinal))
        {
            // Commented-out documentation comments and //// separators are not reformatted.
            return;
        }

        comments.Add(new SingleLineComment(line.LineNumber, span, comment));
    }

    /// <summary>
    /// Spaces the comments of each run of consecutive comment lines, except a run that is commented-out code: one with a
    /// line that has no space after <c>//</c> and a line ending a statement or a block.
    /// </summary>
    private static void AddSingleLineCommentChanges(List<SingleLineComment> comments, List<TextChange> changes)
    {
        comments.Sort((left, right) => left.Line.CompareTo(right.Line));
        var runStart = 0;
        for (var index = 1; index <= comments.Count; index++)
        {
            if (index < comments.Count && comments[index].Line == comments[index - 1].Line + 1)
            {
                continue;
            }

            var run = comments.GetRange(runStart, index - runStart);
            runStart = index;
            if (IsCommentedOutCode(run))
            {
                continue;
            }

            foreach (var comment in run)
            {
                var body = comment.Text.Substring(2);
                var formatted = string.IsNullOrWhiteSpace(body) ? "//" : "// " + body.TrimStart();
                if (formatted != comment.Text)
                {
                    changes.Add(new TextChange(comment.Span, formatted));
                }
            }
        }
    }

    private static bool IsCommentedOutCode(List<SingleLineComment> run) =>
        run.Exists(comment => comment.Text.Length > 2 && comment.Text[2] is not (' ' or '\t'))
        && run.Exists(comment => EndsCodeConstruct(comment.Text.AsSpan(2).Trim()));

    private static bool EndsCodeConstruct(ReadOnlySpan<char> body) =>
        body.Length > 0 && (body[^1] is ';' or '{' or '}' || body[0] is '{' or '}');

    private static void AddMultiLineCommentChanges(SourceText text, TextSpan span, List<TextChange> changes)
    {
        var startLine = text.Lines.GetLineFromPosition(span.Start);
        if (!IsWhitespace(text, startLine.Start, span.Start))
        {
            // A block comment opened after code keeps its content as written.
            return;
        }

        var baseIndentation = text.ToString(TextSpan.FromBounds(startLine.Start, span.Start));
        var closingLineNumber = text.Lines.GetLineFromPosition(span.End).LineNumber;

        // The opening and closing lines are kept as they are; only the lines in between are aligned.
        for (var lineNumber = startLine.LineNumber + 1; lineNumber < closingLineNumber; lineNumber++)
        {
            var lineSpan = text.Lines[lineNumber].Span;
            var line = text.ToString(lineSpan);
            var formatted = NormalizeMultiLineCommentLine(line, baseIndentation);
            if (formatted != line)
            {
                changes.Add(new TextChange(lineSpan, formatted));
            }
        }
    }

    private static bool IsWhitespace(SourceText text, int start, int end)
    {
        for (var position = start; position < end; position++)
        {
            if (!char.IsWhiteSpace(text[position]))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Trims leading whitespace from a comment line and, if it begins with an asterisk, realigns it under the base indentation; otherwise returns the line unchanged, with no side effects or thrown exceptions.
    /// </summary>
    /// <param name="line">The line.</param>
    /// <param name="baseIndentation">The base indentation.</param>
    /// <returns>A string value produced by this method.</returns>
    private static string NormalizeMultiLineCommentLine(string line, string baseIndentation)
    {
        var trimmed = line.TrimStart();

        // If line starts with *, align it with base indentation
        if (trimmed.StartsWith("*", StringComparison.Ordinal))
        {
            return baseIndentation + " " + trimmed;
        }

        // Otherwise preserve as-is (content lines)

        return line;
    }

    private readonly record struct SingleLineComment(int Line, TextSpan Span, string Text);
}
