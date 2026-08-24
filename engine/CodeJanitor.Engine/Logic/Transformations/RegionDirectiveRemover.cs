using System.Text.RegularExpressions;

namespace CodeJanitor.Logic.Transformations;

/// <summary>
/// Removes C# #region and #endregion directive lines while preserving other preprocessor directives.
/// </summary>

public sealed class RegionDirectiveRemover : ISourceTransformation
{
    private static readonly Regex RegionDirectiveRegex = new Regex(
        @"^[ \t]*#(?:end)?region\b[^\r\n]*(?:\r?\n)?",
        RegexOptions.Multiline | RegexOptions.Compiled);

    /// <summary>
    /// Gets the name.
    /// </summary>
    public string Name => "Remove region directives";

    /// <summary>
    /// Returns the input unchanged if it is null or empty; otherwise removes all matches of RegionDirectiveRegex from the string, with no side effects or thrown exceptions.
    /// </summary>
    /// <param name="source">The source.</param>
    /// <returns>A string value produced by this method.</returns>

    public string Apply(string source)
    {
        if (string.IsNullOrEmpty(source))
        {
            return source;
        }

        return RegionDirectiveRegex.Replace(source, string.Empty);
    }
}
