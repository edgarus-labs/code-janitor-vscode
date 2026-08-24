using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace CodeJanitor.Logic.Transformations;

/// <summary>
/// Sorts C# <c>using</c> directives from a single syntax tree without EnvDTE or an open editor
/// (see ADR-0007). First purely syntactic building block of the headless-Roslyn cleanup path
/// (BL-018). Pure logic, unit-testable without Visual Studio.
/// </summary>
/// <remarks>
/// Sorting order: regular usings, then <c>using static</c>, then alias usings; within each
/// group <c>System</c> namespaces come first, then ordinal alphabetical. Formatting is
/// preserved by keeping each original line's trivia (indentation, newlines, blank lines) in
/// place and only reordering the directive content. A block is left completely untouched when
/// it contains comments, preprocessor directives, or <c>global using</c> directives, so no
/// trivia or conditional structure is ever lost. Removing unused usings is a semantic operation
/// and is intentionally out of scope.
/// </remarks>

public sealed class UsingDirectiveOrganizer : IUsingDirectiveOrganizer, ISourceTransformation
{
    /// <inheritdoc />
    public string Name => "Sort using directives";

    /// <inheritdoc />

    public string Apply(string source)
    {
        return Organize(source);
    }

    /// <inheritdoc />

    public string Organize(string source)
    {
        if (string.IsNullOrEmpty(source))
        {
            return source;
        }

        var tree = CSharpSyntaxTree.ParseText(source);
        if (!(tree.GetRoot() is CompilationUnitSyntax root))
        {
            return source;
        }

        var rewriter = new UsingSortingRewriter();
        var newRoot = rewriter.Visit(root);

        return rewriter.Changed ? newRoot.ToFullString() : source;
    }

    /// <summary>
    /// Reorders a block of using directives, or returns the original block unchanged when it is
    /// already sorted or is not safe to reorder.
    /// </summary>

    private static SyntaxList<UsingDirectiveSyntax> Sort(SyntaxList<UsingDirectiveSyntax> usings, out bool changed)
    {
        changed = false;

        if (usings.Count < 2)
        {
            return usings;
        }

        // Conservative: never reorder a block that carries comments, preprocessor directives or
        // global usings, to avoid losing comments/conditional structure or moving globals.
        if (usings.Any(IsUnsafeToReorder))
        {
            return usings;
        }

        var original = usings.ToList();
        var sorted = original
            .OrderBy(GroupRank)
            .ThenBy(SystemRank)
            .ThenBy(SortName, StringComparer.Ordinal)
            .ToList();

        if (original.SequenceEqual(sorted))
        {
            return usings;
        }

        // Keep each original slot's trivia in place and only swap the directive content, so the
        // existing indentation, newlines and blank lines around the block are preserved exactly.
        var rebuilt = new List<UsingDirectiveSyntax>(original.Count);
        for (int i = 0; i < original.Count; i++)
        {
            rebuilt.Add(sorted[i]
                .WithLeadingTrivia(original[i].GetLeadingTrivia())
                .WithTrailingTrivia(original[i].GetTrailingTrivia()));
        }

        changed = true;

        return SyntaxFactory.List(rebuilt);
    }

    /// <summary>
    /// Returns true for a UsingDirectiveSyntax if it is global, malformed, or has any directive, comment, documentation, or disabled-text trivia, indicating that reordering it should be avoided; the method has no side effects.
    /// </summary>
    /// <param name="u">The u.</param>
    /// <returns>A bool value produced by this method.</returns>

    private static bool IsUnsafeToReorder(UsingDirectiveSyntax u)
    {
        if (u.GlobalKeyword.IsKind(SyntaxKind.GlobalKeyword))
        {
            return true;
        }

        // A malformed directive with no name and no alias is left alone.
        if (u.Alias is null && u.Name is null)
        {
            return true;
        }

        return u.GetLeadingTrivia().Concat(u.GetTrailingTrivia()).Any(t =>
            t.IsDirective ||
            t.IsKind(SyntaxKind.SingleLineCommentTrivia) ||
            t.IsKind(SyntaxKind.MultiLineCommentTrivia) ||
            t.IsKind(SyntaxKind.SingleLineDocumentationCommentTrivia) ||
            t.IsKind(SyntaxKind.MultiLineDocumentationCommentTrivia) ||
            t.IsKind(SyntaxKind.DisabledTextTrivia));
    }

