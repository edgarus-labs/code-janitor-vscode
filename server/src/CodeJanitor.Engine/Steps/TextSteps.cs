using CodeJanitor.Engine.Comments;
using CodeJanitor.Engine.Comments.Options;
using CodeJanitor.Engine.Contracts;
using CodeJanitor.Engine.Steps.Transformations;
using Microsoft.CodeAnalysis;

namespace CodeJanitor.Engine.Steps;

/// <summary>Removes the <c>#region</c> and <c>#endregion</c> directive lines.</summary>
public sealed class RemoveRegionsStep : SourceTextStep
{
    public override string Name => "Remove regions";

    public override string? RuleId => "removeRegions";

    public override CleanupStage Stage => CleanupStage.Text;

    public override int Order => 10;

    protected override string Transform(string source, Document document, IEffectiveSettings settings) => new RegionDirectiveRemover().Apply(source);
}

/// <summary>Inserts a blank line before a <c>return</c> or <c>throw</c> that follows other statements of its block.</summary>
public sealed class ReturnThrowBlankLinePaddingStep : SourceTextStep
{
    public override string Name => "Insert blank line before return and throw statements";

    public override string? RuleId => "insertBlankLineBeforeReturnAndThrowStatements";

    public override CleanupStage Stage => CleanupStage.Text;

    public override int Order => 30;

    protected override string Transform(string source, Document document, IEffectiveSettings settings) => new ReturnThrowBlankLinePaddingConverter().Apply(source);
}

/// <summary>Inserts the blank line padding each <c>insertBlankLinePadding*</c> setting asks for.</summary>
public sealed class BlankLinePaddingStep : SourceTextStep
{
    private static readonly string[] Keys =
    [
        "insertBlankLinePaddingBeforeClasses", "insertBlankLinePaddingAfterClasses",
        "insertBlankLinePaddingBeforeDelegates", "insertBlankLinePaddingAfterDelegates",
        "insertBlankLinePaddingBeforeEnumerations", "insertBlankLinePaddingAfterEnumerations",
        "insertBlankLinePaddingBeforeEvents", "insertBlankLinePaddingAfterEvents",
        "insertBlankLinePaddingBeforeFieldsMultiLine", "insertBlankLinePaddingAfterFieldsMultiLine",
        "insertBlankLinePaddingBeforeFieldsSingleLine", "insertBlankLinePaddingAfterFieldsSingleLine",
        "insertBlankLinePaddingBeforeInterfaces", "insertBlankLinePaddingAfterInterfaces",
        "insertBlankLinePaddingBeforeMethods", "insertBlankLinePaddingAfterMethods",
        "insertBlankLinePaddingBeforeNamespaces", "insertBlankLinePaddingAfterNamespaces",
        "insertBlankLinePaddingBeforePropertiesMultiLine", "insertBlankLinePaddingAfterPropertiesMultiLine",
        "insertBlankLinePaddingBeforePropertiesSingleLine", "insertBlankLinePaddingAfterPropertiesSingleLine",
        "insertBlankLinePaddingBeforeStructs", "insertBlankLinePaddingAfterStructs",
        "insertBlankLinePaddingBeforeRegionTags", "insertBlankLinePaddingAfterRegionTags",
        "insertBlankLinePaddingBeforeEndRegionTags", "insertBlankLinePaddingAfterEndRegionTags",
        "insertBlankLinePaddingBeforeUsingStatementBlocks", "insertBlankLinePaddingAfterUsingStatementBlocks",
        "insertBlankLinePaddingBeforeCaseStatements", "insertBlankLinePaddingBeforeSingleLineComments",
        "insertBlankLinePaddingBetweenPropertiesMultiLineAccessors",
    ];

    public override string Name => "Insert blank line padding";

    public override string? RuleId => "insertBlankLinePadding";

    public override CleanupStage Stage => CleanupStage.Text;

    public override int Order => 70;

    public override bool IsEnabled(IEffectiveSettings settings) => Keys.Any(settings.GetBool);

    protected override string Transform(string source, Document document, IEffectiveSettings settings) => new BlankLinePaddingConverter(settings.GetBool).Apply(source);
}

/// <summary>Writes the region name after each <c>#endregion</c>.</summary>
public sealed class UpdateEndRegionDirectivesStep : SourceTextStep
{
    public override string Name => "Update #endregion directives";

