#nullable disable
namespace CodeJanitor.Engine.Comments;

/// <summary>
/// presents a single line of a comment, storing its textual content and indicating whether it is the final line.
/// </summary>
internal class CommentLine : ICommentLine
{
    public CommentLine(string content)
    {
        if (!string.IsNullOrWhiteSpace(content))
        {
            Content = content;
        }
    }

    /// <summary>
    /// Gets or sets the content.
    /// </summary>
    public string Content { get; protected set; }

    /// <summary>
    /// Gets or sets the is last.
    /// </summary>
    public bool IsLast { get; internal set; }
}
