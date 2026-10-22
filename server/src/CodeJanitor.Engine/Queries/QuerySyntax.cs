using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace CodeJanitor.Engine.Queries;

/// <summary>What the queries read from declarations: names, kinds, signatures, lines and McCabe complexity.</summary>
internal static partial class QuerySyntax
{
    public static string Collapse(string text) => Whitespace().Replace(text, " ").Trim();

    public static int Line(SyntaxTree tree, int position) => tree.GetLineSpan(new TextSpan(position, 0)).StartLinePosition.Line;

    public static int EndLine(SyntaxNode node) => node.SyntaxTree.GetLineSpan(node.Span).EndLinePosition.Line;

    /// <summary>The position of the first token after the attributes: where the modifiers or the keyword start.</summary>
    public static int DeclarationStart(MemberDeclarationSyntax member)
    {
        var first = member.AttributeLists.Count > 0 ? member.AttributeLists[^1].GetLastToken().GetNextToken() : member.GetFirstToken();

        return first.SpanStart;
    }

    /// <summary>The declaration from its modifiers up to its body, accessors, members or initializer, whitespace collapsed.</summary>
    public static string Signature(MemberDeclarationSyntax member)
    {
        var start = DeclarationStart(member);
        var end = SignatureEnd(member);
        var text = member.SyntaxTree.GetText().ToString(TextSpan.FromBounds(start, Math.Max(start, end)));

        return Collapse(text).TrimEnd(';').TrimEnd();
    }

    private static int SignatureEnd(MemberDeclarationSyntax member) => member switch
    {
        BaseMethodDeclarationSyntax method => method.Body?.SpanStart ?? method.ExpressionBody?.SpanStart ?? method.Span.End,
        BasePropertyDeclarationSyntax property => property switch
        {
            PropertyDeclarationSyntax { ExpressionBody: { } arrow } => arrow.SpanStart,
            IndexerDeclarationSyntax { ExpressionBody: { } arrow } => arrow.SpanStart,
            _ => property.AccessorList?.SpanStart ?? property.Span.End,
        },
        BaseTypeDeclarationSyntax type when !type.OpenBraceToken.IsMissing && type.OpenBraceToken.Span.Length > 0 => type.OpenBraceToken.SpanStart,
        BaseFieldDeclarationSyntax field => field.Declaration.Variables.Count > 0 && field.Declaration.Variables[^1] is var last ? last.Initializer?.SpanStart ?? last.Span.End : field.Span.End,
        _ => member.Span.End,
    };

    /// <summary>The body or expression body of a member, trimmed; empty without one.</summary>
    public static string Body(MemberDeclarationSyntax member) => member switch
    {
        BaseMethodDeclarationSyntax method => ((SyntaxNode?)method.Body ?? method.ExpressionBody)?.ToString().Trim() ?? string.Empty,
        _ => string.Empty,
    };

    /// <summary>The name of a declaration as a reader would call it.</summary>
    public static string NameOf(SyntaxNode node) => node switch
    {
        BaseTypeDeclarationSyntax type => type.Identifier.ValueText,
        DelegateDeclarationSyntax @delegate => @delegate.Identifier.ValueText,
        MethodDeclarationSyntax method => method.Identifier.ValueText,
        ConstructorDeclarationSyntax constructor => constructor.Identifier.ValueText,
        DestructorDeclarationSyntax destructor => "~" + destructor.Identifier.ValueText,
        OperatorDeclarationSyntax @operator => "operator " + @operator.OperatorToken.Text,
        ConversionOperatorDeclarationSyntax conversion => $"{conversion.ImplicitOrExplicitKeyword.Text} operator {conversion.Type}",
        PropertyDeclarationSyntax property => property.Identifier.ValueText,
        IndexerDeclarationSyntax => "this[]",
        EventDeclarationSyntax @event => @event.Identifier.ValueText,
        BaseFieldDeclarationSyntax field => field.Declaration.Variables.FirstOrDefault()?.Identifier.ValueText ?? "member",
        EnumMemberDeclarationSyntax enumMember => enumMember.Identifier.ValueText,
        BaseNamespaceDeclarationSyntax @namespace => @namespace.Name.ToString(),
        _ => "member",
    };

    /// <summary>The kind of a type declaration: <c>class</c>, <c>struct</c>, <c>record</c>, <c>interface</c> or <c>enum</c>.</summary>
    public static string TypeKind(BaseTypeDeclarationSyntax type) => type switch
    {
        RecordDeclarationSyntax => "record",
        StructDeclarationSyntax => "struct",
        InterfaceDeclarationSyntax => "interface",
        EnumDeclarationSyntax => "enum",
        _ => "class",
    };

    public static JsonArray Strings(IEnumerable<string> values) => new([.. values.Select(value => (JsonNode?)JsonValue.Create(value))]);

    public static JsonArray Parameters(BaseParameterListSyntax? list) =>
        new([.. (list?.Parameters ?? default).Select(parameter => (JsonNode?)new JsonObject
        {
            ["name"] = parameter.Identifier.ValueText,
            ["type"] = parameter.Type?.ToString() ?? string.Empty,
        })]);

    public static IEnumerable<string> TypeParameters(SyntaxNode node) => node switch
    {
        TypeDeclarationSyntax type => type.TypeParameterList?.Parameters.Select(parameter => parameter.Identifier.ValueText) ?? [],
        MethodDeclarationSyntax method => method.TypeParameterList?.Parameters.Select(parameter => parameter.Identifier.ValueText) ?? [],
        DelegateDeclarationSyntax @delegate => @delegate.TypeParameterList?.Parameters.Select(parameter => parameter.Identifier.ValueText) ?? [],
        _ => [],
    };

    /// <summary>
    /// McCabe complexity the way the Visual Studio extension's <c>CodeElementHelper.CalculateComplexity</c> counts it:
    /// one, plus each <c>if</c>, <c>else</c> (an <c>else if</c> counts once), <c>while</c> (also of <c>do</c>),
    /// <c>for</c>, <c>foreach</c>, <c>switch</c>, <c>case</c>, <c>catch</c>, <c>?:</c>, <c>&amp;&amp;</c> and <c>||</c>.
    /// </summary>
    public static int Complexity(SyntaxNode node) =>
        1 + node.DescendantNodes().Count(descendant => descendant switch
        {
            IfStatementSyntax => true,
            ElseClauseSyntax @else => @else.Statement is not IfStatementSyntax,
            WhileStatementSyntax or DoStatementSyntax or ForStatementSyntax or CommonForEachStatementSyntax => true,
            SwitchStatementSyntax or SwitchExpressionSyntax => true,
            CaseSwitchLabelSyntax or CasePatternSwitchLabelSyntax => true,
            CatchClauseSyntax or ConditionalExpressionSyntax => true,
            BinaryExpressionSyntax binary => binary.IsKind(SyntaxKind.LogicalAndExpression) || binary.IsKind(SyntaxKind.LogicalOrExpression),
            _ => false,
        });

    [GeneratedRegex(@"\s+")]
    private static partial Regex Whitespace();
}
