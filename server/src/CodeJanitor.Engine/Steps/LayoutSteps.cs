using System.Text;
using CodeJanitor.Engine.Contracts;
using CodeJanitor.Engine.Steps.Transformations;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;

namespace CodeJanitor.Engine.Steps;

/// <summary>
/// Removes the byte order mark (the document's encoding loses its preamble), or with <c>charset</c> set gives the file
/// the byte order mark <c>charset</c> asks for (<c>utf-8</c>: none, <c>utf-8-bom</c>: one).
/// </summary>
public sealed class RemoveByteOrderMarkStep : ICleanupStep
{
    public string Name => "Remove byte order mark";

    public string? RuleId => "removeByteOrderMark";

    public CleanupStage Stage => CleanupStage.Text;

    public int Order => 20;

    public bool IsEnabled(IEffectiveSettings settings) => StepSettings.EditorConfig(settings, "charset") switch
    {
        "utf-8" or "utf-8-bom" => true,
        null => settings.GetBool("removeByteOrderMark"),
        _ => false,
    };

    public async Task<Solution> ApplyAsync(Document document, IEffectiveSettings settings, CancellationToken cancellationToken)
    {
        var withBom = StepSettings.EditorConfig(settings, "charset") == "utf-8-bom";
        var text = await document.GetTextAsync(cancellationToken).ConfigureAwait(false);
        var source = text.ToString();
        var hasBomChar = source.Length > 0 && source[0] == '\uFEFF';
        var hasPreamble = text.Encoding is not null && text.Encoding.GetPreamble().Length > 0;
        if (!hasBomChar && hasPreamble == withBom && (text.Encoding is not null || !withBom))
        {
            return document.Project.Solution;
        }

        var content = hasBomChar ? source[1..] : source;

        return document.WithText(SourceText.From(content, new UTF8Encoding(withBom), text.ChecksumAlgorithm)).Project.Solution;
    }
}

/// <summary>Converts the indentation to the <c>indent_style</c> of <c>.editorconfig</c> (tabs or spaces).</summary>
public sealed class IndentationStyleStep : SourceTextStep
{
    public override string Name => "Convert indentation (indent_style)";

    public override string? RuleId => "indent_style";

    public override CleanupStage Stage => CleanupStage.Final;

    public override int Order => 10;

    public override bool IsEnabled(IEffectiveSettings settings) => StepSettings.EditorConfig(settings, "indent_style") is "space" or "tab";

    protected override string Transform(string source, Document document, IEffectiveSettings settings) => StepSettings.EditorConfig(settings, "indent_style") switch
    {
        "space" => new TabToSpaceConverter(StepSettings.TabSize(settings)).Apply(source),
        "tab" => new SpaceToTabConverter(StepSettings.TabSize(settings)).Apply(source),
        _ => source,
    };
}

/// <summary>Removes the whitespace at the end of lines (<c>trim_trailing_whitespace</c>, else the setting).</summary>
public sealed class RemoveEndOfLineWhitespaceStep : SourceTextStep
{
    public override string Name => "Remove end of line whitespace";

    public override string? RuleId => "removeEndOfLineWhitespace";

    public override CleanupStage Stage => CleanupStage.Final;

    public override int Order => 20;

    public override bool IsEnabled(IEffectiveSettings settings) => StepSettings.TrimTrailingWhitespace(settings);

    protected override string Transform(string source, Document document, IEffectiveSettings settings) => new RemoveTrailingWhitespaceConverter().Apply(source);
}

/// <summary>Removes the blank lines at the start of the file.</summary>
public sealed class RemoveBlankLinesAtTopStep : SourceTextStep
{
    public override string Name => "Remove blank lines at top";

    public override string? RuleId => "removeBlankLinesAtTop";

    public override CleanupStage Stage => CleanupStage.Final;

    public override int Order => 30;

    protected override string Transform(string source, Document document, IEffectiveSettings settings) => FileHeaderAndBlankLines.RemoveBlankLinesAtTop(source);
}

/// <summary>Removes the blank lines at the end of the file, keeping the final newline unless <c>insert_final_newline = false</c>.</summary>
public sealed class RemoveBlankLinesAtBottomStep : SourceTextStep
{
    public override string Name => "Remove blank lines at bottom";

    public override string? RuleId => "removeBlankLinesAtBottom";

    public override CleanupStage Stage => CleanupStage.Final;

    public override int Order => 40;

    protected override string Transform(string source, Document document, IEffectiveSettings settings) =>
        FileHeaderAndBlankLines.RemoveBlankLinesAtBottom(source, StepSettings.InsertFinalNewline(settings));
}