    /// <summary>
    /// Returns 2 for using directives with an alias, 1 for static using directives, and 0 otherwise, with no side effects or exceptions thrown.
    /// </summary>
    /// <param name="u">The u.</param>
    /// <returns>A int value produced by this method.</returns>

    private static int GroupRank(UsingDirectiveSyntax u)
    {
        if (u.Alias is not null)
        {
            return 2;
        }

        return u.StaticKeyword.IsKind(SyntaxKind.StaticKeyword) ? 1 : 0;
    }

    /// <summary>
    /// Returns 0 for alias usings or usings starting with &quot;System&quot; (exact &quot;System&quot; or &quot;System.&quot;), otherwise 1, with no side effects.
    /// </summary>
    /// <param name="u">The u.</param>
    /// <returns>A int value produced by this method.</returns>

    private static int SystemRank(UsingDirectiveSyntax u)
    {
        // Alias usings are grouped separately and sorted purely by alias name.
        if (u.Alias is not null)
        {
            return 0;
        }

        var name = u.Name?.ToString() ?? string.Empty;

        return name == "System" || name.StartsWith("System.", StringComparison.Ordinal) ? 0 : 1;
    }

    /// <summary>
    /// Returns the alias name if the using directive has an alias, otherwise returns its namespace/name (or an empty string if null), with no side effects.
    /// </summary>
    /// <param name="u">The u.</param>
    /// <returns>A string value produced by this method.</returns>

    private static string SortName(UsingDirectiveSyntax u)
    {
        if (u.Alias is not null)
        {
            return u.Alias.Name.ToString();
        }

        return u.Name?.ToString() ?? string.Empty;
    }

    /// <summary>
    /// Visits every using-directive container (compilation unit and namespaces, including
    /// file-scoped and nested) and sorts its directives.
    /// </summary>

    private sealed class UsingSortingRewriter : CSharpSyntaxRewriter
    {
        /// <summary>
        /// Gets or sets the changed.
        /// </summary>
        public bool Changed { get; private set; }

        /// <summary>
        /// Overrides compilation unit visiting to sort the using directives, and if their order changed, marks the node as changed and returns a new node with the sorted usings; otherwise returns the visited node unchanged.
        /// </summary>
        /// <param name="node">The node.</param>
        /// <returns>A SyntaxNode value produced by this method.</returns>

        public override SyntaxNode VisitCompilationUnit(CompilationUnitSyntax node)
        {
            node = (CompilationUnitSyntax)base.VisitCompilationUnit(node);

            var sorted = Sort(node.Usings, out var changed);
            if (changed)
            {
                Changed = true;

                return node.WithUsings(sorted);
            }

            return node;
        }

        /// <summary>
        /// Overrides namespace declaration visiting by sorting its using directives and, if any reordering occurred, marks the syntax tree as changed and returns a new node with the sorted usings.
        /// </summary>
        /// <param name="node">The node.</param>
        /// <returns>A SyntaxNode value produced by this method.</returns>

        public override SyntaxNode VisitNamespaceDeclaration(NamespaceDeclarationSyntax node)
        {
            node = (NamespaceDeclarationSyntax)base.VisitNamespaceDeclaration(node);

            var sorted = Sort(node.Usings, out var changed);
            if (changed)
            {
                Changed = true;

                return node.WithUsings(sorted);
            }

            return node;
        }

        /// <summary>
        /// Visits a file-scoped namespace declaration, sorts its usings, and if the order changed, marks the tree as changed and returns the node with reordered usings; otherwise returns the visited node unchanged.
        /// </summary>
        /// <param name="node">The node.</param>
        /// <returns>A SyntaxNode value produced by this method.</returns>

        public override SyntaxNode VisitFileScopedNamespaceDeclaration(FileScopedNamespaceDeclarationSyntax node)
        {
            node = (FileScopedNamespaceDeclarationSyntax)base.VisitFileScopedNamespaceDeclaration(node);

            var sorted = Sort(node.Usings, out var changed);
            if (changed)
            {
                Changed = true;

                return node.WithUsings(sorted);
            }

            return node;
        }
    }
}
