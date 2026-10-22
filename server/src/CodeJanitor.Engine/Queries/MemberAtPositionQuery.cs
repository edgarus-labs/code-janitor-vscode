using System.Text.Json.Nodes;
using CodeJanitor.Engine.Contracts;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace CodeJanitor.Engine.Queries;

/// <summary>
/// <c>memberAtPosition</c>: the innermost method, constructor, destructor, operator, property, indexer, event (with
/// accessors) or type around a position, what an AI action on the caret works on. Arguments:
/// <c>{ line, character }</c>, both 0-based. Result, or null outside every member:
/// <code>{ "name": string, "kind": string, "startLine": int, "endLine": int, "text": string, "signature": string }</code>
/// <c>kind</c> is <c>method</c>, <c>constructor</c>, <c>destructor</c>, <c>operator</c>, <c>conversion</c>,
/// <c>property</c>, <c>indexer</c>, <c>event</c>, <c>class</c>, <c>struct</c>, <c>record</c>, <c>interface</c> or
/// <c>enum</c>; the lines are 0-based and inclusive and, like <c>text</c>, take in the XML documentation and the
/// attributes; <c>signature</c> is the declaration up to its body, whitespace collapsed.
/// </summary>
public sealed class MemberAtPositionQuery : IDocumentQuery
{
    public string Name => "memberAtPosition";

    public async Task<JsonNode?> QueryAsync(Document document, IEffectiveSettings settings, JsonObject? arguments, CancellationToken cancellationToken)
    {
        var root = await document.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false);
        var text = await document.GetTextAsync(cancellationToken).ConfigureAwait(false);
        if (root is null || text.Length == 0 || string.IsNullOrWhiteSpace(text.ToString()))
        {
            return null;
        }

        var line = arguments?["line"]?.GetValue<int>() ?? 0;
        var character = arguments?["character"]?.GetValue<int>() ?? 0;
        if (line < 0 || line >= text.Lines.Count)
        {
            return null;
        }

        var lineSpan = text.Lines[line].Span;
        var position = lineSpan.Start + Math.Clamp(character, 0, lineSpan.Length);

        return Find(root, position) is { } member ? Describe(member, text) : null;
    }

    /// <summary>The innermost member whose span (with its documentation) holds the position, end included.</summary>
    internal static MemberDeclarationSyntax? Find(SyntaxNode root, int position)
    {
        MemberDeclarationSyntax? best = null;
        foreach (var member in root.DescendantNodes().OfType<MemberDeclarationSyntax>().Where(IsReported))
        {
            if (Start(member) <= position && position <= member.Span.End && (best is null || Start(member) >= Start(best)))
            {
                best = member;
            }
        }

        return best;
    }

    private static bool IsReported(MemberDeclarationSyntax member) =>
        member is BaseMethodDeclarationSyntax or BasePropertyDeclarationSyntax or BaseTypeDeclarationSyntax;

    /// <summary>The start of the member's XML documentation, or of the member (its attributes included).</summary>
    internal static int Start(MemberDeclarationSyntax member)
    {
        var documentation = member.GetLeadingTrivia().FirstOrDefault(trivia =>
            trivia.IsKind(SyntaxKind.SingleLineDocumentationCommentTrivia) || trivia.IsKind(SyntaxKind.MultiLineDocumentationCommentTrivia));
        if (documentation.IsKind(SyntaxKind.None))
        {
            return member.SpanStart;
        }

        var start = documentation.FullSpan.Start;
        var source = member.SyntaxTree.GetText();
        while (start < member.SpanStart && char.IsWhiteSpace(source[start]))
        {
            start++;
        }

        return start;
    }

    private static JsonObject Describe(MemberDeclarationSyntax member, SourceText text)
    {
        var start = Start(member);

        return new JsonObject
        {
            ["name"] = QuerySyntax.NameOf(member),
            ["kind"] = KindOf(member),
            ["startLine"] = text.Lines.GetLineFromPosition(start).LineNumber,
            ["endLine"] = text.Lines.GetLineFromPosition(member.Span.End).LineNumber,
            ["text"] = text.ToString(TextSpan.FromBounds(start, member.Span.End)),
            ["signature"] = QuerySyntax.Signature(member),
        };
    }

    private static string KindOf(MemberDeclarationSyntax member) => member switch
    {
        MethodDeclarationSyntax => "method",
        ConstructorDeclarationSyntax => "constructor",
        DestructorDeclarationSyntax => "destructor",
        OperatorDeclarationSyntax => "operator",
        ConversionOperatorDeclarationSyntax => "conversion",
        PropertyDeclarationSyntax => "property",
        IndexerDeclarationSyntax => "indexer",
        EventDeclarationSyntax => "event",
        BaseTypeDeclarationSyntax type => QuerySyntax.TypeKind(type),
        _ => "member",
    };
}
