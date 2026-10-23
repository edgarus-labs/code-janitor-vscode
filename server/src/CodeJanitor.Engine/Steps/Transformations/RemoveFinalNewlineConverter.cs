#nullable disable
namespace CodeJanitor.Engine.Steps.Transformations;

/// <summary>
/// Removes the line breaks at the end of C# source (the <c>insert_final_newline = false</c> convention), the reverse
/// of <see cref="EnsureFinalNewlineConverter" />. Pure and unit-testable without Visual Studio.
/// </summary>
/// <remarks>
/// Everything after the last line with content is removed when it contains a line break: the final line break and
/// any blank (empty or whitespace-only) lines after it. Whitespace at the end of the last line with content is kept;
/// removing it is the job of <see cref="RemoveTrailingWhitespaceConverter" />.
/// </remarks>
internal sealed class RemoveFinalNewlineConverter : ISourceTransformation
{
    /// <inheritdoc />
    public string Name => "Remove final newline";

    /// <inheritdoc />
    public string Apply(string source) => Convert(source);

    /// <summary>
    /// Removes the line breaks, and the blank lines between them, at the end of the given source.
    /// </summary>
    public string Convert(string source)
    {
        if (string.IsNullOrEmpty(source))
        {
            return source;
        }

        var contentEnd = source.Length;
        while (contentEnd > 0 && IsWhitespaceOrLineBreak(source[contentEnd - 1]))
        {
            contentEnd--;
        }

        var lineBreak = source.IndexOfAny(new[] { '\r', '\n' }, contentEnd);

        return lineBreak < 0 ? source : source.Substring(0, lineBreak);
    }

    private static bool IsWhitespaceOrLineBreak(char character) =>
        character == ' ' || character == '\t' || character == '\r' || character == '\n';
}
