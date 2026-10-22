#nullable disable
using System;
using System.Collections.Generic;
using System.Text;

namespace CodeJanitor.Engine.Steps.Transformations;

/// <summary>
/// Updates #endregion directives to match the names of their corresponding #region directives,
/// and normalizes whitespace around region names.
/// </summary>
internal sealed class UpdateEndRegionDirectivesConverter : ISourceTransformation
{
    /// <summary>
    /// Gets the name.
    /// </summary>
    public string Name => "Update end region directives";

    /// <summary>
    /// Processes the source line by line, rewriting each `#endregion` directive to carry the name of its matching
    /// `#region` (tracked on a stack, nameless regions included), preserving indentation and the file's line breaks,
    /// and leaving unmatched lines and lines inside multi-line string literals or comments unchanged.
    /// </summary>
    /// <param name="source">The source.</param>
    /// <returns>A string value produced by this method.</returns>
    public string Apply(string source)
    {
        if (string.IsNullOrEmpty(source) || source.IndexOf("#endregion", StringComparison.Ordinal) < 0)
        {
            return source;
        }

        var protectedSpans = RegionDirectiveRemover.FindMultiLineLiteralAndCommentSpans(source);
        var regionStack = new Stack<string>();
        var result = new StringBuilder(source.Length);
        int lineStart = 0;

        while (lineStart < source.Length)
        {
            int contentEnd = RegionDirectiveRemover.FindLineEnd(source, lineStart, out int nextLineStart);
            bool isRegion = RegionDirectiveRemover.IsDirectiveLine(source, lineStart, contentEnd, "region", out int afterRegion);
            int afterEndRegion = 0;
            bool isEndRegion = !isRegion && regionStack.Count > 0
                && RegionDirectiveRemover.IsDirectiveLine(source, lineStart, contentEnd, "endregion", out afterEndRegion);
            bool isCode = (isRegion || isEndRegion) && !RegionDirectiveRemover.StartsInside(protectedSpans, lineStart);

            if (isRegion && isCode)
            {
                regionStack.Push(source.Substring(afterRegion, contentEnd - afterRegion).Trim());
                result.Append(source, lineStart, contentEnd - lineStart);
            }
            else if (isEndRegion && isCode)
            {
                string matchingRegionName = regionStack.Pop();

                // Keep the indentation, then build the new #endregion directive: "#endregion" + optional space + region name
                int indentationEnd = lineStart;
                while (source[indentationEnd] == ' ' || source[indentationEnd] == '\t')
                {
                    indentationEnd++;
                }

                result.Append(source, lineStart, indentationEnd - lineStart);
                result.Append("#endregion");
                if (!string.IsNullOrEmpty(matchingRegionName))
                {
                    result.Append(' ').Append(matchingRegionName);
                }

                int commentStart = source.IndexOf("//", afterEndRegion, contentEnd - afterEndRegion, StringComparison.Ordinal);
                if (commentStart >= 0)
                {
                    result.Append(' ').Append(source.AsSpan(commentStart, contentEnd - commentStart).TrimEnd());
                }
            }
            else
            {
                // Not a directive, or an #endregion without a matching #region: keep the line as-is
                result.Append(source, lineStart, contentEnd - lineStart);
            }

            result.Append(source, contentEnd, nextLineStart - contentEnd);
            lineStart = nextLineStart;
        }

        return result.ToString();
    }
}
