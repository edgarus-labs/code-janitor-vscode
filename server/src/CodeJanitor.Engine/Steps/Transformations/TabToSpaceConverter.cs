#nullable disable
using System;
using System.Linq;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace CodeJanitor.Engine.Steps.Transformations;

/// <summary>
/// Replaces tab characters in C# whitespace/indentation with spaces, without touching tabs that
/// are part of string/char literals, verbatim strings or comment text. Pure and unit-testable.
/// </summary>
/// <remarks>
/// Only <see cref="SyntaxKind.WhitespaceTrivia" /> and the indentation in front of the
/// <c>///</c> / <c>*</c> of documentation comment continuation lines
/// (<see cref="SyntaxKind.DocumentationCommentExteriorTrivia" />) are rewritten, so tabs inside
/// string literals and comment text are preserved exactly. Each tab is expanded to the next multiple of
/// <see cref="TabSize" /> columns, so the text after it keeps the column an editor shows it in.
/// </remarks>
internal sealed class TabToSpaceConverter : ISourceTransformation
{
    /// <summary>
    /// The default tab size.
    /// </summary>
    private const int DefaultTabSize = 4;

    /// <summary>
    /// Initializes a converter with tab stops 4 columns apart.
    /// </summary>
    public TabToSpaceConverter()
        : this(DefaultTabSize)
    {
    }

    /// <summary>
    /// Initializes a converter whose tab stops are <paramref name="tabSize" /> columns apart.
    /// </summary>
    public TabToSpaceConverter(int tabSize)
    {
        if (tabSize < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(tabSize), "Tab size must be at least 1.");
        }

        TabSize = tabSize;
    }

    /// <summary>
    /// Gets the distance between two tab stops, in columns.
    /// </summary>
    public int TabSize { get; }

    /// <inheritdoc />
    public string Name => "Convert tabs to spaces";

    /// <inheritdoc />
    public string Apply(string source) => Convert(source);

    /// <summary>
    /// Converts indentation/whitespace tabs to spaces in the given C# source, leaving tabs inside
    /// string/char literals and comments untouched.
    /// </summary>
    public string Convert(string source)
    {
        if (string.IsNullOrEmpty(source))
        {
            return source;
        }

        var root = CSharpSyntaxTree.ParseText(source).GetRoot();

        var tabbedTrivia = root
            .DescendantTrivia(descendIntoTrivia: true)
            .Where(t => (t.IsKind(SyntaxKind.WhitespaceTrivia) || t.IsKind(SyntaxKind.DocumentationCommentExteriorTrivia))
                && t.ToString().IndexOf('\t') >= 0)
            .ToList();

        if (tabbedTrivia.Count == 0)
        {
            return source;
        }

        var newRoot = root.ReplaceTrivia(tabbedTrivia, (original, rewritten) => ExpandTabs(original, source));

        return newRoot.ToFullString();
    }

    /// <summary>
    /// Expands the tabs of whitespace trivia, or of the indentation in front of a documentation
    /// comment exterior (leaving the tabs after <c>///</c> / <c>*</c> alone), to the next tab stop.
    /// </summary>
    private SyntaxTrivia ExpandTabs(SyntaxTrivia trivia, string source)
    {
        var text = trivia.ToString();
        var column = ColumnOf(source, trivia.SpanStart);
        if (trivia.IsKind(SyntaxKind.WhitespaceTrivia))
        {
            return SyntaxFactory.Whitespace(ExpandTabs(text, column));
        }

        int indentLength = 0;
        while (indentLength < text.Length && (text[indentLength] == ' ' || text[indentLength] == '\t'))
        {
            indentLength++;
        }

        var indent = ExpandTabs(text.Substring(0, indentLength), column);

        return SyntaxFactory.DocumentationCommentExterior(indent + text.Substring(indentLength));
    }

    private string ExpandTabs(string text, int column)
    {
        var expanded = new StringBuilder(text.Length + TabSize);
        foreach (var character in text)
        {
            if (character != '\t')
            {
                expanded.Append(character);
                column++;
                continue;
            }

            var width = TabSize - (column % TabSize);
            expanded.Append(' ', width);
            column += width;
        }

        return expanded.ToString();
    }

    /// <summary>The column a character at <paramref name="position" /> is shown in, a tab advancing to the next tab stop.</summary>
    private int ColumnOf(string source, int position)
    {
        var lineStart = position;
        while (lineStart > 0 && source[lineStart - 1] is not ('\n' or '\r'))
        {
            lineStart--;
        }

        var column = 0;
        for (var index = lineStart; index < position; index++)
        {
            column += source[index] == '\t' ? TabSize - (column % TabSize) : 1;
        }

        return column;
    }
}
