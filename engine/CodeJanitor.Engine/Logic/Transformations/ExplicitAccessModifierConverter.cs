using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using CodeJanitor.Properties;
using System.Linq;

namespace CodeJanitor.Logic.Transformations;

/// <summary>
/// Inserts the default access modifier on declarations that omit it, governed per-kind by
/// the Cleaning_InsertExplicitAccessModifiersOn* settings. Pure Roslyn; unit-testable without
/// Visual Studio.
/// </summary>

public sealed class ExplicitAccessModifierConverter : ISourceTransformation
{
    /// <summary>
    /// Gets the name.
    /// </summary>
    public string Name => "Explicit Access Modifiers";

    /// <summary>
    /// Parses the input C# source into a syntax tree, applies AccessModifierRewriter to modify access modifiers, and returns the rewritten full source string, or returns the original source unchanged if it is null or empty.
    /// </summary>
    /// <param name="source">The source.</param>
    /// <returns>A string value produced by this method.</returns>

    public string Apply(string source)
    {
        if (string.IsNullOrEmpty(source))
        {
            return source;
        }

        var tree = CSharpSyntaxTree.ParseText(source);
        var root = tree.GetRoot();
        var rewriter = new AccessModifierRewriter();
        var newRoot = rewriter.Visit(root);

        return newRoot.ToFullString();
    }

    /// <summary>
    /// AccessModifierRewriter is a syntax rewriter that visits various C# type and member declarations to ensure they each have an explicit access modifier, inserting a default one when none is present.
    /// </summary>
    private sealed class AccessModifierRewriter : CSharpSyntaxRewriter
    {
        // ── Type declarations ──────────────────────────────────────────────────

        /// <summary>
        /// Visits a class declaration and, when enabled and the class lacks an access modifier and is not partial, prepends a default access modifier while clearing leading trivia on the keyword.
        /// </summary>
        /// <param name="node">The node.</param>
        /// <returns>A SyntaxNode value produced by this method.</returns>

        public override SyntaxNode VisitClassDeclaration(ClassDeclarationSyntax node)
        {
            var visited = (ClassDeclarationSyntax)base.VisitClassDeclaration(node);
            if (!Settings.Default.Cleaning_InsertExplicitAccessModifiersOnClasses) return visited;
            if (HasAccessModifier(visited.Modifiers)) return visited;
            if (HasModifier(visited.Modifiers, SyntaxKind.PartialKeyword)) return visited;
            var leading = FirstLeadingTrivia(visited.Modifiers, visited.Keyword);
            var newMods = PrependModifier(visited.Modifiers, DefaultAccessFor(node), leading, out _);

            return visited.WithModifiers(newMods).WithKeyword(visited.Keyword.WithLeadingTrivia(SyntaxTriviaList.Empty));
        }

        /// <summary>
        /// Visits a struct declaration and, when settings require explicit access modifiers and the struct has none and is not partial, prepends the default access modifier and clears the keyword’s leading trivia, otherwise returns the visited node unchanged.
        /// </summary>
        /// <param name="node">The node.</param>
        /// <returns>A SyntaxNode value produced by this method.</returns>

        public override SyntaxNode VisitStructDeclaration(StructDeclarationSyntax node)
        {
            var visited = (StructDeclarationSyntax)base.VisitStructDeclaration(node);
            if (!Settings.Default.Cleaning_InsertExplicitAccessModifiersOnStructs) return visited;
            if (HasAccessModifier(visited.Modifiers)) return visited;
            if (HasModifier(visited.Modifiers, SyntaxKind.PartialKeyword)) return visited;
            var leading = FirstLeadingTrivia(visited.Modifiers, visited.Keyword);
            var newMods = PrependModifier(visited.Modifiers, DefaultAccessFor(node), leading, out _);

            return visited.WithModifiers(newMods).WithKeyword(visited.Keyword.WithLeadingTrivia(SyntaxTriviaList.Empty));
        }

        /// <summary>
        /// Visits an interface declaration and, when enabled by settings and the declaration lacks an explicit access modifier and isn&apos;t partial, inserts a default access modifier before the interface keyword, removing leading trivia from the keyword.
        /// </summary>
        /// <param name="node">The node.</param>
        /// <returns>A SyntaxNode value produced by this method.</returns>

