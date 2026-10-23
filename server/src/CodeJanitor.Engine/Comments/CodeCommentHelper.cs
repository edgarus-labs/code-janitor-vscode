using System.Text.RegularExpressions;

namespace CodeJanitor.Engine.Comments;

/// <summary>
/// Helpers for C# comment lines.
/// </summary>
internal static class CodeCommentHelper
{
    /// <summary>
    /// The extra indent of the content of a <c>copyright</c> tag.
    /// </summary>
    public const int CopyrightExtraIndent = 4;

    /// <summary>
    /// The spacer that keeps words together while wrapping.
    /// </summary>
    public const char KeepTogetherSpacer = '\a';

    /// <summary>
    /// The spacer.
    /// </summary>
    public const char Spacer = ' ';

    private const string CSharpCommentPrefix = "///?";

    private static readonly Regex WithPrefix = CreateCommentRegex(CSharpCommentPrefix);
    private static readonly Regex WithoutPrefix = CreateCommentRegex(null);

    internal static string FakeToSpace(string value) => value.Replace(KeepTogetherSpacer, Spacer);

    internal static string SpaceToFake(string value) => value.Replace(Spacer, KeepTogetherSpacer);

    /// <summary>
    /// Gets the regex matching a complete C# comment line, with or without its <c>//</c> prefix.
    /// </summary>
    internal static Regex GetCommentRegex(bool includePrefix = true) => includePrefix ? WithPrefix : WithoutPrefix;

    /// <summary>
    /// Gets the regex matching a complete comment line whose prefix is <paramref name="prefix" /> repeated at least
    /// once more by its last character (<c>'</c> matches <c>'</c> and <c>'''</c>, <c>//</c> matches <c>//</c> and <c>///</c>).
    /// </summary>
    internal static Regex CreateCommentRegexForPrefix(string prefix) => CreateCommentRegex(Regex.Escape(prefix) + Regex.Escape(prefix[^1..]) + "*");

    private static Regex CreateCommentRegex(string? prefixPattern)
    {
        var prefix = prefixPattern is null ? null : $"(?<prefix>[\t ]*{prefixPattern})(?<initialspacer>( |\t|(?=\r|\n)|$))?";
        const string Word = @"[^\t\r\n ]+";
        var pattern = $@"^{prefix}(?<indent>[\t ]*)(?<line>(?<listprefix>[-=\*\+]+[ \t]*|\w+[\):][ \t]+|\d+\.[ \t]+)?(?:(?<words>{Word})(?:[\t ]+(?<words>{Word}))*)?[\t ]*)\r*\n?$";

        return new Regex(pattern, RegexOptions.ExplicitCapture | RegexOptions.Multiline);
    }
}
