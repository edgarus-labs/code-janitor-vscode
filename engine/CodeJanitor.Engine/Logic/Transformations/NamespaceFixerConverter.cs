using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using System;
using System.Linq;

namespace CodeJanitor.Logic.Transformations;

/// <summary>
/// Updates the namespace declaration in a C# file to match an expected namespace.
/// </summary>

public sealed class NamespaceFixerConverter
{
    /// <summary>
    /// Parses the C# source and, if it has a top-level namespace whose name differs from expectedNamespace, returns the source with that namespace name replaced by expectedNamespace; otherwise returns the original source unchanged, with no side effects or exceptions thrown.
    /// </summary>
    /// <param name="source">The source.</param>
    /// <param name="expectedNamespace">The expected namespace.</param>
    /// <returns>A string value produced by this method.</returns>

    public string FixNamespace(string source, string expectedNamespace)
    {
        if (string.IsNullOrWhiteSpace(source) || string.IsNullOrWhiteSpace(expectedNamespace))
        {
            return source;
        }

        var tree = CSharpSyntaxTree.ParseText(source);
        if (!(tree.GetRoot() is CompilationUnitSyntax root))
        {
            return source;
        }

        var namespaceDeclaration = GetTopLevelNamespace(root);
        if (namespaceDeclaration is null)
        {
            return source;
        }

        if (string.Equals(namespaceDeclaration.Name.ToString(), expectedNamespace, StringComparison.Ordinal))
        {
            return source;
        }

        var namespaceSpan = namespaceDeclaration.Name.Span;

        return source.Substring(0, namespaceSpan.Start)
            + expectedNamespace
            + source.Substring(namespaceSpan.End);
    }

    /// <summary>
    /// Returns the sole top-level namespace declaration from the compilation unit, or null if there are zero or multiple, with no side effects.
    /// </summary>
    /// <param name="root">The root.</param>
    /// <returns>A BaseNamespaceDeclarationSyntax value produced by this method.</returns>

    private static BaseNamespaceDeclarationSyntax GetTopLevelNamespace(CompilationUnitSyntax root)
    {
        var namespaces = root.DescendantNodes()
            .OfType<BaseNamespaceDeclarationSyntax>()
            .Where(namespaceDeclaration => namespaceDeclaration.Parent is CompilationUnitSyntax)
            .ToList();

        return namespaces.Count == 1 ? namespaces[0] : null;
    }
}
