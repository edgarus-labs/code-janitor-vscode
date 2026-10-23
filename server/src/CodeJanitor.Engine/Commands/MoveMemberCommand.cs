using System.Text.Json.Nodes;
using CodeJanitor.Engine.Contracts;
using CodeJanitor.Engine.Diagnostics;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace CodeJanitor.Engine.Commands;

/// <summary>
/// <c>moveMember</c>, Spade's drag and drop: moves a member before or after a sibling (a member of the same type, enum
/// or namespace). Arguments: <c>{ line, name, targetLine, targetName, position: "before" | "after" }</c>, the lines
/// 0-based as the <c>structure</c> query gives them. The member takes its documentation, comments and attributes
/// along (see <see cref="MemberBlocks" />) and keeps its blank-line separation; an enum member keeps the commas in
/// place. Fails (a JSON-RPC error with the message) when a member is not found, the two have different parents, a
/// member shares its lines with other code, or the move would add a compiler error to the project.
/// </summary>
public sealed class MoveMemberCommand : IDocumentCommand
{
    public string Name => "moveMember";

    public async Task<Solution> ExecuteAsync(Document document, IEffectiveSettings settings, JsonObject? arguments, CancellationToken cancellationToken)
    {
        var root = await document.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false) ?? throw new InvalidOperationException("The document has no syntax tree.");
        var text = await document.GetTextAsync(cancellationToken).ConfigureAwait(false);
        var (name, targetName) = (MemberBlocks.Name(arguments, "name"), MemberBlocks.Name(arguments, "targetName"));
        var member = MemberBlocks.Find(root, text, CommandArguments.Int(arguments, "line") ?? -1, name);
        var target = MemberBlocks.Find(root, text, CommandArguments.Int(arguments, "targetLine") ?? -1, targetName);
        var before = !string.Equals(MemberBlocks.Name(arguments, "position"), "after", StringComparison.Ordinal);
        name = MemberBlocks.NameOf(member, name);
        targetName = MemberBlocks.NameOf(target, targetName);
        if (member == target)
        {
            return document.Project.Solution;
        }

        if (member.Parent != target.Parent)
        {
            throw new InvalidOperationException($"'{name}' and '{targetName}' are not members of the same parent.");
        }

        var moved = member is EnumMemberDeclarationSyntax enumMember
            ? MoveEnumMember((EnumDeclarationSyntax)enumMember.Parent!, enumMember, (EnumMemberDeclarationSyntax)target, before).ToFullString()
            : MoveLines(text, member, name, target, targetName, before);
        var after = document.WithText(SourceText.From(moved, text.Encoding, text.ChecksumAlgorithm));

        var beforeErrors = await CompilerErrors.GetAsync(document.Project, cancellationToken).ConfigureAwait(false);
        var afterErrors = await CompilerErrors.GetAsync(after.Project, cancellationToken).ConfigureAwait(false);
        if (await CompilerErrors.FindFirstNewAsync(document.Project, beforeErrors, after.Project, afterErrors, cancellationToken).ConfigureAwait(false) is { } error)
        {
            throw new InvalidOperationException($"Moving '{name}' would add the compiler error {error.Id}: {error.GetMessage(System.Globalization.CultureInfo.InvariantCulture)}");
        }

        return after.Project.Solution;
    }

    private static string MoveLines(SourceText text, SyntaxNode member, string name, SyntaxNode target, string targetName, bool before)
    {
        var lines = MemberBlocks.OwnedLines(member, text) ?? throw SharesItsLines(name);
        var targetLines = MemberBlocks.OwnedLines(target, text) ?? throw SharesItsLines(targetName);

        return new LineBlocks(text).Move(lines.First, lines.Last, before ? targetLines.First : targetLines.Last, before);
    }

    private static InvalidOperationException SharesItsLines(string name) =>
        new($"'{name}' shares its lines with other code; Spade moves whole lines.");

    /// <summary>The enum with the member moved; each position keeps its trailing trivia, so the commas and line breaks stay.</summary>
    private static SyntaxNode MoveEnumMember(EnumDeclarationSyntax @enum, EnumMemberDeclarationSyntax member, EnumMemberDeclarationSyntax target, bool before)
    {
        var original = @enum.Members;
        var order = original.Where(candidate => candidate != member).ToList();
        order.Insert(order.IndexOf(target) + (before ? 0 : 1), member);
        var members = order.Select((moved, index) => moved.WithTrailingTrivia(original[index].GetTrailingTrivia()));
        var updated = @enum.WithMembers(SyntaxFactory.SeparatedList(members, original.GetSeparators()));

        return @enum.SyntaxTree.GetRoot().ReplaceNode(@enum, updated);
    }
}
