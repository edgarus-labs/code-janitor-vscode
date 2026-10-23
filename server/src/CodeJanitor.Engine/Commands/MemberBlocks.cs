using System.Text;
using System.Text.Json.Nodes;
using CodeJanitor.Engine.Queries;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace CodeJanitor.Engine.Commands;

/// <summary>
/// The members Spade moves and deletes, found as the <c>structure</c> query lists them (the 0-based line of their first
/// attribute or keyword and their name), and the whole lines they own: the comments directly above them (no blank line
/// or preprocessor directive in between, so <c>#if</c>/<c>#region</c> stay in place), their attributes and their
/// declaration.
/// </summary>
internal static class MemberBlocks
{
    /// <summary>
    /// The member (a member declaration or an enum member) whose declaration starts on <paramref name="line" /> and is
    /// named <paramref name="name" /> (any of the variables of a field), the outermost one without a name.
    /// </summary>
    public static SyntaxNode Find(SyntaxNode root, SourceText text, int line, string? name) =>
        TryFind(root, text, line, name) ?? throw new InvalidOperationException($"There is no member '{name}' on line {line + 1}.");

    /// <summary>As <see cref="Find" />, null when there is no such member.</summary>
    public static SyntaxNode? TryFind(SyntaxNode root, SourceText text, int line, string? name) => root.DescendantNodes()
        .Where(node => node is MemberDeclarationSyntax and not GlobalStatementSyntax)
        .FirstOrDefault(node => text.Lines.GetLineFromPosition(node.SpanStart).LineNumber == line && (name is null || Names(node).Contains(name, StringComparer.Ordinal)));

    public static IEnumerable<string> Names(SyntaxNode node) => node is BaseFieldDeclarationSyntax field
        ? field.Declaration.Variables.Select(variable => variable.Identifier.ValueText)
        : [QuerySyntax.NameOf(node)];

    /// <summary>The display name of a member for messages: the name asked for, or its own.</summary>
    public static string NameOf(SyntaxNode node, string? name) => name ?? QuerySyntax.NameOf(node);

    public static string? Name(JsonObject? arguments, string key) => arguments?[key] is JsonValue value && value.TryGetValue(out string? name) ? name : null;

    /// <summary>
    /// The lines the member owns (see the class), or null when it shares its first or last line with other code; an
    /// enum member's separating comma may follow it.
    /// </summary>
    public static (int First, int Last)? OwnedLines(SyntaxNode node, SourceText text)
    {
        var first = text.Lines.GetLineFromPosition(node.SpanStart);
        var last = text.Lines.GetLineFromPosition(node.Span.End);
        var after = text.ToString(TextSpan.FromBounds(node.Span.End, last.End)).Trim();
        if (node is EnumMemberDeclarationSyntax && after.StartsWith(','))
        {
            after = after[1..].Trim();
        }

        if (!string.IsNullOrWhiteSpace(text.ToString(TextSpan.FromBounds(first.Start, node.SpanStart))) || (after.Length > 0 && !after.StartsWith("//", StringComparison.Ordinal)))
        {
            return null;
        }

        var firstLine = first.LineNumber;
        while (firstLine > 0 && text.Lines[firstLine - 1].Start >= node.FullSpan.Start && CommentStartLine(node, text, firstLine - 1) is { } commentLine)
        {
            firstLine = commentLine;
        }

        return (firstLine, last.LineNumber);
    }

    /// <summary>
    /// The line on which the comment that is the first non-blank text of <paramref name="line" /> starts (a block
    /// comment may start lines above), or null when that text is not a comment.
    /// </summary>
    private static int? CommentStartLine(SyntaxNode node, SourceText text, int line)
    {
        var span = text.Lines[line];
        var position = span.Start;
        while (position < span.End && char.IsWhiteSpace(text[position]))
        {
            position++;
        }

        if (position == span.End)
        {
            return null;
        }

        var trivia = node.FindTrivia(position);

        return trivia.Kind() is SyntaxKind.SingleLineCommentTrivia or SyntaxKind.MultiLineCommentTrivia or SyntaxKind.SingleLineDocumentationCommentTrivia or SyntaxKind.MultiLineDocumentationCommentTrivia
            ? text.Lines.GetLineFromPosition(trivia.SpanStart).LineNumber
            : null;
    }

