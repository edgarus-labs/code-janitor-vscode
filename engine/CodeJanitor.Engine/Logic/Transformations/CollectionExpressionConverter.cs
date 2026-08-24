using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using System.Linq;

namespace CodeJanitor.Logic.Transformations;

/// <summary>
/// Converts <c>List&lt;T&gt;</c> and array initializations to the C# 12 collection expression
/// syntax (<c>[]</c> / <c>[a, b, c]</c>) when the declared type is explicit and textually
/// matches the created type.
/// </summary>
/// <remarks>
/// Uses a textual type match (rather than the semantic model) so the transformation is safe
/// without a full compilation, mirroring <see cref="VarWhenApparentConverter" /> (see ADR-0007).
/// Pure logic, unit-testable without Visual Studio.
/// </remarks>

public sealed class CollectionExpressionConverter : ISourceTransformation
{
    /// <inheritdoc />
    public string Name => "Collection Expression";

    /// <inheritdoc />

    public string Apply(string source)
    {
        if (string.IsNullOrEmpty(source))
        {
            return source;
        }

        var tree = CSharpSyntaxTree.ParseText(source);
        var root = tree.GetRoot();
        var rewritten = new CollectionExpressionRewriter().Visit(root);

        return rewritten.ToFullString();
    }

    /// <summary>
    /// ExpressionRewriter is a syntax rewriter that transforms variable declarations and property declarations using collection initializer, object creation, or array creation expressions into equivalent C# 12 collection expressions for supported list types.
    /// </summary>
    private sealed class CollectionExpressionRewriter : CSharpSyntaxRewriter
    {
        /// <summary>
        /// This method visits a variable declarator, returns it unchanged unless its parent is a variable declaration with an initializer, and if a collection expression conversion succeeds, returns a new node with the initializer value replaced by that collection expression, otherwise returns the original node.
        /// </summary>
        /// <param name="node">The node.</param>
        /// <returns>A SyntaxNode value produced by this method.</returns>

        public override SyntaxNode VisitVariableDeclarator(VariableDeclaratorSyntax node)
        {
            node = (VariableDeclaratorSyntax)base.VisitVariableDeclarator(node);

            if (!(node.Parent is VariableDeclarationSyntax declaration) || node.Initializer is null)
            {
                return node;
            }

            var replacement = TryConvertToCollectionExpression(declaration.Type, node.Initializer.Value);

            return replacement is null
                ? node
                : node.WithInitializer(node.Initializer.WithValue(replacement));
        }

        /// <summary>
        /// Visits a property declaration, first invoking base traversal, then if the property has an initializer, attempts to convert its value to a collection expression and replaces the initializer with the converted expression when successful, otherwise returns the original node.
        /// </summary>
        /// <param name="node">The node.</param>
        /// <returns>A SyntaxNode value produced by this method.</returns>

        public override SyntaxNode VisitPropertyDeclaration(PropertyDeclarationSyntax node)
        {
            node = (PropertyDeclarationSyntax)base.VisitPropertyDeclaration(node);

            if (node.Initializer is null)
            {
                return node;
            }

            var replacement = TryConvertToCollectionExpression(node.Type, node.Initializer.Value);

            return replacement is null
                ? node
                : node.WithInitializer(node.Initializer.WithValue(replacement));
        }

        /// <summary>
        /// Attempts to convert an object creation, array creation, or implicit array creation initializer into a collection expression when compatible with the declared type, returning null otherwise without side effects.
        /// </summary>
        /// <param name="declaredType">The declared type.</param>
        /// <param name="initializer">The initializer.</param>
        /// <returns>A ExpressionSyntax value produced by this method.</returns>

