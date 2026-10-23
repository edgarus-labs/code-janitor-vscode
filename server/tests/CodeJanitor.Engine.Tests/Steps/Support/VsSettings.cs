using CodeJanitor.Engine.Comments.Options;

namespace CodeJanitor.Engine.Tests.Steps.Support;

/// <summary>
/// The Visual Studio settings the tests set, per test thread, with the extension's defaults.
/// </summary>
internal sealed class VsSettings
{
    [ThreadStatic]
    private static VsSettings? _default;

    public static VsSettings Default => _default ??= new VsSettings();

    public bool Cleaning_InsertBlankLinePaddingAfterClasses { get; set; } = true;

    public bool Cleaning_InsertBlankLinePaddingAfterDelegates { get; set; } = true;

    public bool Cleaning_InsertBlankLinePaddingAfterEndRegionTags { get; set; } = true;

    public bool Cleaning_InsertBlankLinePaddingAfterEnumerations { get; set; } = true;

    public bool Cleaning_InsertBlankLinePaddingAfterEvents { get; set; } = true;

    public bool Cleaning_InsertBlankLinePaddingAfterFieldsMultiLine { get; set; } = true;

    public bool Cleaning_InsertBlankLinePaddingAfterFieldsSingleLine { get; set; } = false;

    public bool Cleaning_InsertBlankLinePaddingAfterInterfaces { get; set; } = true;

    public bool Cleaning_InsertBlankLinePaddingAfterMethods { get; set; } = true;

    public bool Cleaning_InsertBlankLinePaddingAfterNamespaces { get; set; } = true;

    public bool Cleaning_InsertBlankLinePaddingAfterPropertiesMultiLine { get; set; } = true;

    public bool Cleaning_InsertBlankLinePaddingAfterPropertiesSingleLine { get; set; } = false;

    public bool Cleaning_InsertBlankLinePaddingAfterRegionTags { get; set; } = true;

    public bool Cleaning_InsertBlankLinePaddingAfterStructs { get; set; } = true;

    public bool Cleaning_InsertBlankLinePaddingAfterUsingStatementBlocks { get; set; } = true;

    public bool Cleaning_InsertBlankLinePaddingBeforeCaseStatements { get; set; } = true;

    public bool Cleaning_InsertBlankLinePaddingBeforeClasses { get; set; } = true;

    public bool Cleaning_InsertBlankLinePaddingBeforeDelegates { get; set; } = true;

    public bool Cleaning_InsertBlankLinePaddingBeforeEndRegionTags { get; set; } = true;

    public bool Cleaning_InsertBlankLinePaddingBeforeEnumerations { get; set; } = true;

    public bool Cleaning_InsertBlankLinePaddingBeforeEvents { get; set; } = true;

    public bool Cleaning_InsertBlankLinePaddingBeforeFieldsMultiLine { get; set; } = true;

    public bool Cleaning_InsertBlankLinePaddingBeforeFieldsSingleLine { get; set; } = false;

    public bool Cleaning_InsertBlankLinePaddingBeforeInterfaces { get; set; } = true;

    public bool Cleaning_InsertBlankLinePaddingBeforeMethods { get; set; } = true;

    public bool Cleaning_InsertBlankLinePaddingBeforeNamespaces { get; set; } = true;

    public bool Cleaning_InsertBlankLinePaddingBeforePropertiesMultiLine { get; set; } = true;

    public bool Cleaning_InsertBlankLinePaddingBeforePropertiesSingleLine { get; set; } = false;

    public bool Cleaning_InsertBlankLinePaddingBeforeRegionTags { get; set; } = true;

    public bool Cleaning_InsertBlankLinePaddingBeforeSingleLineComments { get; set; } = false;

    public bool Cleaning_InsertBlankLinePaddingBeforeStructs { get; set; } = true;

    public bool Cleaning_InsertBlankLinePaddingBeforeUsingStatementBlocks { get; set; } = true;

    public bool Cleaning_UpdateAccessorsToBothBeSingleLineOrMultiLine { get; set; } = false;

    public bool Cleaning_UpdateSingleLineMethods { get; set; } = true;

    public bool Formatting_CommentXmlKeepTagsTogether { get; set; } = false;

    public bool Formatting_CommentXmlSpaceSingleTags { get; set; } = false;

    public bool Formatting_CommentXmlSplitAllTags { get; set; } = false;

    public bool Formatting_CommentXmlSplitSummaryTagToMultipleLines { get; set; } = true;

    public int Formatting_CommentXmlValueIndent { get; set; } = 0;

    /// <summary>Gets or sets a boolean setting by its Visual Studio name.</summary>
    public bool this[string name]
    {
        get => (bool)typeof(VsSettings).GetProperty(name)!.GetValue(this)!;
        set => typeof(VsSettings).GetProperty(name)!.SetValue(this, value);
    }

    /// <summary>Restores the defaults.</summary>
    public void Reset() => _default = new VsSettings();