        public override SyntaxNode VisitInterfaceDeclaration(InterfaceDeclarationSyntax node)
        {
            var visited = (InterfaceDeclarationSyntax)base.VisitInterfaceDeclaration(node);
            if (!Settings.Default.Cleaning_InsertExplicitAccessModifiersOnInterfaces) return visited;
            if (HasAccessModifier(visited.Modifiers)) return visited;
            if (HasModifier(visited.Modifiers, SyntaxKind.PartialKeyword)) return visited;
            var leading = FirstLeadingTrivia(visited.Modifiers, visited.Keyword);
            var newMods = PrependModifier(visited.Modifiers, DefaultAccessFor(node), leading, out _);

            return visited.WithModifiers(newMods).WithKeyword(visited.Keyword.WithLeadingTrivia(SyntaxTriviaList.Empty));
        }

        /// <summary>
        /// Visits an enum declaration, returns it unchanged unless explicit access modifiers are enabled and missing, in which case it prepends the default access modifier and clears leading trivia from the enum keyword.
        /// </summary>
        /// <param name="node">The node.</param>
        /// <returns>A SyntaxNode value produced by this method.</returns>

        public override SyntaxNode VisitEnumDeclaration(EnumDeclarationSyntax node)
        {
            var visited = (EnumDeclarationSyntax)base.VisitEnumDeclaration(node);
            if (!Settings.Default.Cleaning_InsertExplicitAccessModifiersOnEnumerations) return visited;
            if (HasAccessModifier(visited.Modifiers)) return visited;
            var leading = FirstLeadingTrivia(visited.Modifiers, visited.EnumKeyword);
            var newMods = PrependModifier(visited.Modifiers, DefaultAccessFor(node), leading, out _);

            return visited.WithModifiers(newMods).WithEnumKeyword(visited.EnumKeyword.WithLeadingTrivia(SyntaxTriviaList.Empty));
        }

        /// <summary>
        /// Visits a record declaration, and if the setting for explicit access modifiers on classes is enabled and the record lacks an access modifier or is not partial, returns a modified node with a default access modifier prepended and the keyword&apos;s leading trivia cleared; otherwise returns the base-visited node unchanged.
        /// </summary>
        /// <param name="node">The node.</param>
        /// <returns>A SyntaxNode value produced by this method.</returns>

        public override SyntaxNode VisitRecordDeclaration(RecordDeclarationSyntax node)
        {
            var visited = (RecordDeclarationSyntax)base.VisitRecordDeclaration(node);
            if (!Settings.Default.Cleaning_InsertExplicitAccessModifiersOnClasses) return visited;
            if (HasAccessModifier(visited.Modifiers)) return visited;
            if (HasModifier(visited.Modifiers, SyntaxKind.PartialKeyword)) return visited;
            var leading = FirstLeadingTrivia(visited.Modifiers, visited.ClassOrStructKeyword);
            var newMods = PrependModifier(visited.Modifiers, DefaultAccessFor(node), leading, out _);

            return visited.WithModifiers(newMods).WithClassOrStructKeyword(visited.ClassOrStructKeyword.WithLeadingTrivia(SyntaxTriviaList.Empty));
        }

        /// <summary>
        /// Visits a delegate declaration and, when the cleaning setting is enabled and no explicit access modifier exists, prepends the default access modifier while adjusting leading trivia and clearing the delegate keyword&apos;s leading trivia.
        /// </summary>
        /// <param name="node">The node.</param>
        /// <returns>A SyntaxNode value produced by this method.</returns>

        public override SyntaxNode VisitDelegateDeclaration(DelegateDeclarationSyntax node)
        {
            var visited = (DelegateDeclarationSyntax)base.VisitDelegateDeclaration(node);
            if (!Settings.Default.Cleaning_InsertExplicitAccessModifiersOnDelegates) return visited;
            if (HasAccessModifier(visited.Modifiers)) return visited;
            var leading = FirstLeadingTrivia(visited.Modifiers, visited.DelegateKeyword);
            var newMods = PrependModifier(visited.Modifiers, DefaultAccessFor(node), leading, out _);

            return visited.WithModifiers(newMods).WithDelegateKeyword(visited.DelegateKeyword.WithLeadingTrivia(SyntaxTriviaList.Empty));
        }

