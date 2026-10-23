using System.Text;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;
using CodeJanitor.Engine.Comments.Options;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace CodeJanitor.Engine.Comments;

/// <summary>
/// Formats the <c>//</c> and <c>///</c> comments of C# source: wraps them at the wrap column, lays out their XML
/// documentation tags and keeps list items and literal lines, as the Visual Studio extension's comment formatter.
/// </summary>
internal static class CodeComment
{
    /// <summary>
    /// Formats the text of one comment given without its comment prefixes (used by the formatter tests).
    /// </summary>
    public static string Format(string text, string? prefix = null, Action<FormatterOptions>? options = null, CommentFormatSettings? settings = null)
    {
        var hidden = XmlEntityMask.TryHide(text, out var xmlText);
        var xml = XElement.Parse($"<doc>{xmlText}</doc>");

        var formatterOptions = FormatterOptions
            .FromSettings(settings ?? new CommentFormatSettings())
            .Set(o => o.IgnoreTokens = ["TODO: "]);

        options?.Invoke(formatterOptions);

        var commentOptions = new CommentOptions
        {
            Prefix = prefix,
            Regex = CodeCommentHelper.GetCommentRegex(!string.IsNullOrWhiteSpace(prefix)),
        };

        var formatted = new CommentFormatter(new CommentLineXml(xml, formatterOptions), formatterOptions, commentOptions).ToString();

        return hidden ? XmlEntityMask.Restore(formatted) : formatted;
    }

    /// <summary>
    /// Formats the comments of <paramref name="source" /> that start on a line in
    /// <paramref name="startLine" />..<paramref name="endLine" /> (0-based, inclusive; null for the whole file).
    /// A comment is a run of comment lines with the same prefix; one whose text follows the prefix without a space
    /// (commented-out code) is left as it is.
    /// </summary>
    public static string FormatComments(string source, FormatterOptions options, int? startLine = null, int? endLine = null)
    {
        if (string.IsNullOrEmpty(source) || !source.Contains("//", StringComparison.Ordinal))
        {
            return source;
        }

        var lines = SplitLines(source);

        return FormatComments(source, lines, FindCommentLines(source, lines), CodeCommentHelper.GetCommentRegex(), options, startLine, endLine);
    }

    /// <summary>
    /// Formats the comments of a file in another language, as <see cref="FormatComments(string, FormatterOptions, int?, int?)" />
    /// does for C#: a comment line is a line whose first non-blank text is <paramref name="prefix" /> (the text is not
    /// parsed, so a prefix inside a line of code never starts a comment).
    /// </summary>
    public static string FormatComments(string source, string prefix, FormatterOptions options, int? startLine, int? endLine)
    {
        if (string.IsNullOrEmpty(source) || !source.Contains(prefix, StringComparison.Ordinal))
        {
            return source;
        }

        var lines = SplitLines(source);
        var commentLines = lines.Select(line => source.AsSpan(line.Start, line.End - line.Start).TrimStart(" \t").StartsWith(prefix, StringComparison.Ordinal)).ToArray();

        return FormatComments(source, lines, commentLines, CodeCommentHelper.CreateCommentRegexForPrefix(prefix), options, startLine, endLine);
    }

    private static string FormatComments(string source, List<LineSpan> lines, bool[] commentLines, Regex regex, FormatterOptions options, int? startLine, int? endLine)
    {
        var first = Math.Max(0, startLine ?? 0);
        var last = Math.Min(lines.Count - 1, endLine ?? lines.Count - 1);

        var output = new StringBuilder(source.Length);
        var copied = 0;
        for (var line = first; line <= last; line++)
        {
            if (!IsCommentLine(line))
            {
                continue;
            }

            var start = Expand(line, -1);
            var end = start < 0 ? -1 : Expand(line, 1);
            if (start < 0 || end < 0)
            {
                continue;
            }

            if (start < copied || start < first)
            {
                line = end;
                continue;
            }

            var original = source[lines[start].Start..lines[end].End];
            var formatted = FormatBlock(original, Enumerable.Range(start, end - start + 1).Select(Text), regex, options, NewLineOf(source, lines, start));
            if (!string.Equals(formatted, original, StringComparison.Ordinal))
            {
                output.Append(source, Offset(copied), lines[start].Start - Offset(copied));
                output.Append(formatted);
                copied = end + 1;
                output.Append(source, lines[end].End, lines[end].BreakEnd - lines[end].End);
            }

            line = end;
        }

        if (output.Length == 0 && copied == 0)
        {
            return source;
        }

        output.Append(source, Offset(copied), source.Length - Offset(copied));

        return output.ToString();

        int Offset(int lineIndex) => lineIndex >= lines.Count ? source.Length : lines[lineIndex].Start;

        bool IsCommentLine(int index) => commentLines[index] && regex.IsMatch(Text(index));

        string Text(int index) => source[lines[index].Start..lines[index].End];

        int Expand(int from, int step)
        {
            var result = -1;
            string? prefix = null;
            for (var current = from; current >= 0 && current < lines.Count; current += step)
            {
                if (!commentLines[current])
                {
                    break;
                }

                var match = regex.Match(Text(current));
                if (!match.Success)
                {
                    break;
                }

                var currentPrefix = match.Groups["prefix"].Value.TrimStart();
                if (prefix is not null && !string.Equals(prefix, currentPrefix, StringComparison.Ordinal))
                {
                    break;
                }

                prefix = currentPrefix;
                if (!match.Groups["initialspacer"].Success)
                {
                    return -1;
                }

                result = current;
            }

            return result;
        }
    }

