using System.Collections.Generic;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace CodeJanitor.Logic.Transformations;

/// <summary>
/// Adds the <c>readonly</c> modifier to fields only when provably safe to do so from a single
/// syntax tree, without a full solution-wide semantic analysis (see ADR-0007).
/// </summary>
/// <remarks>
/// Scope is intentionally conservative: only <c>private</c> fields of non-partial types with a
/// single declarator are considered, and only when every write to the field occurs directly in
/// the declaring type's own constructor (instance fields) or static constructor (static
/// fields) - never in a regular method, accessor, local function, or nested lambda, since those
/// could execute after construction. Pure logic, unit-testable without Visual Studio.
/// </remarks>

public sealed class ReadonlyFieldConverter : IFieldMutabilityConverter, ISourceTransformation
{
    /// <inheritdoc />
    public string Name => "Readonly Field";

    /// <inheritdoc />

    public string Apply(string source) => AddReadonlyWhenSafe(source);

    /// <inheritdoc />

    public string AddReadonlyWhenSafe(string source)
    {
        if (string.IsNullOrEmpty(source))
        {
            return source;
        }

        var tree = CSharpSyntaxTree.ParseText(source);
        var root = tree.GetRoot();

        var fieldsToConvert = new List<FieldDeclarationSyntax>();

        foreach (var typeDecl in root.DescendantNodes().OfType<TypeDeclarationSyntax>())
        {
            if (typeDecl.Modifiers.Any(m => m.IsKind(SyntaxKind.PartialKeyword)))
            {
                continue;
            }

            foreach (var fieldDecl in typeDecl.Members.OfType<FieldDeclarationSyntax>())
            {
                if (IsSafeToMakeReadonly(typeDecl, fieldDecl))
                {
                    fieldsToConvert.Add(fieldDecl);
                }
            }
        }

        if (fieldsToConvert.Count == 0)
        {
            return source;
        }

        var newRoot = root.ReplaceNodes(fieldsToConvert, (original, _) => WithReadonlyModifier(original));

        return newRoot.ToFullString();
    }

    /// <summary>
    /// FieldAccessKind represents the access pattern for a field, distinguishing between no access, direct access, or access through a sub-member.
    /// </summary>
    private enum FieldAccessKind
    {
        None,
        Direct,
        SubMember
    }

    /// <summary>
    /// Checks whether a single private field can be made readonly by rejecting fields with multiple variables, readonly/const/volatile modifiers, or non-private accessibility, and scanning the containing type for any writes via assignments, increment/decrement operations, or ref/out arguments (including across object sub-members), returning true only if no such unsafe writes are found.
    /// </summary>
    /// <param name="typeDecl">The type decl.</param>
    /// <param name="fieldDecl">The field decl.</param>
    /// <returns>A bool value produced by this method.</returns>