        // ── Members ────────────────────────────────────────────────────────────

        /// <summary>
        /// When a field declaration lacks an access modifier and has a type declaration parent, this method prepends an explicit `private` modifier (using trivia from the original modifiers/type) and removes leading trivia from the type, returning the updated node, while leaving the node unchanged when the setting is disabled, the parent isn&apos;t a type, or an access/fixed modifier already exists.
        /// </summary>
        /// <param name="node">The node.</param>
        /// <returns>A SyntaxNode value produced by this method.</returns>

        public override SyntaxNode VisitFieldDeclaration(FieldDeclarationSyntax node)
        {
            var visited = (FieldDeclarationSyntax)base.VisitFieldDeclaration(node);
            if (!Settings.Default.Cleaning_InsertExplicitAccessModifiersOnFields) return visited;
            if (!(node.Parent is TypeDeclarationSyntax)) return visited;
            if (HasAccessModifier(visited.Modifiers)) return visited;
            if (HasModifier(visited.Modifiers, SyntaxKind.FixedKeyword)) return visited;
            var leading = FirstLeadingTrivia(visited.Modifiers, visited.Declaration.Type);
            var newMods = PrependModifier(visited.Modifiers, SyntaxKind.PrivateKeyword, leading, out _);

            return visited.WithModifiers(newMods).WithDeclaration(
                visited.Declaration.WithType(visited.Declaration.Type.WithLeadingTrivia(SyntaxTriviaList.Empty)));
        }

        /// <summary>
        /// The method visits a method declaration, and when the cleaning setting is enabled and the method lacks an access modifier, isn&apos;t partial, isn&apos;t in an interface, and has no explicit interface specifier, it prepends a private modifier and clears the return type&apos;s leading trivia, returning the modified node; otherwise, it returns the base-visited node unchanged.
        /// </summary>
        /// <param name="node">The node.</param>
        /// <returns>A SyntaxNode value produced by this method.</returns>

        public override SyntaxNode VisitMethodDeclaration(MethodDeclarationSyntax node)
        {
            var visited = (MethodDeclarationSyntax)base.VisitMethodDeclaration(node);
            if (!Settings.Default.Cleaning_InsertExplicitAccessModifiersOnMethods) return visited;
            if (!(node.Parent is TypeDeclarationSyntax parentType)) return visited;
            if (parentType is InterfaceDeclarationSyntax) return visited;
            if (HasAccessModifier(visited.Modifiers)) return visited;
            if (HasModifier(visited.Modifiers, SyntaxKind.PartialKeyword)) return visited;
            if (visited.ExplicitInterfaceSpecifier is not null) return visited;
            var leading = FirstLeadingTrivia(visited.Modifiers, visited.ReturnType);
            var newMods = PrependModifier(visited.Modifiers, SyntaxKind.PrivateKeyword, leading, out _);

            return visited.WithModifiers(newMods).WithReturnType(visited.ReturnType.WithLeadingTrivia(SyntaxTriviaList.Empty));
        }

        /// <summary>
        /// Visits a constructor declaration and, when the cleaning setting is enabled, a type-declaration parent, no static modifier, and no existing access modifier are present, prepends a private access modifier while moving leading trivia to the modifier and clearing the identifier&apos;s leading trivia, returning the modified node without throwing exceptions.
        /// </summary>
        /// <param name="node">The node.</param>
        /// <returns>A SyntaxNode value produced by this method.</returns>

        public override SyntaxNode VisitConstructorDeclaration(ConstructorDeclarationSyntax node)
        {
            var visited = (ConstructorDeclarationSyntax)base.VisitConstructorDeclaration(node);
            if (!Settings.Default.Cleaning_InsertExplicitAccessModifiersOnMethods) return visited;
            if (!(node.Parent is TypeDeclarationSyntax)) return visited;
            if (HasModifier(visited.Modifiers, SyntaxKind.StaticKeyword)) return visited;
            if (HasAccessModifier(visited.Modifiers)) return visited;
            var leading = FirstLeadingTrivia(visited.Modifiers, visited.Identifier);
            var newMods = PrependModifier(visited.Modifiers, SyntaxKind.PrivateKeyword, leading, out _);

            return visited.WithModifiers(newMods).WithIdentifier(visited.Identifier.WithLeadingTrivia(SyntaxTriviaList.Empty));
        }

