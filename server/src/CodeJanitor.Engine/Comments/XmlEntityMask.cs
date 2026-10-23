using System.Text.RegularExpressions;

namespace CodeJanitor.Engine.Comments;

/// <summary>
/// Keeps the character and entity references of the XML text of a comment as they are written: the XML parser decodes them,
/// so their ampersand is hidden behind a private-use character while the comment is parsed and restored afterwards.
/// </summary>
internal static class XmlEntityMask
{
    private const char Hidden = '\uE000';

    private static readonly Regex Reference = new(@"&(?=(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9A-Fa-f]+);)", RegexOptions.Compiled);

    /// <summary>
    /// Hides the ampersand of every predefined entity and character reference of <paramref name="text" />; false, with the
    /// text unchanged, when there is none or the text already holds the private-use character.
    /// </summary>
    public static bool TryHide(string text, out string hidden)
    {
        hidden = text;
        if (text.Contains(Hidden, StringComparison.Ordinal))
        {
            return false;
        }

        hidden = Reference.Replace(text, Hidden.ToString());

        return !string.Equals(hidden, text, StringComparison.Ordinal);
    }

    public static string Restore(string text) => text.Replace(Hidden, '&');
}
