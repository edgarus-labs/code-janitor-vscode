using System.Text.Json.Nodes;
using CodeJanitor.Engine.Contracts;
using CodeJanitor.Engine.Reorganize;
using Microsoft.CodeAnalysis;

namespace CodeJanitor.Engine.Queries;

/// <summary>
/// <c>reorganizeReport</c>: a dry run of the <c>reorganize</c> command with the same settings and arguments
/// (<c>{ performWhenPreprocessorConditionals?: "yes" | "no" | "ask" }</c>). Result:
/// <code>{ "blockedByPreprocessor": bool, "changed": bool, "skipped": string[] }</code>
/// <c>blockedByPreprocessor</c>: the file has preprocessor conditionals and the policy is not <c>yes</c> (with
/// <c>ask</c> the extension asks the user, then runs the command with <c>"yes"</c>); <c>skipped</c>: the containers
/// left alone, as <c>"&lt;type&gt; (line &lt;n&gt;): skipped because of &lt;reason&gt;"</c>.
/// </summary>
public sealed class ReorganizeReportQuery : IDocumentQuery
{
    public string Name => "reorganizeReport";

    public async Task<JsonNode?> QueryAsync(Document document, IEffectiveSettings settings, JsonObject? arguments, CancellationToken cancellationToken)
    {
        var result = await Reorganizer.ReorganizeAsync(document, ReorganizeRequest.SettingsOf(settings, arguments), ReorganizeCleanup.From(settings), cancellationToken).ConfigureAwait(false);
        var text = await document.GetTextAsync(cancellationToken).ConfigureAwait(false);

        return new JsonObject
        {
            ["blockedByPreprocessor"] = result.BlockedByPreprocessor,
            ["changed"] = result.Output != text.ToString(),
            ["skipped"] = new JsonArray([.. result.Skipped.Select(reason => (JsonNode?)JsonValue.Create(reason))]),
        };
    }
}
