using System.Text.Json.Nodes;
using CodeJanitor.Engine.Contracts;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace CodeJanitor.Engine.Commands;

/// <summary>
/// <c>deleteMember</c>, Spade's Delete: with <c>{ line }</c> on a <c>#region</c> directive, removes the region and
/// everything in it; otherwise with <c>{ line, name }</c> (as the <c>structure</c> query gives them) removes the member
/// with its documentation, comments and attributes (see <see cref="MemberBlocks" />), or only the variable
/// <c>name</c> of a field declaring several. A blank line left over next to the removed lines goes with them. A member
/// sharing its lines with other code is removed from the syntax tree instead.
/// </summary>
public sealed class DeleteMemberCommand : IDocumentCommand
{
    public string Name => "deleteMember";

    public async Task<Solution> ExecuteAsync(Document document, IEffectiveSettings settings, JsonObject? arguments, CancellationToken cancellationToken)
    {
        var root = await document.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false) ?? throw new InvalidOperationException("The document has no syntax tree.");
        var text = await document.GetTextAsync(cancellationToken).ConfigureAwait(false);
        var line = CommandArguments.Int(arguments, "line") ?? -1;
        var name = MemberBlocks.Name(arguments, "name");

        if (MemberBlocks.Region(root, text, line) is { } region)
        {
            return await CommandArguments.WithTextAsync(document, new LineBlocks(text).Remove(region.First, region.Last), cancellationToken).ConfigureAwait(false);
        }

        var member = MemberBlocks.Find(root, text, line, name);
        if (member is BaseFieldDeclarationSyntax { Declaration.Variables.Count: > 1 } field)
        {
            var variable = field.Declaration.Variables.First(candidate => name is null || candidate.Identifier.ValueText == name);

            return document.WithSyntaxRoot(root.RemoveNode(variable, SyntaxRemoveOptions.KeepNoTrivia | SyntaxRemoveOptions.KeepUnbalancedDirectives)!).Project.Solution;
        }

        if (MemberBlocks.OwnedLines(member, text) is { } lines)
        {
            return await CommandArguments.WithTextAsync(document, new LineBlocks(text).Remove(lines.First, lines.Last), cancellationToken).ConfigureAwait(false);
        }

        return document.WithSyntaxRoot(root.RemoveNode(member, SyntaxRemoveOptions.KeepNoTrivia | SyntaxRemoveOptions.KeepUnbalancedDirectives)!).Project.Solution;
    }
}