    private static string FormatBlock(string originalText, IEnumerable<string> lineTexts, Regex regex, FormatterOptions formatterOptions, string newLine)
    {
        var matches = lineTexts.Select(text => regex.Match(text)).ToArray();
        if (matches.Length == 0 || matches.Any(m => !m.Success))
        {
            return originalText;
        }

        var commentOptions = new CommentOptions
        {
            Prefix = matches[0].Groups["prefix"].Value,
            Regex = CodeCommentHelper.GetCommentRegex(false),
            NewLine = newLine,
        };

        ICommentLine? line = null;
        var commentText = string.Join('\n', matches.Select(m => m.Groups["line"].Value));
        var hidden = false;
        if (commentText.Contains('<', StringComparison.Ordinal))
        {
            hidden = XmlEntityMask.TryHide(commentText, out var xmlText);
            try
            {
                line = new CommentLineXml(XElement.Parse($"<doc>{xmlText}</doc>"), formatterOptions);
            }
            catch (XmlException)
            {
                // Not XML: formatted as plain text.
                hidden = false;
            }
        }

        line ??= new CommentLine(commentText);
        var formatted = new CommentFormatter(line, formatterOptions, commentOptions).ToString();

        return hidden ? XmlEntityMask.Restore(formatted) : formatted;
    }

    /// <summary>
    /// For each line, whether its first non-blank text starts a <c>//</c> comment (and not, say, a string literal).
    /// </summary>
    private static bool[] FindCommentLines(string source, List<LineSpan> lines)
    {
        var root = CSharpSyntaxTree.ParseText(source).GetRoot();
        var result = new bool[lines.Count];
        for (var i = 0; i < lines.Count; i++)
        {
            var position = lines[i].Start;
            while (position < lines[i].End && (source[position] == ' ' || source[position] == '\t'))
            {
                position++;
            }

            if (position + 1 >= lines[i].End || source[position] != '/' || source[position + 1] != '/')
            {
                continue;
            }

            var trivia = root.FindTrivia(position, findInsideTrivia: false);
            result[i] = trivia.IsKind(SyntaxKind.SingleLineCommentTrivia) || trivia.IsKind(SyntaxKind.SingleLineDocumentationCommentTrivia);
        }

        return result;
    }

    private static string NewLineOf(string source, List<LineSpan> lines, int line)
    {
        var span = lines[line];
        if (span.BreakEnd > span.End)
        {
            return source[span.End..span.BreakEnd];
        }

        var crlf = source.Contains("\r\n", StringComparison.Ordinal);

        return crlf ? "\r\n" : "\n";
    }

    private static List<LineSpan> SplitLines(string source)
    {
        var lines = new List<LineSpan>();
        var start = 0;
        while (true)
        {
            var end = source.IndexOfAny(['\r', '\n'], start);
            if (end < 0)
            {
                lines.Add(new LineSpan(start, source.Length, source.Length));

                return lines;
            }

            var breakEnd = source[end] == '\r' && end + 1 < source.Length && source[end + 1] == '\n' ? end + 2 : end + 1;
            lines.Add(new LineSpan(start, end, breakEnd));
            start = breakEnd;
            if (start == source.Length)
            {
                return lines;
            }
        }
    }

    private readonly record struct LineSpan(int Start, int End, int BreakEnd);
}
