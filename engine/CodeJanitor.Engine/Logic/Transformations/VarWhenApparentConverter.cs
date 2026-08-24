using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace CodeJanitor.Logic.Transformations;

/// <summary>
/// Converts explicitly-typed local declarations to <c>var</c> only when the type is apparent
/// from the right-hand side and textually matches the declared type (see ADR-0007).
/// </summary>
/// <remarks>
/// Uses a textual type match (rather than the semantic model) so the transformation is safe
/// without a full compilation: e.g. <c>IFoo x = new Foo()</c> is left unchanged because the
/// declared type differs from the created type. Pure logic, unit-testable without Visual Studio.
/// </remarks>

public sealed class VarWhenApparentConverter : ITypeStyleConverter, ISourceTransformation
{
    /// <inheritdoc />
    public string Name => "Var When Apparent";

    /// <inheritdoc />

    public string Apply(string source) => UseVarWhenApparent(source);

    /// <inheritdoc />

    public string UseVarWhenApparent(string source)
    {
        if (string.IsNullOrEmpty(source))
        {
            return source;
        }

        var tree = CSharpSyntaxTree.ParseText(source);
        var root = tree.GetRoot();
        var rewritten = new VarRewriter().Visit(root);

        return rewritten.ToFullString();
    }

    /// <summary>
    /// VarRewriter is a class that converts implicitly-typed local variable declarations (var) into explicitly-typed declarations by analyzing each local declaration statement and determining whether the variable&apos;s type is apparent from its initializer.
    /// </summary>
    private sealed class VarRewriter : CSharpSyntaxRewriter
    {
        /// <summary>
        /// This method rewrites a local declaration&apos;s explicit type to `var` when the declaration has a single variable with an initializer and the type is apparent, otherwise delegating to the base visitor.
        /// </summary>
        /// <param name="node">The node.</param>
        /// <returns>A SyntaxNode value produced by this method.</returns>

        public override SyntaxNode VisitLocalDeclarationStatement(LocalDeclarationStatementSyntax node)
        {
            var declaration = node.Declaration;
            if (declaration.Variables.Count != 1)
            {
                return base.VisitLocalDeclarationStatement(node);
            }

            var variable = declaration.Variables[0];
            if (variable.Initializer is null)
            {
                return base.VisitLocalDeclarationStatement(node);
            }

            var declaredType = declaration.Type;
            if (declaredType.IsVar)
            {
                return base.VisitLocalDeclarationStatement(node);
            }

            if (!IsTypeApparent(declaredType, variable.Initializer.Value))
            {
                return base.VisitLocalDeclarationStatement(node);
            }

            var varType = SyntaxFactory.IdentifierName("var").WithTriviaFrom(declaredType);

            return node.WithDeclaration(declaration.WithType(varType));
        }

        /// <summary>
        /// Determines whether the initializer&apos;s syntactic type matches the declared type by comparing type text for object creation, cast, or array creation, with no side effects.
        /// </summary>
        /// <param name="declaredType">The declared type.</param>
        /// <param name="initializer">The initializer.</param>
        /// <returns>A bool value produced by this method.</returns>

        private static bool IsTypeApparent(TypeSyntax declaredType, ExpressionSyntax initializer)
        {
            var declaredText = declaredType.ToString();

            switch (initializer)
            {
                case ObjectCreationExpressionSyntax objectCreation:
                    return objectCreation.Type.ToString() == declaredText;

                case CastExpressionSyntax cast:
                    return cast.Type.ToString() == declaredText;

                case ArrayCreationExpressionSyntax arrayCreation:
                    return declaredType is ArrayTypeSyntax declaredArray
                        && declaredArray.ElementType.ToString() == arrayCreation.Type.ElementType.ToString();

                default:
                    return false;
            }
        }
    }
}
