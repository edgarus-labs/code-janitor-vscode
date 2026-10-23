#nullable disable
using System.Collections.Generic;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;
using CodeJanitor.Engine.Comments.Options;

namespace CodeJanitor.Engine.Comments;

/// <summary>
/// presents a comment line that parses and manages inline XML tags, including their opening/closing structure, options, and child node handling.
/// </summary>
internal sealed class CommentLineXml : CommentLine
{
    private static readonly Regex InterpunctionRegex = new Regex(@"^[^\w]", RegexOptions.Compiled);

    private readonly FormatterOptions _formatterOptions;
    private readonly StringBuilder _innerText;

    public CommentLineXml(XElement xml, FormatterOptions formatterOptions)
        : base(null)
    {
        _formatterOptions = formatterOptions;
        _innerText = new StringBuilder();

        TagName = xml.Name.LocalName;
        TagOptions = _formatterOptions.Xml.GetTagOptions(TagName);

        OpenTag = CreateXmlOpenTag(xml, TagOptions);
        CloseTag = CreateXmlCloseTag(xml, TagOptions);
        IsSelfClosing = CloseTag is null;

        Lines = new List<ICommentLine>();
        ParseChildNodes(xml);
        CloseInnerText(true);
        IsLast = xml.NextNode is null;
    }

    /// <summary>
    /// Gets the close tag.
    /// </summary>
    public string CloseTag { get; }

    /// <summary>
    /// Gets the is self closing.
    /// </summary>
    public bool IsSelfClosing { get; }

    /// <summary>
    /// Gets the lines.
    /// </summary>
    public ICollection<ICommentLine> Lines { get; }

    /// <summary>
    /// Gets or sets the open tag.
    /// </summary>
    public string OpenTag { get; internal set; }

    /// <summary>
    /// Gets the tag name.
    /// </summary>
    public string TagName { get; }

    /// <summary>
    /// Gets the tag options.
    /// </summary>
    public IXmlTagOptions TagOptions { get; }

    /// <summary>
    /// Creates the XML close tag string for an XElement.
    /// </summary>
    /// <param name="element">The element.</param>
    /// <param name="options">The options of the tag.</param>
    /// <returns>
    /// The XML close tag, or <c>null</c> if the element has no value and is a self-closing tag.
    /// </returns>
    private static string CreateXmlCloseTag(XElement element, IXmlTagOptions options)
    {
        if (element.IsEmpty)
        {
            return null;
        }

        return $"</{TagCase(element.Name.LocalName, options.Case)}>";
    }

    /// <summary>
    /// Creates the XML open tag string for an XElement.
    /// </summary>
    /// <param name="element">The element.</param>
    /// <param name="options">The options of the tag.</param>
    /// <returns>The XML open tag. In case of an element without value, the tag is self-closing.</returns>
    private static string CreateXmlOpenTag(XElement element, IXmlTagOptions options)
    {
        var builder = new StringBuilder();
        var name = element.Name.LocalName;

        builder.Append("<");

        builder.Append(TagCase(name, options.Case));

        if (element.HasAttributes)
        {
            foreach (var attr in element.Attributes())
            {
                builder.Append(CodeCommentHelper.Spacer);
                builder.Append(attr);
            }
        }

        if (element.IsEmpty)
        {
            if (options.SpaceSelfClosing)
            {
                builder.Append(CodeCommentHelper.Spacer);
            }

            builder.Append("/");
        }

        builder.Append(">");

        var result = builder.ToString();

        return options.KeepTogether ? CodeCommentHelper.SpaceToFake(result) : result;
    }

    /// <summary>
    /// Determines whether the input string starts with interpunction by checking if it matches InterpunctionRegex, returning true on match and false otherwise, with no side effects.
    /// </summary>
    /// <param name="value">The value.</param>
    /// <returns>A bool value produced by this method.</returns>
    private static bool StartsWithInterpunction(string value) => InterpunctionRegex.IsMatch(value);

    /// <summary>
    /// The text of a text node with only its ampersands and opening angle brackets escaped (a closing angle bracket is
    /// valid as it is); the other kinds of node as they are written.
    /// </summary>
    private static string TextOf(XNode node) => node is XText { NodeType: XmlNodeType.Text } text
        ? text.Value.Replace("&", "&amp;", StringComparison.Ordinal).Replace("<", "&lt;", StringComparison.Ordinal)
        : node.ToString();