    public override string? RuleId => "updateEndRegionDirectives";

    public override CleanupStage Stage => CleanupStage.Text;

    public override int Order => 80;

    protected override string Transform(string source, Document document, IEffectiveSettings settings) => new UpdateEndRegionDirectivesConverter().Apply(source);
}

/// <summary>
/// Spreads a method body whose braces are on one line onto several lines: the opening brace, each statement and the
/// closing brace on their own lines.
/// </summary>
public sealed class UpdateSingleLineMethodsStep : SourceTextStep
{
    public override string Name => "Update single-line methods";

    public override string? RuleId => "updateSingleLineMethods";

    public override CleanupStage Stage => CleanupStage.Text;

    public override int Order => 90;

    protected override string Transform(string source, Document document, IEffectiveSettings settings) => new UpdateSingleLineMethodsConverter(_ => true).Apply(source);
}

/// <summary>Makes both accessors of a property or event single-line, or both multi-line.</summary>
public sealed class UpdateAccessorsToBothBeSingleLineOrMultiLineStep : SourceTextStep
{
    public override string Name => "Update accessors to both be single-line or multi-line";

    public override string? RuleId => "updateAccessorsToBothBeSingleLineOrMultiLine";

    public override CleanupStage Stage => CleanupStage.Text;

    public override int Order => 100;

    protected override string Transform(string source, Document document, IEffectiveSettings settings) => new UpdateAccessorsToBothBeSingleLineOrMultiLineConverter(_ => true).Apply(source);
}

/// <summary>
/// Formats the comments: one space after <c>//</c>, then the wrapping and XML layout of <c>commentFormat</c> (the
/// Visual Studio comment formatter).
/// </summary>
public sealed class FormatCommentsStep : SourceTextStep
{
    public override string Name => "Format comments";

    public override string? RuleId => "formatComments";

    public override CleanupStage Stage => CleanupStage.Text;

    public override int Order => 110;

    protected override string Transform(string source, Document document, IEffectiveSettings settings) => FormatComments(source, settings, null, null);

    /// <summary>
    /// Formats the comments starting on the given lines (0-based, inclusive; null for the whole file) with the
    /// <c>commentFormat</c> settings: spacing after <c>//</c>, then wrapping and XML layout.
    /// </summary>
    internal static string FormatComments(string source, IEffectiveSettings settings, int? startLine, int? endLine)
    {
        var options = FormatterOptions.FromSettings(CommentFormatSettings.From(settings)).Set(o => o.TabSize = StepSettings.TabSize(settings));

        return CodeComment.FormatComments(SpaceComments(source, startLine, endLine), options, startLine, endLine);
    }

    /// <summary>The spacing after <c>//</c>, kept to the given lines (the spacing never adds or removes lines).</summary>
    private static string SpaceComments(string source, int? startLine, int? endLine)
    {
        var spaced = new CommentFormatConverter().Apply(source);
        if ((startLine is null && endLine is null) || string.Equals(spaced, source, StringComparison.Ordinal))
        {
            return spaced;
        }

        var original = source.Split('\n');
        var changed = spaced.Split('\n');
        if (original.Length != changed.Length)
        {
            return source;
        }

        for (var line = Math.Max(0, startLine ?? 0); line <= Math.Min(original.Length - 1, endLine ?? int.MaxValue); line++)
        {
            original[line] = changed[line];
        }

        return string.Join('\n', original);
    }
}

/// <summary>Inserts or replaces the C# file header.</summary>
public sealed class FileHeaderStep : SourceTextStep
{
    public override string Name => "Update C# file header";

    public override string? RuleId => "fileHeaderCSharp";

    public override CleanupStage Stage => CleanupStage.Text;

    public override int Order => 120;

    public override bool IsEnabled(IEffectiveSettings settings) => StepSettings.FileHeader(settings, null) is not null;

    protected override string Transform(string source, Document document, IEffectiveSettings settings)
    {
        var header = StepSettings.FileHeader(settings, document.FilePath);

        return header is null ? source : FileHeaderAndBlankLines.ApplyFileHeader(source, header, StepSettings.FileHeaderPosition(settings), StepSettings.FileHeaderUpdateMode(settings));
    }
}
