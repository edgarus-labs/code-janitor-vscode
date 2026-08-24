using System;

namespace CodeJanitor.Logic.Transformations;

/// <summary>
/// Ensures C# source ends with exactly one line break (the <c>insert_final_newline</c> convention).
/// </summary>
/// <remarks>
/// The line-break style (<c>\r\n</c> vs <c>\n</c>) matches the style already used in the file.
/// </remarks>

public sealed class EnsureFinalNewlineConverter : ISourceTransformation
{
    /// <inheritdoc />
    public string Name => "Ensure final newline";

    /// <inheritdoc />

    public string Apply(string source)
    {
        return Convert(source);
    }

    /// <summary>
    /// Appends a final line break to the given source when it does not already end with one.
    /// </summary>

    public string Convert(string source)
    {
        if (string.IsNullOrEmpty(source))
        {
            return source;
        }

        var newline = source.IndexOf("\r\n", StringComparison.Ordinal) >= 0 ? "\r\n" : "\n";
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
}
