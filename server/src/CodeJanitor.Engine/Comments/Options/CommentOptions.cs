#nullable disable
using System.Text.RegularExpressions;

namespace CodeJanitor.Engine.Comments.Options;

/// <summary>
/// Comment specific options for the formatter.
/// </summary>
internal sealed class CommentOptions
{
    /// <summary>
    /// Gets or sets the prefix.
    /// </summary>
    public string Prefix { get; internal set; }

    /// <summary>
    /// Gets or sets the regex.
    /// </summary>
    public Regex Regex { get; internal set; }

    /// <summary>
    /// Gets or sets the line break written between formatted lines.
    /// </summary>
    public string NewLine { get; internal set; } = "\r\n";
}
