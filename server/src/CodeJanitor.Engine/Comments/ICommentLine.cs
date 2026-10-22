#nullable disable
namespace CodeJanitor.Engine.Comments;

/// <summary>
/// Represents a single line within a multi-line comment, exposing its textual content and indicating whether it is the final line of the comment.
/// </summary>
internal interface ICommentLine
{
    string Content { get; }

    bool IsLast { get; }
}
