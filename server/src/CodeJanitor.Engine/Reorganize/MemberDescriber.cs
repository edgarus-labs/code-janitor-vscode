using System.Collections.Immutable;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace CodeJanitor.Engine.Reorganize;

/// <summary>What a container of members is: decides the default access of a member without a modifier.</summary>
public enum ContainerKind
{
    Unit,
    Namespace,
    Class,
    Struct,
    Interface,
}

/// <summary>What the reorganizer knows about one member (a declaration, or a <c>#if</c> block of declarations).</summary>
public sealed record MemberInfo(
    MemberKind Kind,
    string Name,
    AccessLevel Access,
    bool IsStatic,
    bool IsConstant,
    bool IsReadOnly,
    bool IsExplicitInterface,
    bool IsMultiLine,
    bool IsLayoutField,
    InitInfo Init,
    ImmutableHashSet<string> PartialTypes);

/// <summary>The container a member is described in.</summary>
internal sealed record ContainerContext(ContainerKind Kind, bool FieldOrderIsLayout, InitializerAnalyzer Analyzer);

internal static partial class MemberDescriber
{
    /// <summary>The kind of member a declaration is, or null when it is not a reorderable member.</summary>
    public static MemberKind? KindOf(SyntaxNode node) => node switch
    {
        RecordDeclarationSyntax record => record.ClassOrStructKeyword.IsKind(SyntaxKind.StructKeyword) ? MemberKind.Struct : MemberKind.Class,
        ClassDeclarationSyntax => MemberKind.Class,
        StructDeclarationSyntax => MemberKind.Struct,
        InterfaceDeclarationSyntax => MemberKind.Interface,
        EnumDeclarationSyntax => MemberKind.Enum,
        DelegateDeclarationSyntax => MemberKind.Delegate,
        ConstructorDeclarationSyntax => MemberKind.Constructor,
        DestructorDeclarationSyntax => MemberKind.Destructor,
        MethodDeclarationSyntax or OperatorDeclarationSyntax or ConversionOperatorDeclarationSyntax => MemberKind.Method,
        PropertyDeclarationSyntax => MemberKind.Property,
        IndexerDeclarationSyntax => MemberKind.Indexer,
        EventDeclarationSyntax or EventFieldDeclarationSyntax => MemberKind.Event,
        FieldDeclarationSyntax => MemberKind.Field,
        NamespaceDeclarationSyntax => MemberKind.Namespace,
        _ => null,
    };

    public static ContainerKind ContainerKindOf(SyntaxNode node) => KindOf(node) switch
    {
        MemberKind.Struct => ContainerKind.Struct,
        MemberKind.Interface => ContainerKind.Interface,
        MemberKind.Namespace => ContainerKind.Namespace,
        _ => ContainerKind.Class,
    };

    /// <summary>A property whose getter runs code: an expression body or an accessor with a body.</summary>
    public static bool IsComputedProperty(PropertyDeclarationSyntax property) =>
        property.ExpressionBody is not null
        || (property.AccessorList?.Accessors.Any(accessor => accessor.Body is not null || accessor.ExpressionBody is not null) ?? false);

    public static MemberInfo Describe(MemberDeclarationSyntax node, MemberKind kind, ContainerContext context, bool withSemantics = true)
    {
        var modifiers = node.Modifiers;
        var isExplicitInterface = ExplicitSpecifier(node) is not null;
        var isConstant = kind == MemberKind.Field && modifiers.Any(SyntaxKind.ConstKeyword);
        var isStatic = modifiers.Any(SyntaxKind.StaticKeyword) || isConstant;
        var isInitializerHost = (kind == MemberKind.Field && !isConstant) || kind == MemberKind.Property || node is EventFieldDeclarationSyntax;
        var isPartialType = kind is MemberKind.Class or MemberKind.Struct or MemberKind.Interface && modifiers.Any(SyntaxKind.PartialKeyword);
        var name = NameOf(node, kind);
        var hasBackingField = (kind == MemberKind.Field && !isConstant)
            || node is EventFieldDeclarationSyntax
            || (node is PropertyDeclarationSyntax property && (!IsComputedProperty(property) || FieldKeyword().IsMatch(property.ToString())));
        var lines = node.SyntaxTree.GetLineSpan(node.Span);

        return new MemberInfo(
            kind,
            name,
            AccessOf(modifiers, kind, isStatic, isExplicitInterface, context.Kind),
            isStatic,
            isConstant,
            kind == MemberKind.Field && modifiers.Any(SyntaxKind.ReadOnlyKeyword),
            isExplicitInterface,
            lines.EndLinePosition.Line > lines.StartLinePosition.Line,
            context.FieldOrderIsLayout && !isStatic && hasBackingField,
            isInitializerHost ? context.Analyzer.Analyze(node, isStatic, withSemantics) : InitInfo.None,
            isPartialType ? ImmutableHashSet.Create(name) : ImmutableHashSet<string>.Empty);
    }

