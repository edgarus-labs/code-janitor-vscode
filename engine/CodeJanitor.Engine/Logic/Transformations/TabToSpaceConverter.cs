using System;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace CodeJanitor.Logic.Transformations;

/// <summary>
/// Replaces tab characters in C# whitespace/indentation with spaces, without touching tabs that
/// are part of string/char literals, verbatim strings or comment text (headless-Roslyn block for
/// BL-018). Pure and unit-testable without Visual Studio.
/// </summary>
/// <remarks>
/// Only <see cref="SyntaxKind.WhitespaceTrivia" /> is rewritten, so tabs inside string literals
/// are preserved exactly. Each tab is expanded to a fixed number of spaces (<see cref="TabSize" />);
/// this is a simple fixed-width expansion, not column-aware elastic-tab alignment.
/// </remarks>

public sealed class TabToSpaceConverter : ISourceTransformation
{
    /// <summary>
    /// The default tab size.
    /// </summary>
    private const int DefaultTabSize = 4;

    private readonly string _replacement;

    /// <summary>
    /// Initializes a converter that expands each tab to the default number of spaces (4).
    /// </summary>

    public TabToSpaceConverter()
        : this(DefaultTabSize)
    {
    }

    /// <summary>
    /// Initializes a converter that expands each tab to <paramref name="tabSize" /> spaces.
    /// </summary>

    public TabToSpaceConverter(int tabSize)
    {
        if (tabSize < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(tabSize), "Tab size must be at least 1.");
        }

        TabSize = tabSize;
        _replacement = new string(' ', tabSize);
    }

    /// <summary>
    /// Gets the number of spaces each tab is expanded to.
    /// </summary>
    public int TabSize { get; }

    /// <inheritdoc />
    public string Name => "Convert tabs to spaces";

    /// <inheritdoc />

    public string Apply(string source)
    {
        return Convert(source);
    }

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
            .Where(t => t.IsKind(SyntaxKind.WhitespaceTrivia) && t.ToString().IndexOf('\t') >= 0)
            .ToList();

        if (tabbedTrivia.Count == 0)
        {
            return source;
        }

        var newRoot = root.ReplaceTrivia(
            tabbedTrivia,
            (original, rewritten) => SyntaxFactory.Whitespace(original.ToString().Replace("\t", _replacement)));

        return newRoot.ToFullString();
    }
}
