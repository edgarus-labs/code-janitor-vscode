using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace CodeJanitor.Engine.Steps.Transformations;

/// <summary>Where the C# file header goes.</summary>
internal enum HeaderPosition
{
    DocumentStart = 0,
    AfterUsings = 1,
}

/// <summary>Whether an existing file header is kept (a new one inserted before it) or replaced.</summary>
internal enum HeaderUpdateMode
{
    Insert = 0,
    Replace = 1,
}

/// <summary>
/// The C# file header and the blank-line removals of the cleanup. The line ending is always the file's own.
/// </summary>
internal static class FileHeaderAndBlankLines
{
    private static readonly Regex BlankLinesAtTop = new(@"\A(?:[ \t]*\r?\n)+");
    private static readonly Regex BlankLinesAtBottom = new(@"(?:\r?\n[ \t]*)+\z");
    private static readonly Regex BlankLinesAfterAttributes = new(@"(^[ \t]*\[(?![ \t]*(?:assembly|module)[ \t]*:)[^\]]+\][ \t]*(?://[^\r\n]*)*)(?:\r?\n){2}(?![ \t]*//)", RegexOptions.Multiline);
    private static readonly Regex BlankLinesAfterDocumentationComments = new(@"(^[ \t]*///(?!/)[^\r\n]*)(\r?\n)(?:[ \t]*\r?\n)+", RegexOptions.Multiline);
    private static readonly Regex BlankLinesAfterOpeningBrace = new(@"\{([ \t]*(?://[^\r\n]*)*)(?:\r?\n){2,}", RegexOptions.Multiline);
    private static readonly Regex BlankLinesBeforeClosingBrace = new(@"(?:\r?\n){2,}([ \t]*)\}", RegexOptions.Multiline);
    private static readonly Regex BlankLinesBetweenChainedStatements = new(@"(?:\r?\n){2,}([ \t]*)(else|catch|finally)( |\t|\r?\n)", RegexOptions.Multiline);
    private static readonly Regex LineHeader = new(@"\A(?:[ \t]*\r?\n)*(?://(?!/(?!/))[^\r\n]*(?:\r?\n//(?!/(?!/))[^\r\n]*)*(?:\r?\n)?)");
    private static readonly Regex BlockHeader = new(@"\A(?:[ \t]*\r?\n)*/\*(?!\*(?![*/]))[\s\S]*?\*/(?:\r?\n)?");

    public static string RemoveBlankLinesAtTop(string source) => BlankLinesAtTop.Replace(source, string.Empty, 1);

