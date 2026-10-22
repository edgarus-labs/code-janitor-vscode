using System.Text.Json.Nodes;
using CodeJanitor.Engine.Contracts;

namespace CodeJanitor.Engine.Comments.Options;

/// <summary>
/// The <c>commentFormat</c> settings (the extension's <c>CommentFormatOptions</c>), with its defaults for missing values.
/// </summary>
internal sealed record CommentFormatSettings
{
    public int WrapColumn { get; init; } = 100;

    public bool SkipWrapOnLastWord { get; init; } = true;

    public IReadOnlyList<string> IgnoreLinesStartingWith { get; init; } = ["ReSharper disable ", "ReSharper enable "];

    public bool XmlAlignParamTags { get; init; }

    public bool XmlKeepTagsTogether { get; init; }

    public bool XmlSpaceSingleTags { get; init; }

    public bool XmlSpaceTags { get; init; }

    public bool XmlSplitAllTags { get; init; }

    public bool XmlSplitSummaryTagToMultipleLines { get; init; } = true;

    public bool XmlTagsToLowerCase { get; init; }

    public int XmlValueIndent { get; init; }

    /// <summary>Reads the <c>commentFormat</c> setting; missing or mistyped fields keep their defaults.</summary>
    public static CommentFormatSettings From(IEffectiveSettings settings) => From(settings.GetNode("commentFormat") as JsonObject);

    /// <summary>Reads a <c>commentFormat</c> object; missing or mistyped fields keep their defaults.</summary>
    public static CommentFormatSettings From(JsonObject? node)
    {
        var defaults = new CommentFormatSettings();
        if (node is null)
        {
            return defaults;
        }

        return new CommentFormatSettings
        {
            WrapColumn = Int(node, "wrapColumn") ?? defaults.WrapColumn,
            SkipWrapOnLastWord = Bool(node, "skipWrapOnLastWord") ?? defaults.SkipWrapOnLastWord,
            IgnoreLinesStartingWith = node["ignoreLinesStartingWith"] is JsonArray array
                ? array.Select(item => item is JsonValue value && value.TryGetValue(out string? text) ? text : null).OfType<string>().ToArray()
                : defaults.IgnoreLinesStartingWith,
            XmlAlignParamTags = Bool(node, "xmlAlignParamTags") ?? defaults.XmlAlignParamTags,
            XmlKeepTagsTogether = Bool(node, "xmlKeepTagsTogether") ?? defaults.XmlKeepTagsTogether,
            XmlSpaceSingleTags = Bool(node, "xmlSpaceSingleTags") ?? defaults.XmlSpaceSingleTags,
            XmlSpaceTags = Bool(node, "xmlSpaceTags") ?? defaults.XmlSpaceTags,
            XmlSplitAllTags = Bool(node, "xmlSplitAllTags") ?? defaults.XmlSplitAllTags,
            XmlSplitSummaryTagToMultipleLines = Bool(node, "xmlSplitSummaryTagToMultipleLines") ?? defaults.XmlSplitSummaryTagToMultipleLines,
            XmlTagsToLowerCase = Bool(node, "xmlTagsToLowerCase") ?? defaults.XmlTagsToLowerCase,
            XmlValueIndent = Int(node, "xmlValueIndent") ?? defaults.XmlValueIndent,
        };
    }

    private static bool? Bool(JsonObject node, string key) => node[key] is JsonValue value && value.TryGetValue(out bool result) ? result : null;

    private static int? Int(JsonObject node, string key)
    {
        if (node[key] is not JsonValue value)
        {
            return null;
        }

        if (value.TryGetValue(out int result))
        {
            return result;
        }

        return value.TryGetValue(out double number) ? (int)number : null;
    }
}
