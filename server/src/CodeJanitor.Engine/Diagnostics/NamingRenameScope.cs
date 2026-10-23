using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace CodeJanitor.Engine.Diagnostics;

/// <summary>
/// Whether the naming fix (IDE1006) of a symbol stays inside its file:
/// locals, local functions, range variables, parameters of lambdas, local functions and private methods, type parameters of
/// those, and private members of a type declared in this file only. Types, namespaces and other members may be used by other
/// files, so with <c>renamePublicSymbolsAcrossWorkspace</c> off they are reported instead of renamed.
/// </summary>
internal static class NamingRenameScope
{
    /// <summary>The detail for a rename made only by a cleanup that runs over the workspace.</summary>
    public const string ChangedLinesDetail = "not renamed: renames are not made when only changed lines are cleaned (codeJanitor.cleanup.onlyChangedLines).";

    private const string TypeDetail = "not renamed: type names are not renamed without codeJanitor.cleanup.renamePublicSymbolsAcrossWorkspace, other files may use them.";
    private const string MemberDetail = "not renamed because it is not private and may be referenced from other files (codeJanitor.cleanup.renamePublicSymbolsAcrossWorkspace is off).";
    private const string UnknownDetail = "not renamed: the symbol cannot be resolved.";

    /// <summary>Null when the rename of the symbol the diagnostic names stays inside the document; otherwise why it is not made.</summary>
    public static async Task<string?> WhyNotRenamedAsync(Document document, Diagnostic diagnostic, CancellationToken cancellationToken)
    {
        var root = await document.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false);
        var model = await document.GetSemanticModelAsync(cancellationToken).ConfigureAwait(false);
        if (root is null || model is null)
        {
            return UnknownDetail;
        }

        var token = root.FindToken(diagnostic.Location.SourceSpan.Start);
        ISymbol? symbol = null;
        for (var node = token.Parent; node is not null && symbol is null; node = node.Parent)
        {
            symbol = model.GetDeclaredSymbol(node, cancellationToken);
            if (node is MemberDeclarationSyntax or StatementSyntax)
            {
                break;
            }
        }

        if (symbol is null)
        {
            return UnknownDetail;
        }

        return StaysInFile(symbol, diagnostic.Location.SourceTree) ? null : symbol is INamedTypeSymbol or INamespaceSymbol ? TypeDetail : MemberDetail;
    }

    private static bool StaysInFile(ISymbol symbol, SyntaxTree? tree)
    {
        switch (symbol)
        {
            case ILocalSymbol or IRangeVariableSymbol or ILabelSymbol:
                return true;
            case IMethodSymbol { MethodKind: MethodKind.LocalFunction or MethodKind.AnonymousFunction }:
                return true;
            case IParameterSymbol parameter:
                return parameter.ContainingSymbol is IMethodSymbol owner && StaysInFile(owner, tree);
            case ITypeParameterSymbol typeParameter:
                return typeParameter.DeclaringMethod is { } declaringMethod && StaysInFile(declaringMethod, tree);
            case INamedTypeSymbol or INamespaceSymbol:
                return false;
            case IMethodSymbol method when method.IsOverride || method.IsExtern || method.ExplicitInterfaceImplementations.Length > 0 || method.PartialDefinitionPart is not null || method.PartialImplementationPart is not null:
                return false;
            case IPropertySymbol property when property.IsOverride || property.ExplicitInterfaceImplementations.Length > 0:
                return false;
            case IEventSymbol @event when @event.IsOverride || @event.ExplicitInterfaceImplementations.Length > 0:
                return false;
        }

        return symbol.DeclaredAccessibility == Accessibility.Private
            && symbol.DeclaringSyntaxReferences.All(reference => reference.SyntaxTree == tree)
            && symbol.ContainingType is { } type
            && type.DeclaringSyntaxReferences.All(reference => reference.SyntaxTree == tree);
    }
}