    /// <summary>
    /// Removes the blank lines at the end of the file, with the final newline unless <paramref name="keepFinalNewline" />.
    /// </summary>
    public static string RemoveBlankLinesAtBottom(string source, bool keepFinalNewline)
    {
        var trailing = BlankLinesAtBottom.Match(source);
        if (!trailing.Success)
        {
            return source;
        }

        var finalNewline = keepFinalNewline ? (trailing.Value.StartsWith("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n") : string.Empty;

        return string.Concat(source.AsSpan(0, trailing.Index), finalNewline);
    }

    /// <summary>Removes the blank line between an attribute and what it applies to; <c>assembly:</c>/<c>module:</c> attributes keep theirs.</summary>
    public static string RemoveBlankLinesAfterAttributes(string source) => Replace(source, BlankLinesAfterAttributes, "$1{NL}");

    /// <summary>Removes the blank lines between a <c>///</c> documentation comment and its declaration.</summary>
    public static string RemoveBlankLinesAfterDocumentationComments(string source) => Replace(source, BlankLinesAfterDocumentationComments, "$1{NL}");

    public static string RemoveBlankLinesAfterOpeningBrace(string source) => Replace(source, BlankLinesAfterOpeningBrace, "{$1{NL}");

    public static string RemoveBlankLinesBeforeClosingBrace(string source) => Replace(source, BlankLinesBeforeClosingBrace, "{NL}$1}");

    public static string RemoveBlankLinesBetweenChainedStatements(string source) => Replace(source, BlankLinesBetweenChainedStatements, "{NL}$1$2$3");

    /// <summary>Applies the configured C# file header at the start of the file or after the top-level using directives.</summary>
    public static string ApplyFileHeader(string source, string header, HeaderPosition position, HeaderUpdateMode updateMode)
    {
        if (string.IsNullOrWhiteSpace(header))
        {
            return source;
        }

        var newline = NewLineOf(source);
        header = header.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n').Replace("\n", newline, StringComparison.Ordinal);
        if (!header.EndsWith(newline, StringComparison.Ordinal))
        {
            header += newline;
        }

        var trimmed = header.Trim();
        if (position == HeaderPosition.DocumentStart)
        {
            if (updateMode == HeaderUpdateMode.Insert)
            {
                return source.StartsWith(trimmed, StringComparison.Ordinal) ? source : header + source;
            }

            var current = LeadingHeader(source);

            return current.Trimmed == trimmed ? source : header + source[current.Length..];
        }

        var insertionIndex = TopLevelUsingInsertionIndex(source);
        var suffix = source[insertionIndex..];
        var existing = LeadingHeader(suffix);
        var afterNewline = header.StartsWith(newline, StringComparison.Ordinal) ? header : newline + header;
        if (updateMode == HeaderUpdateMode.Insert)
        {
            return existing.Trimmed.StartsWith(trimmed, StringComparison.Ordinal) ? source : source[..insertionIndex] + afterNewline + suffix;
        }

        return existing.Trimmed == trimmed ? source : source[..insertionIndex] + afterNewline + suffix[existing.Length..];
    }

    /// <summary>
    /// The C# file header defined by an <c>.editorconfig</c> <c>file_header_template</c>: each template line becomes a
    /// <c>//</c> line, <c>\n</c> escapes separate lines and <c>{fileName}</c> is the file name. Null for an empty or
    /// <c>unset</c> template.
    /// </summary>
    public static string? HeaderFromTemplate(string template, string? filePath)
    {
        template = template.Trim();
        if (template.Length == 0 || string.Equals(template, "unset", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var fileName = string.IsNullOrEmpty(filePath) ? string.Empty : Path.GetFileName(filePath);
        var lines = template.Replace("{fileName}", fileName, StringComparison.Ordinal)
            .Split("\\n")
            .Select(line => line.Length == 0 ? "//" : $"// {line}");

        return string.Join('\n', lines);
    }

    /// <summary>The offset just past the line of the last compilation-unit-level using directive, or 0.</summary>
    public static int TopLevelUsingInsertionIndex(string source)
    {
        var root = (CompilationUnitSyntax)CSharpSyntaxTree.ParseText(source).GetRoot();
        if (root.Usings.Count == 0)
        {
            return 0;
        }

        var end = root.Usings[^1].Span.End;
        var lineEnd = source.IndexOf('\n', end);

        return lineEnd < 0 ? source.Length : lineEnd + 1;
    }

    internal static string NewLineOf(string source) => source.Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n";

    private static (int Length, string Trimmed) LeadingHeader(string source)
    {
        var match = LineHeader.Match(source);
        if (!match.Success || match.Length == 0)
        {
            match = BlockHeader.Match(source);
        }

        return match.Success && match.Length > 0 ? (match.Length, match.Value.Trim()) : (0, string.Empty);
    }

    /// <summary>
    /// Replaces the matches of <paramref name="pattern" /> that lie outside the multi-line string literals and comments,
    /// whose text is never changed.
    /// </summary>
    private static string Replace(string source, Regex pattern, string replacement)
    {
        var matches = pattern.Matches(source);
        if (matches.Count == 0)
        {
            return source;
        }

        var untouchable = RegionDirectiveRemover.FindMultiLineLiteralAndCommentSpans(source);
        var resolved = replacement.Replace("{NL}", NewLineOf(source), StringComparison.Ordinal);

        return pattern.Replace(source, match => Overlaps(untouchable, match) ? match.Value : match.Result(resolved));
    }

    private static bool Overlaps(List<TextSpan> spans, Match match) => spans.Exists(span => span.Start < match.Index + match.Length && match.Index < span.End);
}
