#nullable disable
using System;

namespace CodeJanitor.Engine.Steps.Transformations;

/// <summary>
/// Ensures C# source ends with exactly one line break (the <c>insert_final_newline</c> convention).
/// </summary>
/// <remarks>
/// The line-break style (<c>\r\n</c>, <c>\n</c> or <c>\r</c>) matches the style already used in the
/// file; a file without any line break gets <c>\n</c>.
/// </remarks>
internal sealed class EnsureFinalNewlineConverter : ISourceTransformation
{
    /// <inheritdoc />
    public string Name => "Ensure final newline";

    /// <inheritdoc />
    public string Apply(string source) => Convert(source);

    /// <summary>
    /// Appends a final line break to the given source when it does not already end with one.
    /// </summary>
    public string Convert(string source)
    {
        if (string.IsNullOrEmpty(source))
        {
            return source;
        }

        var newline = DetectNewline(source);
        var trimmed = source;

        while (trimmed.EndsWith("\r\n", StringComparison.Ordinal))
        {
            trimmed = trimmed.Substring(0, trimmed.Length - 2);
        }

        while (trimmed.EndsWith("\n", StringComparison.Ordinal) || trimmed.EndsWith("\r", StringComparison.Ordinal))
        {
            trimmed = trimmed.Substring(0, trimmed.Length - 1);
        }

        return trimmed + newline;
    }

    /// <summary>
    /// Returns CRLF when the source contains one, otherwise LF when it contains one, otherwise CR
    /// when it contains one, and LF for a source without line breaks.
    /// </summary>
    private static string DetectNewline(string source)
    {
        if (source.IndexOf("\r\n", StringComparison.Ordinal) >= 0)
        {
            return "\r\n";
        }

        if (source.IndexOf('\n') >= 0 || source.IndexOf('\r') < 0)
        {
            return "\n";
        }

        return "\r";
    }
}
