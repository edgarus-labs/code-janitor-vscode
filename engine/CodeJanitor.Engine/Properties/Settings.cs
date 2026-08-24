namespace CodeJanitor.Properties;

/// <summary>
/// Compatible shim for the Visual Studio extension's generated `Settings.Default` singleton.
/// Ported converters read flags from here unchanged; the engine CLI populates these fields
/// from the JSON request sent by the VS Code extension before running the pipeline.
/// Defaults mirror CodeJanitorShared/Properties/Settings.settings.
/// </summary>
public sealed class Settings
{
    public static Settings Default { get; } = new Settings();

    // Blank line padding (before/after), defaults True except the few noted False in source.
    public bool Cleaning_InsertBlankLinePaddingBeforeClasses = true;
    public bool Cleaning_InsertBlankLinePaddingAfterClasses = true;
    public bool Cleaning_InsertBlankLinePaddingBeforeDelegates = true;
    public bool Cleaning_InsertBlankLinePaddingAfterDelegates = true;
    public bool Cleaning_InsertBlankLinePaddingBeforeEnumerations = true;
    public bool Cleaning_InsertBlankLinePaddingAfterEnumerations = true;
    public bool Cleaning_InsertBlankLinePaddingBeforeEvents = true;
    public bool Cleaning_InsertBlankLinePaddingAfterEvents = true;
    public bool Cleaning_InsertBlankLinePaddingBeforeFieldsMultiLine = true;
    public bool Cleaning_InsertBlankLinePaddingAfterFieldsMultiLine = true;
    public bool Cleaning_InsertBlankLinePaddingBeforeFieldsSingleLine = false;
    public bool Cleaning_InsertBlankLinePaddingAfterFieldsSingleLine = false;
    public bool Cleaning_InsertBlankLinePaddingBeforeInterfaces = true;
    public bool Cleaning_InsertBlankLinePaddingAfterInterfaces = true;
    public bool Cleaning_InsertBlankLinePaddingBeforeMethods = true;
    public bool Cleaning_InsertBlankLinePaddingAfterMethods = true;
    public bool Cleaning_InsertBlankLinePaddingBeforeNamespaces = true;
    public bool Cleaning_InsertBlankLinePaddingAfterNamespaces = true;
    public bool Cleaning_InsertBlankLinePaddingBeforePropertiesMultiLine = true;
    public bool Cleaning_InsertBlankLinePaddingAfterPropertiesMultiLine = true;
    public bool Cleaning_InsertBlankLinePaddingBeforePropertiesSingleLine = false;
    public bool Cleaning_InsertBlankLinePaddingAfterPropertiesSingleLine = false;
    public bool Cleaning_InsertBlankLinePaddingBeforeStructs = true;
    public bool Cleaning_InsertBlankLinePaddingAfterStructs = true;
    public bool Cleaning_InsertBlankLinePaddingBeforeRegionTags = true;
    public bool Cleaning_InsertBlankLinePaddingAfterRegionTags = true;
    public bool Cleaning_InsertBlankLinePaddingBeforeEndRegionTags = true;
    public bool Cleaning_InsertBlankLinePaddingAfterEndRegionTags = true;
    public bool Cleaning_InsertBlankLinePaddingBeforeUsingStatementBlocks = true;
    public bool Cleaning_InsertBlankLinePaddingAfterUsingStatementBlocks = true;
    public bool Cleaning_InsertBlankLinePaddingBeforeCaseStatements = true;
    public bool Cleaning_InsertBlankLinePaddingBeforeSingleLineComments = false;

    // Explicit access modifiers, default True per-kind.
    public bool Cleaning_InsertExplicitAccessModifiersOnClasses = true;
    public bool Cleaning_InsertExplicitAccessModifiersOnDelegates = true;
    public bool Cleaning_InsertExplicitAccessModifiersOnEnumerations = true;
    public bool Cleaning_InsertExplicitAccessModifiersOnEvents = true;
    public bool Cleaning_InsertExplicitAccessModifiersOnFields = true;
    public bool Cleaning_InsertExplicitAccessModifiersOnInterfaces = true;
    public bool Cleaning_InsertExplicitAccessModifiersOnMethods = true;
    public bool Cleaning_InsertExplicitAccessModifiersOnProperties = true;
    public bool Cleaning_InsertExplicitAccessModifiersOnStructs = true;

    // Roslyn-safe modernization transforms, opt-in (default False) per ADR-0007.
    public bool Cleaning_ConvertToFileScopedNamespace = false;
    public bool Cleaning_ConvertToVarWhenApparent = false;
    public bool Cleaning_MakeFieldsReadonlyWhenSafe = false;
    public bool Cleaning_SealClassesWhenSafe = false;
    public bool Cleaning_InsertBlankLineBeforeReturnAndThrowStatements = false;
    public bool Cleaning_ConvertToCollectionExpressions = false;
    public bool Cleaning_ReuseJsonSerializerOptionsForCA1869 = false;
    public bool Cleaning_SimplifySingleStatementLambdas = false;

    // Enabled-by-default safe conversions.
    public bool Cleaning_ConvertToPatternMatchingNullChecks = true;
    public bool Cleaning_ConvertStringFormatToInterpolation = true;
    public bool Cleaning_ConvertToStringNameOf = true;
    public bool Cleaning_InlineOutVariableDeclarations = true;

    public bool Cleaning_MoveUsingsOutsideNamespace = true;
    public bool Cleaning_OrganizeUsings = false;

    public bool Cleaning_UpdateEndRegionDirectives = true;
    public bool Cleaning_UpdateSingleLineMethods = true;
    public bool Cleaning_UpdateAccessorsToBothBeSingleLineOrMultiLine = false;

    public bool Formatting_CommentRunDuringCleanup = false;

    public bool Cleaning_RemoveByteOrderMark = true;
    public bool Cleaning_RemoveEndOfLineWhitespace = true;
    public bool Cleaning_RemoveBlankLinesAtTop = true;
    public bool Cleaning_RemoveBlankLinesAtBottom = true;
    public bool Cleaning_RemoveBlankLinesAfterAttributes = true;
    public bool Cleaning_RemoveBlankLinesAfterOpeningBrace = true;
    public bool Cleaning_RemoveBlankLinesBeforeClosingBrace = true;
    public bool Cleaning_RemoveBlankLinesBetweenChainedStatements = true;
    public bool Cleaning_RemoveMultipleConsecutiveBlankLines = true;

    // File header (0 = DocumentStart/Insert, 1 = AfterUsings/Replace).
    public string Cleaning_UpdateFileHeaderCSharp = string.Empty;
    public int Cleaning_UpdateFileHeader_HeaderPosition = 0;
    public int Cleaning_UpdateFileHeader_HeaderUpdateMode = 0;
}