        /// <summary>
        /// Delegates to the base visitor for destructor declarations without additional logic or side effects.
        /// </summary>
        /// <param name="node">The node.</param>
        /// <returns>A SyntaxNode value produced by this method.</returns>

        public override SyntaxNode VisitDestructorDeclaration(DestructorDeclarationSyntax node)
        {
            return base.VisitDestructorDeclaration(node);
        }

        /// <summary>
        /// This method visits a property declaration and, when the setting is enabled, adds an explicit `private` access modifier to properties lacking one in non-interface types (skipping explicit interface implementations), while clearing the type&apos;s leading trivia.
        /// </summary>
        /// <param name="node">The node.</param>
        /// <returns>A SyntaxNode value produced by this method.</returns>

        public override SyntaxNode VisitPropertyDeclaration(PropertyDeclarationSyntax node)
        {
            var visited = (PropertyDeclarationSyntax)base.VisitPropertyDeclaration(node);
            if (!Settings.Default.Cleaning_InsertExplicitAccessModifiersOnProperties) return visited;
            if (!(node.Parent is TypeDeclarationSyntax parentType)) return visited;
            if (parentType is InterfaceDeclarationSyntax) return visited;
            if (HasAccessModifier(visited.Modifiers)) return visited;
            if (visited.ExplicitInterfaceSpecifier is not null) return visited;
            var leading = FirstLeadingTrivia(visited.Modifiers, visited.Type);
            var newMods = PrependModifier(visited.Modifiers, SyntaxKind.PrivateKeyword, leading, out _);

            return visited.WithModifiers(newMods).WithType(visited.Type.WithLeadingTrivia(SyntaxTriviaList.Empty));
        }

        /// <summary>
        /// This method visits an event declaration, and if the setting for inserting explicit access modifiers on events is enabled, the parent is a non-interface type, no access modifier or explicit interface specifier exists, it prepends a private modifier to the event and removes the leading trivia from the event keyword, otherwise returning the original visited node.
        /// </summary>
        /// <param name="node">The node.</param>
        /// <returns>A SyntaxNode value produced by this method.</returns>

        public override SyntaxNode VisitEventDeclaration(EventDeclarationSyntax node)
        {
            var visited = (EventDeclarationSyntax)base.VisitEventDeclaration(node);
            if (!Settings.Default.Cleaning_InsertExplicitAccessModifiersOnEvents) return visited;
            if (!(node.Parent is TypeDeclarationSyntax parentType)) return visited;
            if (parentType is InterfaceDeclarationSyntax) return visited;
            if (HasAccessModifier(visited.Modifiers)) return visited;
            if (visited.ExplicitInterfaceSpecifier is not null) return visited;
            var leading = FirstLeadingTrivia(visited.Modifiers, visited.EventKeyword);
            var newMods = PrependModifier(visited.Modifiers, SyntaxKind.PrivateKeyword, leading, out _);

            return visited.WithModifiers(newMods).WithEventKeyword(visited.EventKeyword.WithLeadingTrivia(SyntaxTriviaList.Empty));
        }

        /// <summary>
        /// Visits an event field declaration and, when the setting is enabled and the node has no explicit access modifier and is in a non-interface type, mutates the node by prepending a private modifier and removing leading trivia from the event keyword, otherwise returns the original visited node.
        /// </summary>
        /// <param name="node">The node.</param>
        /// <returns>A SyntaxNode value produced by this method.</returns>