    private static bool IsSafeToMakeReadonly(TypeDeclarationSyntax typeDecl, FieldDeclarationSyntax fieldDecl)
    {
        if (fieldDecl.Declaration.Variables.Count != 1)
        {
            return false;
        }

        var modifiers = fieldDecl.Modifiers;
        if (modifiers.Any(m => m.IsKind(SyntaxKind.ReadOnlyKeyword) ||
                                m.IsKind(SyntaxKind.ConstKeyword) ||
                                m.IsKind(SyntaxKind.VolatileKeyword)))
        {
            return false;
        }

        // Only private (explicit or implicit) fields: external writes to
        // public/internal/protected fields cannot be ruled out from a single file.
        if (modifiers.Any(m => m.IsKind(SyntaxKind.PublicKeyword) ||
                                m.IsKind(SyntaxKind.InternalKeyword) ||
                                m.IsKind(SyntaxKind.ProtectedKeyword)))
        {
            return false;
        }

        var isStatic = modifiers.Any(m => m.IsKind(SyntaxKind.StaticKeyword));
        var fieldName = fieldDecl.Declaration.Variables[0].Identifier.Text;
        var declaringTypeName = typeDecl.Identifier.Text;

        var scopeNodes = typeDecl.DescendantNodes(n => n == typeDecl || !(n is TypeDeclarationSyntax));

        // Any ref or out argument (or ref expression) referencing this field or its sub-members
        // makes it unsafe to add readonly (both in methods and in constructors).
        foreach (var argument in scopeNodes.OfType<ArgumentSyntax>())
        {
            if (argument.RefKindKeyword.IsKind(SyntaxKind.RefKeyword) || argument.RefKindKeyword.IsKind(SyntaxKind.OutKeyword))
            {
                if (GetFieldAccessKind(argument.Expression, fieldName, declaringTypeName) != FieldAccessKind.None)
                {
                    return false;
                }
            }
        }

        foreach (var refExpression in scopeNodes.OfType<RefExpressionSyntax>())
        {
            if (GetFieldAccessKind(refExpression.Expression, fieldName, declaringTypeName) != FieldAccessKind.None)
            {
                return false;
            }
        }

        var writeNodes = new List<SyntaxNode>();

        foreach (var assignment in scopeNodes.OfType<AssignmentExpressionSyntax>())
        {
            if (GetFieldAccessKind(assignment.Left, fieldName, declaringTypeName) != FieldAccessKind.None)
            {
                writeNodes.Add(assignment);
            }
        }

        foreach (var unary in scopeNodes.OfType<PostfixUnaryExpressionSyntax>())
        {
            if ((unary.IsKind(SyntaxKind.PostIncrementExpression) || unary.IsKind(SyntaxKind.PostDecrementExpression)) &&
                GetFieldAccessKind(unary.Operand, fieldName, declaringTypeName) != FieldAccessKind.None)
            {
                writeNodes.Add(unary);
            }
        }

        foreach (var unary in scopeNodes.OfType<PrefixUnaryExpressionSyntax>())
        {
            if ((unary.IsKind(SyntaxKind.PreIncrementExpression) || unary.IsKind(SyntaxKind.PreDecrementExpression)) &&
                GetFieldAccessKind(unary.Operand, fieldName, declaringTypeName) != FieldAccessKind.None)
            {
                writeNodes.Add(unary);
            }
        }

        foreach (var writeNode in writeNodes)
        {
            if (!IsWriteInMatchingConstructor(writeNode, typeDecl, isStatic))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Strips all outer parentheses from the given expression, returning the innermost non-parenthesized ExpressionSyntax.
    /// </summary>
    /// <param name="expression">The expression.</param>
    /// <returns>A ExpressionSyntax value produced by this method.</returns>
    private static ExpressionSyntax UnwrapParentheses(ExpressionSyntax expression)
    {
        while (expression is ParenthesizedExpressionSyntax paren)
        {
            expression = paren.Expression;
        }

        return expression;
    }

    /// <summary>
    /// Determines how a field is accessed within a given expression by recursively unwrapping parentheses and inspecting identifier, member-access, element-access, and conditional-access syntax nodes, returning `Direct` for a top-level match on the field name, `SubMember` when the match is nested deeper in the expression chain, and `None` otherwise.
    /// </summary>
    /// <param name="expression">The expression.</param>
    /// <param name="fieldName">The field name.</param>
    /// <param name="declaringTypeName">The declaring type name.</param>
    /// <returns>A FieldAccessKind value produced by this method.</returns>
    private static FieldAccessKind GetFieldAccessKind(ExpressionSyntax expression, string fieldName, string declaringTypeName)
    {
        expression = UnwrapParentheses(expression);
        if (expression is null)
        {
            return FieldAccessKind.None;
        }

        if (expression is IdentifierNameSyntax identifier)
        {
            return identifier.Identifier.Text == fieldName ? FieldAccessKind.Direct : FieldAccessKind.None;
        }

        if (expression is MemberAccessExpressionSyntax memberAccess)
        {
            if (memberAccess.Name.Identifier.Text == fieldName)
            {
                return FieldAccessKind.Direct;
            }

            var leftKind = GetFieldAccessKind(memberAccess.Expression, fieldName, declaringTypeName);
            if (leftKind != FieldAccessKind.None)
            {
                return FieldAccessKind.SubMember;
            }

            return FieldAccessKind.None;
        }

        if (expression is ElementAccessExpressionSyntax elementAccess)
        {
            var leftKind = GetFieldAccessKind(elementAccess.Expression, fieldName, declaringTypeName);
            if (leftKind != FieldAccessKind.None)
            {
                return FieldAccessKind.SubMember;
            }

            return FieldAccessKind.None;
        }

        if (expression is ConditionalAccessExpressionSyntax conditionalAccess)
        {
            var leftKind = GetFieldAccessKind(conditionalAccess.Expression, fieldName, declaringTypeName);
            if (leftKind != FieldAccessKind.None)
            {
                return FieldAccessKind.SubMember;
            }

            return FieldAccessKind.None;
        }

        return FieldAccessKind.None;
    }

    /// <summary>
    /// Determines whether a write occurs inside a constructor of the given type with matching staticness by walking ancestor nodes, returning false if any non-constructor member boundary or type boundary is reached first.
    /// </summary>
    /// <param name="writeNode">The write node.</param>
    /// <param name="typeDecl">The type decl.</param>
    /// <param name="isStatic">The is static.</param>
    /// <returns>A bool value produced by this method.</returns>

    private static bool IsWriteInMatchingConstructor(SyntaxNode writeNode, TypeDeclarationSyntax typeDecl, bool isStatic)
    {
        foreach (var ancestor in writeNode.Ancestors())
        {
            switch (ancestor)
            {
                case AnonymousFunctionExpressionSyntax _:
                case LocalFunctionStatementSyntax _:
                case MethodDeclarationSyntax _:
                case AccessorDeclarationSyntax _:
                case DestructorDeclarationSyntax _:
                case OperatorDeclarationSyntax _:
                case ConversionOperatorDeclarationSyntax _:
                    // Any of these boundaries reached before a constructor means the write
                    // could execute after construction (or in an unrelated member) - unsafe.
                    return false;

                case ConstructorDeclarationSyntax constructor:
                    var constructorIsStatic = constructor.Modifiers.Any(m => m.IsKind(SyntaxKind.StaticKeyword));
                    return ReferenceEquals(constructor.Parent, typeDecl) && constructorIsStatic == isStatic;

                case TypeDeclarationSyntax _:
                    // Reached the type boundary (e.g. a field initializer) without finding a
                    // constructor context - conservatively unsafe.
                    return false;
            }
        }

        return false;
    }

    /// <summary>
    /// Adds a readonly modifier with trailing space to the field declaration&apos;s modifiers and returns the updated syntax node, with no side effects.
    /// </summary>
    /// <param name="fieldDecl">The field decl.</param>
    /// <returns>A FieldDeclarationSyntax value produced by this method.</returns>

    private static FieldDeclarationSyntax WithReadonlyModifier(FieldDeclarationSyntax fieldDecl)
    {
        var readonlyToken = SyntaxFactory.Token(SyntaxKind.ReadOnlyKeyword).WithTrailingTrivia(SyntaxFactory.Space);

        return fieldDecl.WithModifiers(fieldDecl.Modifiers.Add(readonlyToken));
    }
}