/// <summary>Removes the blank lines between an attribute and its target.</summary>
public sealed class RemoveBlankLinesAfterAttributesStep : SourceTextStep
{
    public override string Name => "Remove blank lines after attributes";

    public override string? RuleId => "removeBlankLinesAfterAttributes";

    public override CleanupStage Stage => CleanupStage.Final;

    public override int Order => 50;

    protected override string Transform(string source, Document document, IEffectiveSettings settings) => FileHeaderAndBlankLines.RemoveBlankLinesAfterAttributes(source);
}

/// <summary>Removes the blank lines between a documentation comment and its declaration; always on.</summary>
public sealed class RemoveBlankLinesAfterDocumentationCommentsStep : SourceTextStep
{
    public override string Name => "Remove blank lines after documentation comments";

    public override string? RuleId => null;

    public override CleanupStage Stage => CleanupStage.Final;

    public override int Order => 55;

    public override bool IsEnabled(IEffectiveSettings settings) => true;

    protected override string Transform(string source, Document document, IEffectiveSettings settings) => FileHeaderAndBlankLines.RemoveBlankLinesAfterDocumentationComments(source);
}

/// <summary>Removes the blank lines after an opening brace.</summary>
public sealed class RemoveBlankLinesAfterOpeningBraceStep : SourceTextStep
{
    public override string Name => "Remove blank lines after opening brace";

    public override string? RuleId => "removeBlankLinesAfterOpeningBrace";

    public override CleanupStage Stage => CleanupStage.Final;

    public override int Order => 60;

    protected override string Transform(string source, Document document, IEffectiveSettings settings) => FileHeaderAndBlankLines.RemoveBlankLinesAfterOpeningBrace(source);
}

/// <summary>Removes the blank lines before a closing brace.</summary>
public sealed class RemoveBlankLinesBeforeClosingBraceStep : SourceTextStep
{
    public override string Name => "Remove blank lines before closing brace";

    public override string? RuleId => "removeBlankLinesBeforeClosingBrace";

    public override CleanupStage Stage => CleanupStage.Final;

    public override int Order => 70;

    protected override string Transform(string source, Document document, IEffectiveSettings settings) => FileHeaderAndBlankLines.RemoveBlankLinesBeforeClosingBrace(source);
}

/// <summary>Removes the blank lines before <c>else</c>, <c>catch</c> and <c>finally</c>.</summary>
public sealed class RemoveBlankLinesBetweenChainedStatementsStep : SourceTextStep
{
    public override string Name => "Remove blank lines between chained statements";

    public override string? RuleId => "removeBlankLinesBetweenChainedStatements";

    public override CleanupStage Stage => CleanupStage.Final;

    public override int Order => 80;

    protected override string Transform(string source, Document document, IEffectiveSettings settings) => FileHeaderAndBlankLines.RemoveBlankLinesBetweenChainedStatements(source);
}

/// <summary>Ends the file with exactly one line break, or none with <c>insert_final_newline = false</c>.</summary>
public sealed class FinalNewlineStep : SourceTextStep
{
    public override string Name => "Final newline (insert_final_newline)";

    public override string? RuleId => "insert_final_newline";

    public override CleanupStage Stage => CleanupStage.Final;

    public override int Order => 90;

    public override bool IsEnabled(IEffectiveSettings settings) => true;

    protected override string Transform(string source, Document document, IEffectiveSettings settings) => StepSettings.InsertFinalNewline(settings)
        ? new EnsureFinalNewlineConverter().Apply(source)
        : new RemoveFinalNewlineConverter().Apply(source);
}

/// <summary>Converts every line break to the <c>end_of_line</c> of <c>.editorconfig</c> (<c>lf</c>, <c>crlf</c>, <c>cr</c>).</summary>
public sealed class EndOfLineStep : SourceTextStep
{
    public override string Name => "Line endings (end_of_line)";

    public override string? RuleId => "end_of_line";

    public override CleanupStage Stage => CleanupStage.Final;

    public override int Order => 95;

    public override bool IsEnabled(IEffectiveSettings settings) => StepSettings.EditorConfig(settings, "end_of_line") is "lf" or "crlf" or "cr";

    protected override string Transform(string source, Document document, IEffectiveSettings settings)
    {
        var newline = StepSettings.EditorConfig(settings, "end_of_line") switch
        {
            "crlf" => "\r\n",
            "cr" => "\r",
            _ => "\n",
        };

        return System.Text.RegularExpressions.Regex.Replace(source, "\r\n|\r|\n", newline);
    }
}
