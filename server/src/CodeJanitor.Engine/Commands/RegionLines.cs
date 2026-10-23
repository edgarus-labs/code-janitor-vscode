using System.Text;
using System.Text.RegularExpressions;

namespace CodeJanitor.Engine.Commands;

/// <summary>Region directive edits on a range of lines.</summary>
internal static class RegionLines
{
    private static readonly Regex RegionDirective = new(@"^[ \t]*#[ \t]*(region|endregion)\b");

    /// <summary>
    /// Removes the <c>#region</c> and <c>#endregion</c> lines of the regions lying inside the lines
    /// <paramref name="firstLine" />..<paramref name="lastLine" /> (0-based, inclusive), with the blank lines next to them.
    /// </summary>
    public static string RemoveRegionsInLines(string source, int firstLine, int lastLine) =>
        RemoveRegions(source, firstLine, lastLine, null);

    /// <summary>
    /// Removes the region with a <c>#region</c> or <c>#endregion</c> on <paramref name="line" /> (0-based), keeping the
    /// regions nested in it, with the blank lines next to its directives.
    /// </summary>
    public static string RemoveRegionAt(string source, int line) => RemoveRegions(source, 0, int.MaxValue, line);

    private static string RemoveRegions(string source, int firstLine, int lastLine, int? directiveLine)
    {
        var lines = new List<(string Text, string Eol)>();
        var start = 0;
        while (start < source.Length)
        {
            var end = source.IndexOf('\n', start);
            if (end < 0)
            {
                lines.Add((source[start..], string.Empty));
                break;
            }

            var contentEnd = end > start && source[end - 1] == '\r' ? end - 1 : end;
            lines.Add((source[start..contentEnd], source[contentEnd..(end + 1)]));
            start = end + 1;
        }

        var open = new Stack<int>();
        var removed = new HashSet<int>();
        for (var line = Math.Max(0, firstLine); line <= lastLine && line < lines.Count; line++)
        {
            var match = RegionDirective.Match(lines[line].Text);
            if (!match.Success)
            {
                continue;
            }

            if (match.Groups[1].Value == "region")
            {
                open.Push(line);
            }
            else if (open.Count > 0)
            {
                var regionLine = open.Pop();
                if (directiveLine is not null && directiveLine != regionLine && directiveLine != line)
                {
                    continue;
                }

                foreach (var directive in new[] { regionLine, line })
                {
                    removed.Add(directive);
                    for (var blank = directive - 1; blank >= 0 && lines[blank].Text.Trim().Length == 0; blank--)
                    {
                        removed.Add(blank);
                    }

                    for (var blank = directive + 1; blank < lines.Count && lines[blank].Text.Trim().Length == 0; blank++)
                    {
                        removed.Add(blank);
                    }
                }
            }
        }

        if (removed.Count == 0)
        {
            return source;
        }

        var result = new StringBuilder(source.Length);
        for (var line = 0; line < lines.Count; line++)
        {
            if (!removed.Contains(line))
            {
                result.Append(lines[line].Text).Append(lines[line].Eol);
            }
        }

        var text = result.ToString();
        var endsWithNewline = source.EndsWith('\n');

        return endsWithNewline || !text.EndsWith('\n') ? text : text.TrimEnd('\n').TrimEnd('\r');
    }
}