    /// <summary>
    /// The XML of a node as it is written, with the text of its text nodes and those of its descendants as
    /// <see cref="TextOf" /> writes it.
    /// </summary>
    private static string LiteralOf(XNode node)
    {
        if (node is not XElement { IsEmpty: false } element)
        {
            return TextOf(node);
        }

        var prefix = element.GetPrefixOfNamespace(element.Name.Namespace);
        var name = string.IsNullOrEmpty(prefix) ? element.Name.LocalName : $"{prefix}:{element.Name.LocalName}";
        var attributes = string.Concat(element.Attributes().Select(attribute => $" {attribute}"));

        return $"<{name}{attributes}>{string.Concat(element.Nodes().Select(LiteralOf))}</{name}>";
    }

    /// <summary>
    /// Returns the tag converted to lowercase or uppercase using invariant culture based on tagCase, or the original tag if no case conversion is requested, with no side effects or exceptions.
    /// </summary>
    /// <param name="tag">The tag.</param>
    /// <param name="tagCase">The tag case.</param>
    /// <returns>A string value produced by this method.</returns>
    private static string TagCase(string tag, XmlTagCase tagCase) => tagCase == XmlTagCase.LowerCase ? tag.ToLowerInvariant() :
            tagCase == XmlTagCase.UpperCase ? tag.ToUpperInvariant() :
            tag;

    /// <summary>
    /// If there is text left in the buffer, parse and append it as a comment line.
    /// </summary>
    private void CloseInnerText(bool isLast)
    {
        if (_innerText.Length > 0)
        {
            Lines.Add(new CommentLine(_innerText.ToString()) { IsLast = isLast });
            _innerText.Clear();
        }
    }

    /// <summary>
    /// Returns true for root-level XML elements or elements whose local name is in a configured special-tags dictionary, indicating they require XML handling, with no side effects or exceptions.
    /// </summary>
    /// <param name="e">The e.</param>
    /// <returns>A bool value produced by this method.</returns>
    private bool NeedsXmlHandling(XElement e)
    {
        // All root level elements are always on their own line.
        if (e.Parent is null || e.Parent.Parent is null)
        {
            return true;
        }

        // Some special tags should also always be their own line.
        if (_formatterOptions.Xml.Tags.ContainsKey(e.Name.LocalName))
        {
            return true;
        }

        return false;
    }

    /// <summary>
    /// Parses an XML element&apos;s children by either reading literal inner XML into `Content` when `TagOptions.Literal` is set, or recursively walking child nodes to append text and tags to `_innerText`, add XML comment lines to `Lines`, and call `CloseInnerText` for handled elements, while trimming and adjusting whitespace based on node context.
    /// </summary>
    /// <param name="xml">The xml.</param>
    private void ParseChildNodes(XElement xml)
    {
        if (TagOptions.Literal)
        {
            // Read content literally and preserve all formatting.
            Content = string.Concat(xml.Nodes().Select(LiteralOf));
        }
        else
        {
            // Loop and parse all child nodes.
            var node = xml.FirstNode;
            while (node is not null)
            {
                // If the node is a sub-element, it needs to be handled seperately.
                if (node.NodeType == XmlNodeType.Element)
                {
                    var element = (XElement)node;

                    if (NeedsXmlHandling(element))
                    {
                        CloseInnerText(false);
                        Lines.Add(new CommentLineXml(element, _formatterOptions));
                    }
                    else
                    {
                        // If the tag is not forced to be on it's own line, append it to the
                        // current content as string.
                        _innerText.Append(CreateXmlOpenTag(element, TagOptions));

                        if (!element.IsEmpty)
                        {
                            if (TagOptions.SpaceContent)
                            {
                                _innerText.Append(CodeCommentHelper.Spacer);
                            }

                            ParseChildNodes(element);

                            _innerText.Append(CreateXmlCloseTag(element, TagOptions));
                        }
                    }
                }
                else
                {
                    // Always trim trailing
                    var value = TextOf(node).TrimEnd(CodeCommentHelper.Spacer);

                    // If the parent is an element, trim the starting spaces.
                    if (node.PreviousNode is null && node.Parent.NodeType == XmlNodeType.Element && !TagOptions.SpaceContent)
                    {
                        value = value.TrimStart(CodeCommentHelper.Spacer);
                    }

                    // If the previous node was an XML element, put a space before the text
                    // unless the first character is interpunction.
                    if (node.PreviousNode is not null && node.PreviousNode.NodeType == XmlNodeType.Element)
                    {
                        if (!StartsWithInterpunction(value))
                        {
                            _innerText.Append(CodeCommentHelper.Spacer);
                        }
                    }

                    _innerText.Append(value);

                    // Add spacing after (almost) each word.
                    if (node.NextNode is not null || node.Parent.NodeType != XmlNodeType.Element || TagOptions.SpaceContent)
                    {
                        _innerText.Append(CodeCommentHelper.Spacer);
                    }
                }

                node = node.NextNode;
            }
        }
    }
}
