using Microsoft.CodeAnalysis.Text;

namespace CodeJanitor.Engine.Pipeline;

/// <summary>Keeps the line ending style of a file when a rewrite inserts line breaks of its own.</summary>
internal static class LineEndings
{
    /// <summary>
    /// <paramref name="text"/> with every line break written as <c>end_of_line</c> says, otherwise as the one line ending
    /// <paramref name="original"/> uses throughout; unchanged when neither decides.
    /// </summary>
    public static SourceText Restore(SourceText text, SourceText original, string? endOfLine)
    {
        var lineEnding = Parse(endOfLine) ?? Uniform(original.ToString());
        if (lineEnding is null)
        {
            return text;
        }

        var content = text.ToString();
        var normalized = Normalize(content, lineEnding);

        return normalized == content ? text : SourceText.From(normalized, text.Encoding, text.ChecksumAlgorithm);
    }

    /// <summary>The line ending a text uses throughout, or null when it has none or mixes several.</summary>
    public static string? Uniform(string text)
    {
        int lf = 0, crLf = 0, cr = 0;
        for (var index = 0; index < text.Length; index++)
        {
            if (text[index] == '\r')
            {
                if (index + 1 < text.Length && text[index + 1] == '\n')
                {
                    crLf++;
                    index++;
                }
                else
                {
                    cr++;
                }
            }
            else if (text[index] == '\n')
            {
                lf++;
            }
        }

        return (lf, crLf, cr) switch
        {
            ( > 0, 0, 0) => "\n",
            (0, > 0, 0) => "\r\n",
            (0, 0, > 0) => "\r",
            _ => null,
        };
    }

    /// <summary>Writes every line break of <paramref name="text"/> as <paramref name="lineEnding"/>.</summary>
    public static string Normalize(string text, string lineEnding) =>
        text.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n').Replace("\n", lineEnding, StringComparison.Ordinal);

    private static string? Parse(string? endOfLine) => endOfLine?.Trim().ToLowerInvariant() switch
    {
        "lf" => "\n",
        "crlf" => "\r\n",
        "cr" => "\r",
        _ => null,
    };
}