    /// <summary>Whether the setting with the extension key (camelCase) is on.</summary>
    public bool IsEnabled(string key) => key switch
    {
        "insertBlankLinePaddingAfterClasses" => Cleaning_InsertBlankLinePaddingAfterClasses,
        "insertBlankLinePaddingAfterDelegates" => Cleaning_InsertBlankLinePaddingAfterDelegates,
        "insertBlankLinePaddingAfterEndRegionTags" => Cleaning_InsertBlankLinePaddingAfterEndRegionTags,
        "insertBlankLinePaddingAfterEnumerations" => Cleaning_InsertBlankLinePaddingAfterEnumerations,
        "insertBlankLinePaddingAfterEvents" => Cleaning_InsertBlankLinePaddingAfterEvents,
        "insertBlankLinePaddingAfterFieldsMultiLine" => Cleaning_InsertBlankLinePaddingAfterFieldsMultiLine,
        "insertBlankLinePaddingAfterFieldsSingleLine" => Cleaning_InsertBlankLinePaddingAfterFieldsSingleLine,
        "insertBlankLinePaddingAfterInterfaces" => Cleaning_InsertBlankLinePaddingAfterInterfaces,
        "insertBlankLinePaddingAfterMethods" => Cleaning_InsertBlankLinePaddingAfterMethods,
        "insertBlankLinePaddingAfterNamespaces" => Cleaning_InsertBlankLinePaddingAfterNamespaces,
        "insertBlankLinePaddingAfterPropertiesMultiLine" => Cleaning_InsertBlankLinePaddingAfterPropertiesMultiLine,
        "insertBlankLinePaddingAfterPropertiesSingleLine" => Cleaning_InsertBlankLinePaddingAfterPropertiesSingleLine,
        "insertBlankLinePaddingAfterRegionTags" => Cleaning_InsertBlankLinePaddingAfterRegionTags,
        "insertBlankLinePaddingAfterStructs" => Cleaning_InsertBlankLinePaddingAfterStructs,
        "insertBlankLinePaddingAfterUsingStatementBlocks" => Cleaning_InsertBlankLinePaddingAfterUsingStatementBlocks,
        "insertBlankLinePaddingBeforeCaseStatements" => Cleaning_InsertBlankLinePaddingBeforeCaseStatements,
        "insertBlankLinePaddingBeforeClasses" => Cleaning_InsertBlankLinePaddingBeforeClasses,
        "insertBlankLinePaddingBeforeDelegates" => Cleaning_InsertBlankLinePaddingBeforeDelegates,
        "insertBlankLinePaddingBeforeEndRegionTags" => Cleaning_InsertBlankLinePaddingBeforeEndRegionTags,
        "insertBlankLinePaddingBeforeEnumerations" => Cleaning_InsertBlankLinePaddingBeforeEnumerations,
        "insertBlankLinePaddingBeforeEvents" => Cleaning_InsertBlankLinePaddingBeforeEvents,
        "insertBlankLinePaddingBeforeFieldsMultiLine" => Cleaning_InsertBlankLinePaddingBeforeFieldsMultiLine,
        "insertBlankLinePaddingBeforeFieldsSingleLine" => Cleaning_InsertBlankLinePaddingBeforeFieldsSingleLine,
        "insertBlankLinePaddingBeforeInterfaces" => Cleaning_InsertBlankLinePaddingBeforeInterfaces,
        "insertBlankLinePaddingBeforeMethods" => Cleaning_InsertBlankLinePaddingBeforeMethods,
        "insertBlankLinePaddingBeforeNamespaces" => Cleaning_InsertBlankLinePaddingBeforeNamespaces,
        "insertBlankLinePaddingBeforePropertiesMultiLine" => Cleaning_InsertBlankLinePaddingBeforePropertiesMultiLine,
        "insertBlankLinePaddingBeforePropertiesSingleLine" => Cleaning_InsertBlankLinePaddingBeforePropertiesSingleLine,
        "insertBlankLinePaddingBeforeRegionTags" => Cleaning_InsertBlankLinePaddingBeforeRegionTags,
        "insertBlankLinePaddingBeforeSingleLineComments" => Cleaning_InsertBlankLinePaddingBeforeSingleLineComments,
        "insertBlankLinePaddingBeforeStructs" => Cleaning_InsertBlankLinePaddingBeforeStructs,
        "insertBlankLinePaddingBeforeUsingStatementBlocks" => Cleaning_InsertBlankLinePaddingBeforeUsingStatementBlocks,
        "updateAccessorsToBothBeSingleLineOrMultiLine" => Cleaning_UpdateAccessorsToBothBeSingleLineOrMultiLine,
        "updateSingleLineMethods" => Cleaning_UpdateSingleLineMethods,
        _ => false,
    };

    /// <summary>The comment format settings.</summary>
    public CommentFormatSettings CommentFormat => new()
    {
        XmlKeepTagsTogether = Formatting_CommentXmlKeepTagsTogether,
        XmlSpaceSingleTags = Formatting_CommentXmlSpaceSingleTags,
        XmlSplitAllTags = Formatting_CommentXmlSplitAllTags,
        XmlSplitSummaryTagToMultipleLines = Formatting_CommentXmlSplitSummaryTagToMultipleLines,
        XmlValueIndent = Formatting_CommentXmlValueIndent,
    };
}
