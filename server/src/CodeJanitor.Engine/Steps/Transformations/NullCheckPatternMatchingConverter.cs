#nullable disable
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;
using Microsoft.CodeAnalysis.Text;

namespace CodeJanitor.Engine.Steps.Transformations;

/// <summary>
/// Converts null equality checks (<c>== null</c>, <c>!= null</c>) of a C# file to pattern matching (<c>is null</c>,
/// <c>is not null</c>) where the semantic model proves the conversion keeps the behavior and compiles.
/// </summary>
/// <remarks>
/// A check is converted only when all of these hold:
/// <list type="bullet">
/// <item>it compares with the built-in reference or nullable equality: a user-defined <c>==</c> or <c>!=</c>, declared
/// anywhere (another file, project or referenced assembly, for example <c>UnityEngine.Object</c>) and lifted ones
/// included, may give <c>null</c> a meaning of its own that the <c>is</c> pattern bypasses;</item>
/// <item>the compared operand is known to be of a reference type, <see cref="Nullable{T}" /> or a type parameter not
/// constrained to a value type (<c>is null</c> on a non-nullable value type does not compile, CS0037; a
/// <c>dynamic</c> operand may bind to a user-defined operator at run time);</item>
/// <item>the language version allows it: <c>is null</c> needs C# 7.0, <c>is not null</c> needs C# 9;</item>
/// <item>it is not in an expression-bodied non-async lambda or a query-expression clause, which can become an
/// expression tree where the pattern is rejected (CS8122), nor an operand of another equality (<c>a == b == null</c>),
/// nor a check with <c>null</c> on the left and comments between the operands.</item>
/// </list>
/// A file compiled by several projects or target frameworks is analyzed in each of them, and a check is converted only
/// when it is safe in every one. Pure logic over Roslyn workspace types, unit-testable without Visual Studio.
/// </remarks>
internal sealed class NullCheckPatternMatchingConverter
{
    private readonly Action<string> _reportSkipped;

    /// <summary>
    /// Initializes a new instance of the <see cref="NullCheckPatternMatchingConverter" /> class.
    /// </summary>
    /// <param name="reportSkipped">
    /// Receives a message when <c>!= null</c> checks were left unchanged only because the language version of a project
    /// compiling the file is older than C# 9; null to report nothing. It runs on the thread completing the analysis,
    /// which is not the UI thread: it must not write to the output pane or use any COM object itself.
    /// </param>
    public NullCheckPatternMatchingConverter(Action<string> reportSkipped = null)
    {
        _reportSkipped = reportSkipped;
    }

    /// <summary>
    /// Converts the null checks of the file that are safe to convert in every document of <paramref name="documents" />.
    /// </summary>
    /// <param name="documents">The documents of one file, one per project flavor compiling it, all with the same text.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>The text of the file with the safe null checks converted, or its unchanged text when none is.</returns>
    public async Task<string> ConvertAsync(IReadOnlyList<Document> documents, CancellationToken cancellationToken)
    {
        var inequalitySkipped = false;
        var converted = await ConvertCoreAsync(documents, () => inequalitySkipped = true, cancellationToken).ConfigureAwait(false);
        if (inequalitySkipped)
        {
            _reportSkipped?.Invoke("'!= null' checks were left unchanged: 'is not null' patterns need C# 9, and a project compiling the file uses an older language version.");
        }

        return converted;
    }

    private async Task<string> ConvertCoreAsync(IReadOnlyList<Document> documents, Action onInequalitySkipped, CancellationToken cancellationToken)
    {
        if (documents is null || documents.Count == 0)
        {
            throw new ArgumentException("At least one document is required.", nameof(documents));
        }

        var root = await documents[0].GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false);
        HashSet<TextSpan> convertible = null;

        foreach (var document in documents)
        {
            var safeInDocument = await GetConvertibleAsync(document, onInequalitySkipped, cancellationToken).ConfigureAwait(false);
            if (convertible is null)
            {
                convertible = safeInDocument;
            }
            else
            {
                convertible.IntersectWith(safeInDocument);
            }

            if (convertible.Count == 0)
            {
                return root.ToFullString();
            }
        }

