#nullable disable
using System;
using System.Text;
using Microsoft.CodeAnalysis.CSharp;

namespace CodeJanitor.Engine.Steps.Transformations;

/// <summary>
/// Converts the leading indentation of C# source lines from spaces to tabs (the <c>indent_style = tab</c>
/// convention), the reverse of <see cref="TabToSpaceConverter" />. Pure and unit-testable without Visual Studio.
/// </summary>
/// <remarks>
/// Only the whitespace at the start of a line is rewritten: its width (tabs advance to the next tab stop) becomes as
/// many tabs as there are full <see cref="TabSize" /> groups, followed by the remaining spaces. Lines starting inside a
/// multi-line string literal, text disabled by <c>#if</c> or a multi-line comment are left untouched (see
/// <see cref="IndentationGuard" />), as are blank lines; line breaks are preserved.
/// </remarks>
internal sealed class SpaceToTabConverter : ISourceTransformation
{
    /// <summary>
    /// Initializes a converter that turns every <paramref name="tabSize" /> columns of indentation into a tab.
    /// </summary>
    /// <param name="tabSize">The number of columns a tab stands for.</param>
    public SpaceToTabConverter(int tabSize)
    {
        if (tabSize < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(tabSize), "Tab size must be at least 1.");
        }

        TabSize = tabSize;
    }

    /// <summary>
    /// Gets the number of columns a tab stands for.
    /// </summary>
    public int TabSize { get; }

    /// <inheritdoc />
    public string Name => "Convert spaces to tabs";

    /// <inheritdoc />
    public string Apply(string source) => Convert(source);

    /// <summary>
    /// Converts the leading indentation spaces of the given C# source to tabs.
    /// </summary>
    public string Convert(string source)
    {
        if (string.IsNullOrEmpty(source) || source.IndexOf(' ') < 0)
        {
            return source;
        }

        var tree = CSharpSyntaxTree.ParseText(source);
        var root = tree.GetRoot();
        StringBuilder builder = null;
        var copied = 0;

        foreach (var line in tree.GetText().Lines)
        {
            var contentStart = line.Start;
            var width = 0;
            var hasSpace = false;
            while (contentStart < line.End && (source[contentStart] == ' ' || source[contentStart] == '\t'))
            {
                if (source[contentStart] == ' ')
                {
                    hasSpace = true;
                    width++;
                }
                else
                {
                    width += TabSize - (width % TabSize);
                }

                contentStart++;
            }

            if (!hasSpace || contentStart == line.End || !IndentationGuard.CanChangeIndentation(root, line.Start))
            {
                continue;
            }

            var indentation = new string('\t', width / TabSize) + new string(' ', width % TabSize);
            if (contentStart - line.Start == indentation.Length && string.CompareOrdinal(source, line.Start, indentation, 0, indentation.Length) == 0)
            {
                continue;
            }

            builder ??= new StringBuilder(source.Length);
            builder.Append(source, copied, line.Start - copied).Append(indentation);
            copied = contentStart;
        }

        if (builder is null)
        {
            return source;
        }

        builder.Append(source, copied, source.Length - copied);

        return builder.ToString();
    }
}
