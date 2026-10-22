#nullable disable
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace CodeJanitor.Engine.Steps.Transformations;

/// <summary>
/// Removes trailing whitespace (spaces/tabs at the end of a line) from C# source, including
/// whitespace-only lines, without touching whitespace inside string/char literals. Pure and unit-testable.
/// </summary>
/// <remarks>
/// Works line by line on the source text and uses the syntax tree only to decide whether a line's
/// trailing whitespace belongs to a token (a verbatim/raw/interpolated string literal spanning
/// lines), in which case it is kept. Whitespace in trivia (code indentation, comments, documentation
/// comments, preprocessor directives) and on a final line without a line break is removed. Disabled
/// preprocessor text is left untouched because it cannot be proven to be outside a string literal.
/// Line breaks are never changed.
/// </remarks>
internal sealed class RemoveTrailingWhitespaceConverter : ISourceTransformation
{
    /// <inheritdoc />
    public string Name => "Remove trailing whitespace";

    /// <inheritdoc />
    public string Apply(string source) => Convert(source);

    /// <summary>
    /// Removes trailing whitespace from the given C# source.
    /// </summary>
    public string Convert(string source)
    {
        if (string.IsNullOrEmpty(source))
        {
            return source;
        }

        var tree = CSharpSyntaxTree.ParseText(source);
        var root = tree.GetRoot();

        // A line of a string literal of an inactive #if branch that starts with '#' is a directive, not disabled text.
        var literalSpans = root.ContainsDirectives ? RegionDirectiveRemover.FindMultiLineLiteralSpans(source) : null;

        StringBuilder result = null;
        int copied = 0;

        foreach (var line in tree.GetText().Lines)
        {
            int end = line.End;
            int start = end;
            while (start > line.Start && char.IsWhiteSpace(source[start - 1]))
            {
                start--;
            }

            if (start == end || IsProtected(root, start) ||
                (literalSpans is not null && RegionDirectiveRemover.StartsInside(literalSpans, start)))
            {
                continue;
            }

            result ??= new StringBuilder(source.Length);
            result.Append(source, copied, start - copied);
            copied = end;
        }

        if (result is null)
        {
            return source;
        }

        result.Append(source, copied, source.Length - copied);

        return result.ToString();
    }

    /// <summary>
    /// Returns whether the whitespace starting at <paramref name="position" /> must be kept: it is
    /// part of a token (a multi-line string literal) or of disabled preprocessor text.
    /// </summary>
    private static bool IsProtected(SyntaxNode root, int position)
    {
        if (root.FindToken(position).Span.Contains(position))
        {
            return true;
        }

        return root.FindTrivia(position).IsKind(SyntaxKind.DisabledTextTrivia);
    }
}