        return new NullCheckRewriter(convertible).Visit(root).ToFullString();
    }

    /// <summary>
    /// Gets the spans of the null checks of <paramref name="document" /> whose conversion keeps the behavior and
    /// compiles in its project.
    /// </summary>
    private static async Task<HashSet<TextSpan>> GetConvertibleAsync(Document document, Action onInequalitySkipped, CancellationToken cancellationToken)
    {
        var convertible = new HashSet<TextSpan>();
        var root = await document.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false);
        var languageVersion = ((CSharpParseOptions)root.SyntaxTree.Options).LanguageVersion;
        if (languageVersion < LanguageVersion.CSharp7)
        {
            return convertible;
        }

        var semanticModel = await document.GetSemanticModelAsync(cancellationToken).ConfigureAwait(false);
        foreach (var check in root.DescendantNodes().OfType<BinaryExpressionSyntax>())
        {
            if (!TryGetComparedOperand(check, out var operand) ||
                !IsSyntacticallyConvertible(check, operand) ||
                !IsReferenceEqualityCheck(check, operand, semanticModel, cancellationToken))
            {
                continue;
            }

            if (check.IsKind(SyntaxKind.NotEqualsExpression) && languageVersion < LanguageVersion.CSharp9)
            {
                onInequalitySkipped();
                continue;
            }

            convertible.Add(check.Span);
        }

        return convertible;
    }

    /// <summary>
    /// Gets the operand compared with the <c>null</c> literal by an <c>==</c> or <c>!=</c> expression.
    /// </summary>
    private static bool TryGetComparedOperand(BinaryExpressionSyntax check, out ExpressionSyntax operand)
    {
        operand = null;
        if (!check.IsKind(SyntaxKind.EqualsExpression) && !check.IsKind(SyntaxKind.NotEqualsExpression))
        {
            return false;
        }

        if (check.Right.IsKind(SyntaxKind.NullLiteralExpression))
        {
            operand = check.Left;
        }
        else if (check.Left.IsKind(SyntaxKind.NullLiteralExpression))
        {
            operand = check.Right;
        }

        return operand is not null;
    }

    /// <summary>
    /// Determines whether the check can be written as a pattern where it is: not in an expression-bodied non-async
    /// lambda or a query-expression clause, not with another equality as its operand, and not with <c>null</c> on the
    /// left and comments or directives between the operands, which the pattern could not keep in place.
    /// </summary>
    private static bool IsSyntacticallyConvertible(BinaryExpressionSyntax check, ExpressionSyntax operand)
    {
        // An unparenthesized operand of == or != can only be another equality: `a == b == null` would become
        // `a == (b is null)`, and parenthesizing it gives `(a == b) is null`, which does not compile for bool (CS0037).
        if (IsUnsafeForPatternMatching(check) ||
            operand.IsKind(SyntaxKind.EqualsExpression) ||
            operand.IsKind(SyntaxKind.NotEqualsExpression))
        {
            return false;
        }

        return check.Right.IsKind(SyntaxKind.NullLiteralExpression) || !HasCommentsBetweenOperands(check);
    }

    /// <summary>Returns whether comments or directives separate the operands of the check from its operator.</summary>
    private static bool HasCommentsBetweenOperands(BinaryExpressionSyntax check) => HasCommentOrDirective(check.Left.GetTrailingTrivia())
            || HasCommentOrDirective(check.OperatorToken.LeadingTrivia)
            || HasCommentOrDirective(check.OperatorToken.TrailingTrivia)
            || HasCommentOrDirective(check.Right.GetLeadingTrivia());

    /// <summary>Returns whether the trivia list contains a comment, directive or other non-whitespace trivia.</summary>
    private static bool HasCommentOrDirective(SyntaxTriviaList trivia) => trivia.Any(t => !t.IsKind(SyntaxKind.WhitespaceTrivia) && !t.IsKind(SyntaxKind.EndOfLineTrivia));

    /// <summary>
    /// Determines whether the given null-check node sits in a syntax position where the C# compiler
    /// could reject an `is`/`is not` pattern-matching operator if the surrounding lambda or query ends up
    /// converted to an Expression tree (CS8122). Block-bodied lambdas, async lambdas, and anonymous methods
    /// can never be compiled to expression trees (CS0834/CS1989/CS1946), so they are always safe; an
    /// expression-bodied non-async lambda or a query-expression clause is conservatively treated as unsafe
    /// (its delegate or expression-tree conversion is not analyzed).
    /// </summary>
    /// <param name="node">The node.</param>
    /// <returns>True if rewriting to a pattern-matching operator here could break compilation; otherwise, false.</returns>
    private static bool IsUnsafeForPatternMatching(SyntaxNode node)
    {
        foreach (var ancestor in node.Ancestors())
        {
            switch (ancestor)
            {
                case LambdaExpressionSyntax lambda:
                    return lambda.ExpressionBody is not null && !lambda.Modifiers.Any(SyntaxKind.AsyncKeyword);

                case QueryClauseSyntax:
                case SelectOrGroupClauseSyntax:
                    return true;

                case AnonymousMethodExpressionSyntax:
                case LocalFunctionStatementSyntax:
                case BaseMethodDeclarationSyntax:
                case AccessorDeclarationSyntax:
                case BasePropertyDeclarationSyntax:
                    return false;
            }
        }

        return false;
    }

    /// <summary>
    /// Determines whether the check uses the built-in reference or nullable equality on an operand that the
    /// <c>is null</c> pattern accepts, and is not a constant expression: an <c>is</c> pattern is never constant, so
    /// it would not compile where a constant is required (const initializers, default parameter values, attribute
    /// arguments, case labels).
    /// </summary>
    private static bool IsReferenceEqualityCheck(BinaryExpressionSyntax check, ExpressionSyntax operand, SemanticModel semanticModel, CancellationToken cancellationToken)
    {
        if (!(semanticModel.GetOperation(check, cancellationToken) is IBinaryOperation operation) ||
            operation.OperatorMethod is not null ||
            semanticModel.GetConstantValue(check, cancellationToken).HasValue)
        {
            return false;
        }

        var type = semanticModel.GetTypeInfo(operand, cancellationToken).Type;
        if (type is ITypeParameterSymbol typeParameter)
        {
            return !typeParameter.HasValueTypeConstraint && !typeParameter.HasUnmanagedTypeConstraint;
        }

        return type is not null &&
            type.TypeKind != TypeKind.Error &&
            type.TypeKind != TypeKind.Dynamic &&
            (type.IsReferenceType || type.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T);
    }

    /// <summary>
    /// A rewriter that converts the given null checks to <c>is</c> or <c>is not</c> patterns, preserving the trivia.
    /// </summary>
    private sealed class NullCheckRewriter : CSharpSyntaxRewriter
    {
        private readonly HashSet<TextSpan> _convertible;

        /// <summary>
        /// Initializes a new instance of the <see cref="NullCheckRewriter" /> class.
        /// </summary>
        /// <param name="convertible">The spans of the null checks the semantic model proved safe to convert.</param>
        internal NullCheckRewriter(HashSet<TextSpan> convertible)
        {
            _convertible = convertible;
        }

        /// <summary>
        /// Overriding a syntax visitor, this method rewrites binary `==`/`!=` expressions where one operand is `null` into equivalent `is` or `is not` pattern expressions, preserving the original trivia.
        /// </summary>
        /// <param name="node">The node.</param>
        /// <returns>A SyntaxNode value produced by this method.</returns>
        public override SyntaxNode VisitBinaryExpression(BinaryExpressionSyntax node)
        {
            var visitedNode = (BinaryExpressionSyntax)base.VisitBinaryExpression(node);

            if (!_convertible.Contains(node.Span))
            {
                return visitedNode;
            }

            var isNotEquals = visitedNode.IsKind(SyntaxKind.NotEqualsExpression);

            ExpressionSyntax targetExpr;

            if (visitedNode.Right.IsKind(SyntaxKind.NullLiteralExpression))
            {
                targetExpr = visitedNode.Left;
            }
            else if (visitedNode.Left.IsKind(SyntaxKind.NullLiteralExpression))
            {
                targetExpr = visitedNode.Right;
            }
            else
            {
                return visitedNode;
            }

            // Comments or directives between the operands are kept in place; the convertible checks have the null
            // literal on the right when there are any (see IsSyntacticallyConvertible).
            var keepInnerTrivia = HasCommentsBetweenOperands(visitedNode);
            if (!keepInnerTrivia)
            {
                targetExpr = targetExpr.WithoutTrivia();
            }

            PatternSyntax pattern;
            var isToken = keepInnerTrivia
                ? SyntaxFactory.Token(visitedNode.OperatorToken.LeadingTrivia, SyntaxKind.IsKeyword, visitedNode.OperatorToken.TrailingTrivia)
                : SyntaxFactory.Token(SyntaxFactory.TriviaList(SyntaxFactory.Space), SyntaxKind.IsKeyword, SyntaxFactory.TriviaList(SyntaxFactory.Space));

            // A comment directly adjacent to the operator must still be separated from the keywords.
            if (keepInnerTrivia && isToken.LeadingTrivia.Count == 0 && visitedNode.Left.GetTrailingTrivia().Count == 0)
            {
                isToken = isToken.WithLeadingTrivia(SyntaxFactory.Space);
            }

            if (keepInnerTrivia && isToken.TrailingTrivia.Count == 0)
            {
                isToken = isToken.WithTrailingTrivia(SyntaxFactory.Space);
            }

            var nullLiteral = SyntaxFactory.LiteralExpression(SyntaxKind.NullLiteralExpression);
            if (keepInnerTrivia)
            {
                nullLiteral = nullLiteral.WithLeadingTrivia(visitedNode.Right.GetLeadingTrivia());
            }

            if (isNotEquals)
            {
                var notToken = SyntaxFactory.Token(
                    SyntaxFactory.TriviaList(),
                    SyntaxKind.NotKeyword,
                    isToken.TrailingTrivia);
                isToken = isToken.WithTrailingTrivia(SyntaxFactory.Space);

                pattern = SyntaxFactory.UnaryPattern(notToken, SyntaxFactory.ConstantPattern(nullLiteral));
            }
            else
            {
                pattern = SyntaxFactory.ConstantPattern(nullLiteral);
            }

            var isPatternExpr = SyntaxFactory.IsPatternExpression(targetExpr, isToken, pattern);
            if (!keepInnerTrivia)
            {
                isPatternExpr = isPatternExpr
                    .WithLeadingTrivia(visitedNode.GetLeadingTrivia())
                    .WithTrailingTrivia(visitedNode.GetTrailingTrivia());
            }
            else
            {
                isPatternExpr = isPatternExpr.WithTrailingTrivia(visitedNode.GetTrailingTrivia());
            }

            return isPatternExpr;
        }
    }
}
