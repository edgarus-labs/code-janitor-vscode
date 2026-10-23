#nullable disable
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using CodeJanitor.Engine.Comments.Options;

namespace CodeJanitor.Engine.Comments;

/// <summary>
/// Represents a parsed code comment match containing structural attributes such as indentation, length, and style flags along with its constituent words.
/// </summary>
internal sealed class CodeCommentMatch
{
    public CodeCommentMatch(Match match, FormatterOptions formatterOptions)
    {
        if (!match.Success)
        {
            System.Diagnostics.Debug.Fail("Cannot parse a line that does not match the comment regex.");

            return;
        }

        if (formatterOptions.IgnoreTokens.Any(p => match.Value.StartsWith(p)))
        {
            Words = new List<string> { match.Groups["line"].Value };
            IsLiteral = true;
            IsEmpty = false;
            IsList = false;
        }
        else
        {
            Indent = match.Groups["indent"].Success ? match.Groups["indent"].Value.Length : 0;
            ListPrefix = match.Groups["listprefix"].Success ? match.Groups["listprefix"].Value : null;
            Words = match.Groups["words"].Success ? match.Groups["words"].Captures.OfType<Capture>().Select(c => c.Value).ToList() : null;

            IsLiteral = false;
            IsEmpty = string.IsNullOrWhiteSpace(match.Value) || Words is null || Words.Count < 1;
            IsList = !string.IsNullOrWhiteSpace(ListPrefix);
        }

        // In the case of a list prefix but no content (e.g. hyphen line) convert to regular content.
        if (IsEmpty && IsList)
        {
            Words = new List<string>(new[] { ListPrefix });
            ListPrefix = null;
            IsEmpty = false;
            IsList = false;
        }
    }

    /// <summary>
    /// Gets the indent.
    /// </summary>
    public int Indent { get; }

    /// <summary>
    /// Gets or sets the is empty.
    /// </summary>
    public bool IsEmpty { get; private set; }

    /// <summary>
    /// Gets the is list.
    /// </summary>
    public bool IsList { get; }

    /// <summary>
    /// Gets the is literal.
    /// </summary>
    public bool IsLiteral { get; }

    /// <summary>
    /// Gets the length.
    /// </summary>
    public int Length
    {
        get
        {
            return Indent - 1 +
                Words.Sum(w => w.Length + 1) +
                (IsList ? ListPrefix.Length + 1 : 0);
        }
    }

    /// <summary>
    /// Gets the list prefix.
    /// </summary>
    public string ListPrefix { get; }

    /// <summary>
    /// Gets the words.
    /// </summary>
    public List<string> Words { get; }

    /// <summary>
    /// Attempt to combine another match with this match. If possible, all words from the other
    /// match are appended to this match and the other match can be removed.
    /// </summary>
    /// <param name="other">The match to append.</param>
    /// <returns><c>true</c> if the matches were combined, otherwise <c>false</c>.</returns>
    public bool TryAppend(CodeCommentMatch other)
    {
        if (other is null)
        {
            return false;
        }

        if (IsEmpty || other.IsEmpty)
        {
            return false;
        }

        if (other.IsList)
        {
            return false;
        }

        if (IsList && other.Indent < 1)
        {
            return false;
        }

        if (IsLiteral || other.IsLiteral)
        {
            return false;
        }

        Words.AddRange(other.Words);
        IsEmpty = Words.Count < 1;

        return true;
    }
}