        public override SyntaxNode VisitEventFieldDeclaration(EventFieldDeclarationSyntax node)
        {
            var visited = (EventFieldDeclarationSyntax)base.VisitEventFieldDeclaration(node);
            if (!Settings.Default.Cleaning_InsertExplicitAccessModifiersOnEvents) return visited;
            if (!(node.Parent is TypeDeclarationSyntax parentType)) return visited;
            if (parentType is InterfaceDeclarationSyntax) return visited;
            if (HasAccessModifier(visited.Modifiers)) return visited;
            var leading = FirstLeadingTrivia(visited.Modifiers, visited.EventKeyword);
            var newMods = PrependModifier(visited.Modifiers, SyntaxKind.PrivateKeyword, leading, out _);

            return visited.WithModifiers(newMods).WithEventKeyword(visited.EventKeyword.WithLeadingTrivia(SyntaxTriviaList.Empty));
        }

        // ── Helpers ────────────────────────────────────────────────────────────

        /// <summary>
        /// Returns true if the given modifier token list contains any access modifier keyword (public, internal, protected, or private), otherwise false, with no side effects.
        /// </summary>
        /// <param name="modifiers">The modifiers.</param>
        /// <returns>A bool value produced by this method.</returns>

        private static bool HasAccessModifier(SyntaxTokenList modifiers)
        {
            return modifiers.Any(m =>
                m.IsKind(SyntaxKind.PublicKeyword) ||
                m.IsKind(SyntaxKind.InternalKeyword) ||
                m.IsKind(SyntaxKind.ProtectedKeyword) ||
                m.IsKind(SyntaxKind.PrivateKeyword));
        }

        /// <summary>
        /// Returns true if any modifier in the list matches the specified syntax kind, otherwise false, with no side effects.
        /// </summary>
        /// <param name="modifiers">The modifiers.</param>
        /// <param name="kind">The kind.</param>
        /// <returns>A bool value produced by this method.</returns>

        private static bool HasModifier(SyntaxTokenList modifiers, SyntaxKind kind)
        {
            return modifiers.Any(m => m.IsKind(kind));
        }

        /// <summary>Returns the default implicit access modifier for a declaration in its current context.</summary>

        private static SyntaxKind DefaultAccessFor(MemberDeclarationSyntax node)
        {
            return node.Parent is TypeDeclarationSyntax
                ? SyntaxKind.PrivateKeyword
                : SyntaxKind.InternalKeyword;
        }

        /// <summary>Returns the leading trivia that belongs on the new first token of a declaration.</summary>

        private static SyntaxTriviaList FirstLeadingTrivia(SyntaxTokenList modifiers, SyntaxToken fallback)
        {
            return modifiers.Count > 0 ? modifiers[0].LeadingTrivia : fallback.LeadingTrivia;
        }

        /// <summary>
        /// Returns the leading trivia of the first modifier token if modifiers exist, otherwise the leading trivia of the fallback type, with no side effects.
        /// </summary>
        /// <param name="modifiers">The modifiers.</param>
        /// <param name="fallback">The fallback.</param>
        /// <returns>A SyntaxTriviaList value produced by this method.</returns>

        private static SyntaxTriviaList FirstLeadingTrivia(SyntaxTokenList modifiers, TypeSyntax fallback)
        {
            return modifiers.Count > 0 ? modifiers[0].LeadingTrivia : fallback.GetLeadingTrivia();
        }

        /// <summary>
        /// Builds a new modifier list with <paramref name="kind"/> prepended carrying
        /// <paramref name="leadingTrivia"/>.  Strips leading trivia from the formerly-first modifier.
        /// </summary>

        private static SyntaxTokenList PrependModifier(
            SyntaxTokenList existing,
            SyntaxKind kind,
            SyntaxTriviaList leadingTrivia,
            out SyntaxTriviaList strippedTrivia)
        {
            var newToken = SyntaxFactory.Token(leadingTrivia, kind, SyntaxFactory.TriviaList(SyntaxFactory.Space));

            if (existing.Count == 0)
            {
                strippedTrivia = SyntaxTriviaList.Empty;

                return SyntaxFactory.TokenList(newToken);
            }

            strippedTrivia = existing[0].LeadingTrivia;
            var strippedFirst = existing[0].WithLeadingTrivia(SyntaxTriviaList.Empty);

            return SyntaxFactory.TokenList(
                new[] { newToken, strippedFirst }.Concat(existing.Skip(1)));
        }
    }
}
