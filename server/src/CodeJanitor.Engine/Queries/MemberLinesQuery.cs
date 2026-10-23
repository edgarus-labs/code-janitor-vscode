using System.Text.Json.Nodes;
using CodeJanitor.Engine.Commands;
using CodeJanitor.Engine.Contracts;
using Microsoft.CodeAnalysis;

namespace CodeJanitor.Engine.Queries;

/// <summary>
/// <c>memberLines</c>: the whole lines a member owns, what Spade's Insert Region puts in the region. Arguments:
/// <c>{ line, name }</c> as the <c>structure</c> query gives them. Result: <c>{ "startLine": int, "endLine": int }</c>,
/// 0-based and inclusive, from the comments directly above the member (see <see cref="MemberBlocks" />) to its last
/// line; null when there is no such member or it shares its lines with other code.
/// </summary>
public sealed class MemberLinesQuery : IDocumentQuery
{
    public string Name => "memberLines";

    public async Task<JsonNode?> QueryAsync(Document document, IEffectiveSettings settings, JsonObject? arguments, CancellationToken cancellationToken)
    {
        var root = await document.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false);
        var text = await document.GetTextAsync(cancellationToken).ConfigureAwait(false);
        var line = CommandArguments.Int(arguments, "line") ?? -1;
        var member = root is null ? null : MemberBlocks.TryFind(root, text, line, MemberBlocks.Name(arguments, "name"));

        return member is not null && MemberBlocks.OwnedLines(member, text) is { } lines
            ? new JsonObject { ["startLine"] = lines.First, ["endLine"] = lines.Last }
            : null;
    }
}
