#nullable disable
namespace CodeJanitor.Engine.Comments.Options;

/// <summary>
/// Represents the available XML formatting options that control how XML output is structured, including casing, indentation, element grouping, spacing, and splitting behavior.
/// </summary>
internal sealed class FormatterOptionsXmlTag
{
    /// <summary>
    /// If not <see cref="XmlTagCase.Default"/>, overrides the default tag case setting.
    /// </summary>
    public XmlTagCase Case { get; set; }

    /// <summary>
    /// If not <c>null</c>, overrides the default tag indentation.
    /// </summary>
    public int? Indent { get; set; }

    /// <summary>
    /// Gets or sets the keep together.
    /// </summary>
    public bool? KeepTogether { get; set; }

    /// <summary>
    /// Whether the content should be kept literally and not formatted.
    /// </summary>
    public bool? Literal { get; set; }

    /// <summary>
    /// Gets or sets the space content.
    /// </summary>
    public bool? SpaceContent { get; set; }

    /// <summary>
    /// Gets or sets the space self closing.
    /// </summary>
    public bool? SpaceSelfClosing { get; set; }

    /// <summary>
    /// If not <see cref="XmlTagNewLine.Default"/>, overrides the default tag split setting.
    /// </summary>
    public XmlTagNewLine Split { get; set; }
}
