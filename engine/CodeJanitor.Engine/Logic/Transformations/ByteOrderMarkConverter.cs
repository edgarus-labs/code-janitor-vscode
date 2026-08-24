using System;

namespace CodeJanitor.Logic.Transformations;

/// <summary>
/// A source transformation that strips the Unicode Byte Order Mark (BOM / U+FEFF) from the start of a source string.
/// </summary>
public sealed class ByteOrderMarkConverter : ISourceTransformation
{
    /// <summary>
    /// The bom char.
    /// </summary>
    private const char BomChar = '\uFEFF';

    /// <inheritdoc />
    public string Name => "Remove Byte Order Mark (BOM)";

    /// <inheritdoc />
    public string Apply(string source)
    {
        if (string.IsNullOrEmpty(source))
        {
            return source;
        }

        if (source[0] == BomChar)
        {
            return source.Substring(1);
        }

        return source;
    }
}
