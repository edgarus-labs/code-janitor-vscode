using System.Text.Json.Nodes;
using CodeJanitor.Engine.Contracts;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;

namespace CodeJanitor.Engine.Reorganize;

/// <summary>Reads the reorganize settings of a request: the <c>reorganize</c> setting, with the arguments' preprocessor policy over it.</summary>
internal static class ReorganizeRequest
{
    public static ReorganizeSettings SettingsOf(IEffectiveSettings settings, JsonObject? arguments)
    {
        var parsed = ReorganizeSettings.Parse(settings.GetNode("reorganize"));
        var policy = ReorganizeSettings.ParsePolicy(arguments?["performWhenPreprocessorConditionals"]);

        return policy is { } value ? parsed with { PerformWhenPreprocessorConditionals = value } : parsed;
    }

    public static async Task<Solution> ApplyAsync(Document document, ReorganizeSettings reorganize, IEffectiveSettings settings, CancellationToken cancellationToken)
    {
        var result = await Reorganizer.ReorganizeAsync(document, reorganize, ReorganizeCleanup.From(settings), cancellationToken).ConfigureAwait(false);
        var text = await document.GetTextAsync(cancellationToken).ConfigureAwait(false);
        if (result.Output == text.ToString())
        {
            return document.Project.Solution;
        }

        return document.WithText(SourceText.From(result.Output, text.Encoding, text.ChecksumAlgorithm)).Project.Solution;
    }
}

/// <summary>
/// The <c>reorganize</c> command. Arguments: <c>{ performWhenPreprocessorConditionals?: "yes" | "no" | "ask" }</c>
/// overrides the setting (the extension asks the user and runs it again with <c>"yes"</c>); the <c>reorganizeReport</c>
/// query tells what the command would skip.
/// </summary>
public sealed class ReorganizeCommand : IDocumentCommand
{
    public string Name => "reorganize";

    public Task<Solution> ExecuteAsync(Document document, IEffectiveSettings settings, JsonObject? arguments, CancellationToken cancellationToken) =>
        ReorganizeRequest.ApplyAsync(document, ReorganizeRequest.SettingsOf(settings, arguments), settings, cancellationToken);
}

/// <summary>
/// Reorganizes the members first in a cleanup when <c>reorganize.runAtStartOfCleanup</c> is on. A step cannot ask the
/// user, so a file with preprocessor conditionals is only reorganized when the policy is <c>yes</c>.
/// </summary>
public sealed class ReorganizeStep : ICleanupStep
{
    public string Name => "Reorganize members";

    public string? RuleId => null;

    public CleanupStage Stage => CleanupStage.Reorganize;

    public int Order => 0;

    public bool IsEnabled(IEffectiveSettings settings) => ReorganizeSettings.Parse(settings.GetNode("reorganize")).RunAtStartOfCleanup;

    public Task<Solution> ApplyAsync(Document document, IEffectiveSettings settings, CancellationToken cancellationToken) =>
        ReorganizeRequest.ApplyAsync(document, ReorganizeSettings.Parse(settings.GetNode("reorganize")), settings, cancellationToken);
}
