using System.Text;
using Microsoft.CodeAnalysis.Text;

namespace CodeJanitor.Server;

/// <summary>
/// How file texts cross the protocol: a UTF-8 byte order mark is a leading U+FEFF in protocol text and a UTF-8
/// encoding with a preamble on the <see cref="SourceText"/>; line endings are kept as the original file has them.
/// </summary>
internal static class TextConventions
{
    private static readonly Encoding Utf8WithBom = new UTF8Encoding(encoderShouldEmitUTF8Identifier: true);
    private static readonly Encoding Utf8WithoutBom = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);

    private enum LineEndingStyle
    {
        None,
        Lf,
        CrLf,
        Cr,
        Mixed,
    }

    /// <summary>The source text of a protocol text: a leading U+FEFF becomes the encoding's byte order mark.</summary>
    public static SourceText ToSourceText(string text) =>
        text.StartsWith('\uFEFF') ? SourceText.From(text[1..], Utf8WithBom) : SourceText.From(text, Utf8WithoutBom);

    public static bool HasByteOrderMark(SourceText text) => text.Encoding?.GetPreamble().Length > 0;

    /// <summary>
    /// The protocol text of <paramref name="result"/>, a text derived from <paramref name="original"/>: with a leading
    /// U+FEFF when the result's encoding has a byte order mark (the original's when the result has no encoding), and with
    /// the original's line ending where the result mixes another one into an original that used one line ending throughout.
    /// </summary>
    public static string ToProtocolText(SourceText original, SourceText result)
    {
        var bom = result.Encoding is null ? HasByteOrderMark(original) : HasByteOrderMark(result);
        var text = KeepLineEndings(original.ToString(), result.ToString());

        return bom ? "\uFEFF" + text : text;
    }

    /// <summary>
    /// <paramref name="result"/> with its line breaks normalized to the uniform line ending of <paramref name="original"/>
    /// when the result mixes line endings and the original's is still the most frequent one (a fix inserted a few others);
    /// a result whose line breaks mostly changed is the engine's decision (<c>end_of_line</c>) and is kept.
    /// </summary>
    private static string KeepLineEndings(string original, string result)
    {
        var style = StyleOf(original, out _);
        if (style is LineEndingStyle.None or LineEndingStyle.Mixed || StyleOf(result, out var counts) != LineEndingStyle.Mixed)
        {
            return result;
        }

        var kept = counts[(int)style];
        if (kept * 2 < counts[(int)LineEndingStyle.Lf] + counts[(int)LineEndingStyle.CrLf] + counts[(int)LineEndingStyle.Cr])
        {
            return result;
        }

        var lineEnding = style switch
        {
            LineEndingStyle.CrLf => "\r\n",
            LineEndingStyle.Cr => "\r",
            _ => "\n",
        };
        var builder = new StringBuilder(result.Length + counts[(int)LineEndingStyle.Lf]);
        for (var index = 0; index < result.Length; index++)
        {
            var character = result[index];
            if (character == '\r')
            {
                if (index + 1 < result.Length && result[index + 1] == '\n')
                {
                    index++;
                }

                builder.Append(lineEnding);
            }
            else if (character == '\n')
            {
                builder.Append(lineEnding);
            }
            else
            {
                builder.Append(character);
            }
        }

        return builder.ToString();
    }

    private static LineEndingStyle StyleOf(string text, out int[] counts)
    {
        counts = new int[5];
        for (var index = 0; index < text.Length; index++)
        {
            if (text[index] == '\r')
            {
                if (index + 1 < text.Length && text[index + 1] == '\n')
                {
                    counts[(int)LineEndingStyle.CrLf]++;
                    index++;
                }
                else
                {
                    counts[(int)LineEndingStyle.Cr]++;
                }
            }
            else if (text[index] == '\n')
            {
                counts[(int)LineEndingStyle.Lf]++;
            }
        }

        var found = counts;
        var used = new[] { LineEndingStyle.Lf, LineEndingStyle.CrLf, LineEndingStyle.Cr }.Where(style => found[(int)style] > 0).ToArray();

        return used.Length switch
        {
            0 => LineEndingStyle.None,
            1 => used[0],
            _ => LineEndingStyle.Mixed,
        };
    }
}
