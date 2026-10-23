#nullable disable
namespace CodeJanitor.Engine.Comments.Options;

/// <summary>
/// XmlTagCase is an enumeration that specifies the letter casing convention to apply when writing XML element or attribute tag names.
/// </summary>
internal enum XmlTagCase
{
    /// <summary>
    /// Use formatter default settings.
    /// </summary>
    Default = 0,

    Keep,
    LowerCase,
    UpperCase
}
