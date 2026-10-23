using System.Text.Json.Nodes;
using CodeJanitor.Engine.Comments.Options;

namespace CodeJanitor.Engine.Comments;

/// <summary>
/// The comment formatter for files that are not C# (Visual Basic, the C-family languages, PowerShell, R): the comments
/// of the text that start with a given prefix are wrapped and laid out as the C# ones are.
/// </summary>
public static class CommentTextFormatter
{
    /// <summary>
    /// Formats the comments of <paramref name="text" /> written with <paramref name="commentPrefix" /> (<c>'</c>,
    /// <c>//</c>, <c>#</c>) that start on a line in <paramref name="startLine" />..<paramref name="endLine" /> (0-based,
    /// inclusive; null for the whole text), with the <c>commentFormat</c> of <paramref name="settings" />.
    /// </summary>
    /// <exception cref="ArgumentException">The prefix is empty or holds whitespace.</exception>
    public static string Format(string text, string commentPrefix, JsonObject? settings, int? startLine, int? endLine)
    {
        if (string.IsNullOrEmpty(commentPrefix) || commentPrefix.Any(char.IsWhiteSpace))
        {
            throw new ArgumentException($"'{commentPrefix}' is not a comment prefix.", nameof(commentPrefix));
        }

        var options = FormatterOptions.FromSettings(CommentFormatSettings.From(settings?["commentFormat"] as JsonObject));

        return CodeComment.FormatComments(text, commentPrefix, options, startLine, endLine);
    }
}
