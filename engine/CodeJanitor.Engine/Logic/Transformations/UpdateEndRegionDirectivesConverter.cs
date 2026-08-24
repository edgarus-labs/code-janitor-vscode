using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace CodeJanitor.Logic.Transformations;

/// <summary>
/// Updates #endregion directives to match the names of their corresponding #region directives,
/// and normalizes whitespace around region names.
/// </summary>

public sealed class UpdateEndRegionDirectivesConverter : ISourceTransformation
{
    private static readonly Regex RegionDirectiveRegex = new Regex(
        @"^[ \t]*#region\b[ \t]*(.*)$",
        RegexOptions.Multiline | RegexOptions.Compiled);

    private static readonly Regex EndRegionDirectiveRegex = new Regex(
        @"^[ \t]*#endregion\b[ \t]*(.*)$",
        RegexOptions.Multiline | RegexOptions.Compiled);

    /// <summary>
    /// Gets the name.
    /// </summary>
    public string Name => "Update end region directives";

    /// <summary>
    /// The method processes C# source text line by line, rewriting each `#endregion` directive to append the name of its matching `#region` based on a stack, preserving indentation and leaving unmatched or non-region lines unchanged, while returning the input unchanged for null/empty strings and having no side effects.
    /// </summary>
    /// <param name="source">The source.</param>
    /// <returns>A string value produced by this method.</returns>

    public string Apply(string source)
    {
        if (string.IsNullOrEmpty(source))
        {
            return source;
        }

        var lines = source.Split(new[] { "\r\n", "\r", "\n" }, StringSplitOptions.None);
        var regionStack = new Stack<string>();
        var regionNames = new Dictionary<int, string>(); // line index -> region name for endregions
        var result = new StringBuilder();

        for (int i = 0; i < lines.Length; i++)
        {
            string line = lines[i];
            string trimmedLine = line.TrimStart();

            // Check for #region directive
            if (trimmedLine.StartsWith("#region ", StringComparison.Ordinal))
            {
                string regionName = trimmedLine.Substring(8).Trim(); // Skip "#region "
                regionStack.Push(regionName);
                result.Append(line);
            }
            // Check for #endregion directive
            else if (trimmedLine.StartsWith("#endregion", StringComparison.Ordinal))
            {
                if (regionStack.Count > 0)
                {
                    string matchingRegionName = regionStack.Pop();
                    string indentation = GetIndentation(line);

                    // Build the new #endregion directive: "#endregion" + optional space + region name
                    string newDirective = string.IsNullOrEmpty(matchingRegionName) ?
                        "#endregion" :
                        $"#endregion {matchingRegionName}";

                    result.Append(indentation).Append(newDirective);
                }
                else
                {
                    // Mismatched regions, keep line as-is
                    result.Append(line);
                }
            }
            else
            {
                result.Append(line);
            }

            // Add line ending for all but last line
            if (i < lines.Length - 1)
            {
                result.AppendLine();
            }
        }

        return result.ToString();
    }

    /// <summary>
    /// Returns the leading whitespace (spaces and tabs) from the input line by counting consecutive whitespace characters until the first non-whitespace character, then extracting that substring with no side effects or thrown exceptions.
    /// </summary>
    /// <param name="line">The line.</param>
    /// <returns>A string value produced by this method.</returns>

    private static string GetIndentation(string line)
    {
        int count = 0;
        foreach (char c in line)
        {
            if (c == ' ' || c == '\t')
                count++;
            else
                break;
        }

        return line.Substring(0, count);
    }
}
