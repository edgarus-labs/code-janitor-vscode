using System.Text.RegularExpressions;

namespace CodeJanitor.Logic.Transformations;

/// <summary>
/// Collapses runs of two or more consecutive blank lines down to one (headless-Roslyn-path block
/// for BL-018). Pure and unit-testable. Safe alongside <c>InsertBlankLinePaddingLogic</c>, which
/// adds at most one blank line at a time.
/// </summary>

public sealed class NormalizeBlankLinesConverter : ISourceTransformation
{
    // Matches 3+ consecutive newlines (= 2+ blank lines), where intermediate lines may contain
    // only horizontal whitespace. Handles \n and \r\n. [^\S\r\n] = whitespace excluding newlines.

    private static readonly Regex _excessiveBlankLines =
        new Regex(@"\r?\n([^\S\r\n]*\r?\n){2,}", RegexOptions.Compiled);

    /// <inheritdoc />
    public string Name => "Normalize blank lines";

    /// <inheritdoc />

    public string Apply(string source)
    {
        return Normalize(source);
    }

    /// <summary>
    /// Collapses any run of two or more consecutive blank lines to a single blank line.
    /// </summary>

    public string Normalize(string source)
    {
        if (string.IsNullOrEmpty(source))
        {
            return source;
        }

        // MatchEvaluator ensures the replacement uses the file's own line-ending style.

        return _excessiveBlankLines.Replace(source, m =>
        {
            var nl = m.Value.Contains("\r\n") ? "\r\n" : "\n";

            return nl + nl;
        });
    }
}
