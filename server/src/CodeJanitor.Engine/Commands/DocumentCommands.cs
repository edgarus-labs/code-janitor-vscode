using System.Text.Json.Nodes;
using CodeJanitor.Engine.Contracts;
using CodeJanitor.Engine.Steps;
using CodeJanitor.Engine.Steps.Transformations;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;

namespace CodeJanitor.Engine.Commands;

/// <summary>Arguments shared by the document commands.</summary>
internal static class CommandArguments
{
    /// <summary>The 0-based inclusive line range of <c>{ startLine?, endLine? }</c>; nulls for the whole file.</summary>
    public static (int? Start, int? End) LineRange(JsonObject? arguments) => (Int(arguments, "startLine"), Int(arguments, "endLine"));

    public static int? Int(JsonObject? arguments, string key)
    {
        if (arguments?[key] is not JsonValue value)
        {
            return null;
        }

        if (value.TryGetValue(out int number))
        {
            return number;
        }

        return value.TryGetValue(out double real) ? (int)real : null;
    }

    /// <summary>The document with <paramref name="text" />, in the solution; the solution unchanged when the text is.</summary>
    public static async Task<Solution> WithTextAsync(Document document, string text, CancellationToken cancellationToken)
    {
        var current = await document.GetTextAsync(cancellationToken).ConfigureAwait(false);

        return string.Equals(current.ToString(), text, StringComparison.Ordinal)
            ? document.Project.Solution
            : document.WithText(SourceText.From(text, current.Encoding, current.ChecksumAlgorithm)).Project.Solution;
    }
}

/// <summary>Removes every XML documentation comment of the document.</summary>
public sealed class RemoveXmlDocumentationCommand : IDocumentCommand
{
    public string Name => "removeXmlDocumentation";

    public async Task<Solution> ExecuteAsync(Document document, IEffectiveSettings settings, JsonObject? arguments, CancellationToken cancellationToken)
    {
        var text = (await document.GetTextAsync(cancellationToken).ConfigureAwait(false)).ToString();

        return RemoveXmlDocumentationLogic.TryRemoveXmlDocumentation(text, out var updated)
            ? await CommandArguments.WithTextAsync(document, updated, cancellationToken).ConfigureAwait(false)
            : document.Project.Solution;
    }
}

/// <summary>
/// Removes the <c>#region</c>/<c>#endregion</c> directives of the document, or with <c>{ startLine, endLine }</c>
/// (0-based, inclusive) those of the regions lying inside the lines, or with <c>{ line }</c> only the region with a
/// directive on that line (its nested regions stay); with the blank lines next to the removed directives.
/// </summary>
public sealed class RemoveRegionsCommand : IDocumentCommand
{
    public string Name => "removeRegions";

    public async Task<Solution> ExecuteAsync(Document document, IEffectiveSettings settings, JsonObject? arguments, CancellationToken cancellationToken)
    {
        var text = (await document.GetTextAsync(cancellationToken).ConfigureAwait(false)).ToString();
        var (start, end) = CommandArguments.LineRange(arguments);
        var line = CommandArguments.Int(arguments, "line");
        var updated = line is not null
            ? RegionLines.RemoveRegionAt(text, line.Value)
            : start is null && end is null
                ? new RegionDirectiveRemover().Apply(text)
                : RegionLines.RemoveRegionsInLines(text, start ?? 0, end ?? int.MaxValue);

        return await CommandArguments.WithTextAsync(document, updated, cancellationToken).ConfigureAwait(false);
    }
}

/// <summary>
/// Formats the comments starting on the lines <c>{ startLine?, endLine? }</c> (0-based, inclusive; the whole file
/// without them) with the <c>commentFormat</c> settings, whatever <c>formatComments</c> says.
/// </summary>
public sealed class FormatCommentsCommand : IDocumentCommand
{
    public string Name => "formatComments";

    public async Task<Solution> ExecuteAsync(Document document, IEffectiveSettings settings, JsonObject? arguments, CancellationToken cancellationToken)
    {
        var text = (await document.GetTextAsync(cancellationToken).ConfigureAwait(false)).ToString();
        var (start, end) = CommandArguments.LineRange(arguments);

        return await CommandArguments.WithTextAsync(document, FormatCommentsStep.FormatComments(text, settings, start, end), cancellationToken).ConfigureAwait(false);
    }
}