        private static ExpressionSyntax TryConvertToCollectionExpression(TypeSyntax declaredType, ExpressionSyntax initializer)
        {
            switch (initializer)
            {
                case ObjectCreationExpressionSyntax objectCreation:
                    return TryConvertObjectCreation(declaredType, objectCreation);

                case ArrayCreationExpressionSyntax arrayCreation:
                    return TryConvertArrayCreation(declaredType, arrayCreation);

                case ImplicitArrayCreationExpressionSyntax implicitArrayCreation:
                    return declaredType is ArrayTypeSyntax
                        ? BuildCollectionExpression(implicitArrayCreation.Initializer.Expressions).WithTriviaFrom(implicitArrayCreation)
                        : null;

                default:
                    return null;
            }
        }

        /// <summary>
        /// Attempts to convert an argument-less object creation of a supported list type matching the declared type into a collection expression using its initializer elements, preserving original trivia, and returns null if conversion isn&apos;t applicable.
        /// </summary>
        /// <param name="declaredType">The declared type.</param>
        /// <param name="objectCreation">The object creation.</param>
        /// <returns>A ExpressionSyntax value produced by this method.</returns>

        private static ExpressionSyntax TryConvertObjectCreation(TypeSyntax declaredType, ObjectCreationExpressionSyntax objectCreation)
        {
            if (objectCreation.ArgumentList is not null && objectCreation.ArgumentList.Arguments.Count > 0)
            {
                // e.g. new List<T>(capacity) or new List<T>(otherCollection) - not a plain
                // empty/initializer creation, leave untouched.
                return null;
            }

            if (!IsSupportedListType(objectCreation.Type) || objectCreation.Type.ToString() != declaredType.ToString())
            {
                return null;
            }

            var elements = objectCreation.Initializer?.Expressions ?? default;

            return BuildCollectionExpression(elements).WithTriviaFrom(objectCreation);
        }

        /// <summary>
        /// Attempts to convert an array creation expression to a collection expression only when the declared type is a matching array type and either an initializer is present or the array is explicitly zero-length, otherwise returns null with no side effects.
        /// </summary>
        /// <param name="declaredType">The declared type.</param>
        /// <param name="arrayCreation">The array creation.</param>
        /// <returns>A ExpressionSyntax value produced by this method.</returns>

        private static ExpressionSyntax TryConvertArrayCreation(TypeSyntax declaredType, ArrayCreationExpressionSyntax arrayCreation)
        {
            if (!(declaredType is ArrayTypeSyntax declaredArrayType)
                || declaredArrayType.ElementType.ToString() != arrayCreation.Type.ElementType.ToString())
            {
                return null;
            }

            if (arrayCreation.Initializer is not null)
            {
                return BuildCollectionExpression(arrayCreation.Initializer.Expressions).WithTriviaFrom(arrayCreation);
            }

            // No initializer - only safe to convert an explicitly zero-length array (e.g.
            // 'new T[0]'), since a sized-but-empty array ('new T[5]') has different semantics.
            var rankSize = arrayCreation.Type.RankSpecifiers.FirstOrDefault()?.Sizes.FirstOrDefault();

            return rankSize is LiteralExpressionSyntax literal && literal.Token.ValueText == "0"
                ? BuildCollectionExpression(default).WithTriviaFrom(arrayCreation)
                : null;
        }

        /// <summary>
        /// Returns true only if the given type syntax is a generic name (such as `List&lt;T&gt;`) whose base identifier is &quot;List&quot;, performing a pure syntactic check with no side effects or exceptions.
        /// </summary>
        /// <param name="type">The type.</param>
        /// <returns>A bool value produced by this method.</returns>

        private static bool IsSupportedListType(TypeSyntax type) =>
                    type is GenericNameSyntax genericName && genericName.Identifier.ValueText == "List";

        /// <summary>
        /// Builds a collection expression string from the element expressions&apos; text and returns the parsed SyntaxFactory expression, with no side effects.
        /// </summary>
        /// <param name="elements">The elements.</param>
        /// <returns>A ExpressionSyntax value produced by this method.</returns>

        private static ExpressionSyntax BuildCollectionExpression(SeparatedSyntaxList<ExpressionSyntax> elements)
        {
            var elementsText = string.Join(", ", elements.Select(e => e.ToString()));

            return SyntaxFactory.ParseExpression("[" + elementsText + "]");
        }
    }
}