    private static ExplicitInterfaceSpecifierSyntax? ExplicitSpecifier(MemberDeclarationSyntax node) => node switch
    {
        MethodDeclarationSyntax method => method.ExplicitInterfaceSpecifier,
        BasePropertyDeclarationSyntax property => property.ExplicitInterfaceSpecifier,
        OperatorDeclarationSyntax @operator => @operator.ExplicitInterfaceSpecifier,
        ConversionOperatorDeclarationSyntax conversion => conversion.ExplicitInterfaceSpecifier,
        _ => null,
    };

    private static AccessLevel AccessOf(SyntaxTokenList modifiers, MemberKind kind, bool isStatic, bool isExplicitInterface, ContainerKind container)
    {
        // The Visual Studio code model reports explicit interface implementations and static constructors as public.
        if (isExplicitInterface || (kind == MemberKind.Constructor && isStatic))
        {
            return AccessLevel.Public;
        }

        var isPublic = modifiers.Any(SyntaxKind.PublicKeyword);
        var isProtected = modifiers.Any(SyntaxKind.ProtectedKeyword);
        var isInternal = modifiers.Any(SyntaxKind.InternalKeyword);
        var isPrivate = modifiers.Any(SyntaxKind.PrivateKeyword);

        if (isPublic)
        {
            return AccessLevel.Public;
        }

        if (isProtected && isInternal)
        {
            return AccessLevel.ProtectedInternal;
        }

        if (isPrivate && isProtected)
        {
            return AccessLevel.PrivateProtected;
        }

        if (isProtected)
        {
            return AccessLevel.Protected;
        }

        if (isInternal || modifiers.Any(SyntaxKind.FileKeyword))
        {
            return AccessLevel.Internal;
        }

        if (isPrivate)
        {
            return AccessLevel.Private;
        }

        return container switch
        {
            ContainerKind.Interface => AccessLevel.Public,
            ContainerKind.Unit or ContainerKind.Namespace => AccessLevel.Internal,
            _ => AccessLevel.Private,
        };
    }

    private static string NameOf(MemberDeclarationSyntax node, MemberKind kind) => node switch
    {
        BaseFieldDeclarationSyntax field => field.Declaration.Variables.FirstOrDefault()?.Identifier.ValueText ?? string.Empty,
        IndexerDeclarationSyntax indexer => WithSpecifier(indexer.ExplicitInterfaceSpecifier, "this"),
        OperatorDeclarationSyntax @operator => $"operator {@operator.OperatorToken.Text}",
        ConversionOperatorDeclarationSyntax conversion => $"{conversion.ImplicitOrExplicitKeyword.Text} operator {conversion.Type}",
        DestructorDeclarationSyntax destructor => $"~{destructor.Identifier.ValueText}",
        BaseNamespaceDeclarationSyntax @namespace => @namespace.Name.ToString(),
        MethodDeclarationSyntax method => WithSpecifier(method.ExplicitInterfaceSpecifier, method.Identifier.ValueText),
        PropertyDeclarationSyntax property => WithSpecifier(property.ExplicitInterfaceSpecifier, property.Identifier.ValueText),
        EventDeclarationSyntax @event => WithSpecifier(@event.ExplicitInterfaceSpecifier, @event.Identifier.ValueText),
        BaseTypeDeclarationSyntax type => type.Identifier.ValueText,
        DelegateDeclarationSyntax @delegate => @delegate.Identifier.ValueText,
        ConstructorDeclarationSyntax constructor => constructor.Identifier.ValueText,
        _ => kind.ToString(),
    };

    private static string WithSpecifier(ExplicitInterfaceSpecifierSyntax? specifier, string name) =>
        specifier is null ? name : Whitespace().Replace(specifier.ToString(), string.Empty) + name;

    [GeneratedRegex(@"\bfield\b")]
    private static partial Regex FieldKeyword();

    [GeneratedRegex(@"\s+")]
    private static partial Regex Whitespace();
}
