#nullable disable
using System;
using System.Collections.Generic;

namespace CodeJanitor.Engine.Comments.Options;

/// <summary>
/// Represents XML formatter configuration options, providing tag-specific formatting settings such as split-before/after overrides and parameter tag alignment, with the ability to retrieve options for individual tags and populate from application settings.
/// </summary>
internal sealed class FormatterOptionsXml
{
    private static readonly FormatterOptionsXmlTag FormatterOptionsXmlTagOverrideSplitBeforeAfter = new FormatterOptionsXmlTag
    {
        Split = XmlTagNewLine.BeforeAndAfter
    };

    public FormatterOptionsXml()
    {
        Tags = new Dictionary<string, FormatterOptionsXmlTag>(StringComparer.OrdinalIgnoreCase);
        Default = new XmlTagOptions();
    }

    /// <summary>
    /// Whether `param` tags should be all made the same length.
    /// </summary>
    public bool AlignParamTags { get; set; }

    /// <summary>
    /// Gets or sets the default.
    /// </summary>
    public XmlTagOptions Default { get; set; }

    /// <summary>
    /// Settings for individual tags.
    /// </summary>
    public Dictionary<string, FormatterOptionsXmlTag> Tags { get; set; }

    /// <summary>
    /// Returns the default options if the tag name is not found, otherwise creates and returns a new XmlTagOptions instance combining the tag-specific settings with the default options, without modifying any state or throwing exceptions.
    /// </summary>
    /// <param name="tagName">The tag name.</param>
    /// <returns>A IXmlTagOptions value produced by this method.</returns>
    public IXmlTagOptions GetTagOptions(string tagName) => !Tags.TryGetValue(tagName, out var tag) ? Default : new XmlTagOptions(tag, Default);

    /// <summary>
    /// Converts a Settings object into a FormatterOptionsXml instance, configuring XML doc comment formatting rules for tags such as summary, code, and list elements, with no side effects.
    /// </summary>
    /// <param name="settings">The settings.</param>
    /// <returns>A FormatterOptionsXml value produced by this method.</returns>
    internal static FormatterOptionsXml FromSettings(CommentFormatSettings settings) => new FormatterOptionsXml
    {
        AlignParamTags = settings.XmlAlignParamTags,
        Default = XmlTagOptions.FromSettings(settings),
        Tags = new Dictionary<string, FormatterOptionsXmlTag>(StringComparer.OrdinalIgnoreCase)
        {
            ["summary"] = new FormatterOptionsXmlTag { Split = settings.XmlSplitSummaryTagToMultipleLines ? XmlTagNewLine.Always : XmlTagNewLine.Default },
            ["copyright"] = new FormatterOptionsXmlTag { Split = XmlTagNewLine.Always, Indent = CodeCommentHelper.CopyrightExtraIndent },
            ["code"] = new FormatterOptionsXmlTag { Split = XmlTagNewLine.BeforeAndAfter, Literal = true },
            ["p"] = FormatterOptionsXmlTagOverrideSplitBeforeAfter,
            ["para"] = FormatterOptionsXmlTagOverrideSplitBeforeAfter,
            ["list"] = FormatterOptionsXmlTagOverrideSplitBeforeAfter,
            ["listheader"] = FormatterOptionsXmlTagOverrideSplitBeforeAfter,
            ["item"] = FormatterOptionsXmlTagOverrideSplitBeforeAfter,
            ["term"] = FormatterOptionsXmlTagOverrideSplitBeforeAfter,
            ["description"] = FormatterOptionsXmlTagOverrideSplitBeforeAfter,
        }
    };
};
