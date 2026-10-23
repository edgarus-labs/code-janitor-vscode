#nullable disable
namespace CodeJanitor.Engine.Comments.Options;

/// <summary>
/// Defines formatting and layout options for controlling the rendering of XML tags, including casing, indentation, line splitting, spacing of content and self-closing elements, and whether tags are kept together or output literally.
/// </summary>
internal interface IXmlTagOptions
{
    XmlTagCase Case { get; }

    int Indent { get; }

    bool KeepTogether { get; }

    bool Literal { get; }

    bool SpaceContent { get; }

    bool SpaceSelfClosing { get; }

    XmlTagNewLine Split { get; }
}