    /// <summary>The <c>#region</c> directive on <paramref name="line" /> and the line of its <c>#endregion</c>, or null.</summary>
    public static (int First, int Last)? Region(SyntaxNode root, SourceText text, int line)
    {
        var open = new Stack<int>();
        foreach (var directive in root.DescendantTrivia(descendIntoTrivia: true).Where(trivia => trivia.IsKind(SyntaxKind.RegionDirectiveTrivia) || trivia.IsKind(SyntaxKind.EndRegionDirectiveTrivia)))
        {
            var directiveLine = text.Lines.GetLineFromPosition(directive.SpanStart).LineNumber;
            if (directive.IsKind(SyntaxKind.RegionDirectiveTrivia))
            {
                open.Push(directiveLine);
            }
            else if (open.Count > 0 && open.Pop() == line)
            {
                return (line, directiveLine);
            }
        }

        return open.Contains(line) ? throw new InvalidOperationException($"The region on line {line + 1} has no #endregion.") : null;
    }
}

/// <summary>
/// The lines of a text with their line breaks, to take whole lines out and put them back elsewhere, the blank lines
/// around them following: a block separated from its neighbours by blank lines stays separated, without doubling them.
/// </summary>
internal sealed class LineBlocks
{
    private readonly List<string> _lines;
    private readonly string _eol;
    private readonly bool _endsWithBreak;

    public LineBlocks(SourceText text)
    {
        var source = text.ToString();
        _eol = source.Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n";
        _endsWithBreak = source.Length == 0 || source.EndsWith('\n') || source.EndsWith('\r');
        _lines = [.. text.Lines.Select(line => text.ToString(line.SpanIncludingLineBreak))];
        if (_lines.Count > 0 && _lines[^1].Length == 0)
        {
            _lines.RemoveAt(_lines.Count - 1);
        }

        if (!_endsWithBreak && _lines.Count > 0)
        {
            _lines[^1] += _eol;
        }
    }

    /// <summary>The text without the lines <paramref name="first" />…<paramref name="last" /> (and a blank line they leave over).</summary>
    public string Remove(int first, int last) => Build(Removed(first, last, out _), insertAt: -1, before: true, block: [], separated: false);

    /// <summary>
    /// The text with the lines <paramref name="first" />…<paramref name="last" /> moved before the line
    /// <paramref name="anchor" /> or after it, the anchor being outside them.
    /// </summary>
    public string Move(int first, int last, int anchor, bool before)
    {
        var removed = Removed(first, last, out var separated);

        return Build(removed, anchor, before, _lines.GetRange(first, last - first + 1), separated);
    }

    private HashSet<int> Removed(int first, int last, out bool separated)
    {
        var removed = Enumerable.Range(first, last - first + 1).ToHashSet();
        var (previous, next) = (first - 1, last + 1);
        separated = IsBlank(previous) || IsBlank(next);
        if (IsBlank(previous) && IsBlank(next))
        {
            removed.Add(next);
        }
        else if (IsBlank(previous) && Closes(next))
        {
            removed.Add(previous);
        }
        else if (IsBlank(next) && Opens(previous))
        {
            removed.Add(next);
        }

        return removed;
    }

    private string Build(HashSet<int> removed, int insertAt, bool before, IReadOnlyList<string> block, bool separated)
    {
        var builder = new StringBuilder();
        void Insert()
        {
            if (!before && separated)
            {
                builder.Append(_eol);
            }

            foreach (var line in block)
            {
                builder.Append(line);
            }

            if (before && separated)
            {
                builder.Append(_eol);
            }
        }

        for (var index = 0; index < _lines.Count; index++)
        {
            if (before && index == insertAt)
            {
                Insert();
            }

            if (!removed.Contains(index))
            {
                builder.Append(_lines[index]);
            }

            if (!before && index == insertAt)
            {
                Insert();
            }
        }

        var result = builder.ToString();

        return _endsWithBreak || !result.EndsWith(_eol, StringComparison.Ordinal) ? result : result[..^_eol.Length];
    }

    private bool IsBlank(int index) => index >= 0 && index < _lines.Count && string.IsNullOrWhiteSpace(_lines[index]);

    private bool Opens(int index) => index < 0 || _lines[index].TrimEnd().EndsWith('{') || IsDirective(index, "#region");

    private bool Closes(int index) => index >= _lines.Count || _lines[index].TrimStart().StartsWith('}') || IsDirective(index, "#endregion");

    private bool IsDirective(int index, string directive) =>
        index >= 0 && index < _lines.Count && _lines[index].TrimStart().StartsWith(directive, StringComparison.Ordinal);
}
