#nullable disable
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace CodeJanitor.Engine.Steps.Transformations;

/// <summary>
/// A source transformation that converts string.Format calls with string literals to modern string interpolation ($"...").
/// </summary>
internal sealed class StringInterpolationConverter : ISourceTransformation
{
    // An escaped brace pair ("{{" or "}}") is matched first so that a placeholder-like text inside it stays literal.
    // A placeholder follows the .NET composite format grammar: the index, optional spaces, an optional alignment
    // (spaces allowed around it) and an optional, possibly empty, format.
    private static readonly Regex PlaceholderRegex = new Regex(@"\{\{|\}\}|\{(\d+) *(?:, *(-?\d+) *)?(?::([^{}]*))?\}", RegexOptions.Compiled);

    private static readonly char[] LineBreakCharacters = { '\r', '\n' };

    /// <inheritdoc />
    public string Name => "Convert string.Format to String Interpolation";

    /// <inheritdoc />
    public string Apply(string source)
    {
        if (string.IsNullOrWhiteSpace(source))
        {
            return source;
        }

        return Apply(CSharpSyntaxTree.ParseText(source).GetRoot(), null);
    }

    /// <summary>
    /// Converts the calls of the tree rooted at <paramref name="root" />. With the <paramref name="model" /> of that tree, a
    /// call whose single argument is an array or span passed as the <c>params</c> values is kept: the values listed
    /// there are the elements, which a hole would not format.
    /// </summary>
    public string Apply(SyntaxNode root, SemanticModel model)
    {
        var rewriter = new StringFormatRewriter(model);
        var newRoot = rewriter.Visit(root);

        return newRoot.ToFullString();
    }

    /// <summary>
    /// syntax rewriter that transforms string.Format invocations into interpolated string expressions.
    /// </summary>
    private sealed class StringFormatRewriter(SemanticModel model) : CSharpSyntaxRewriter
    {
        /// <summary>
        /// Whether the single value argument of the call is the <c>params</c> collection itself (an array or span, or
        /// something the model cannot type), not one value: a hole would then format the collection, not its elements.
        /// </summary>
        private bool PassesValuesAsCollection(ExpressionSyntax argument)
        {
            if (model is null)
            {
                return false;
            }

            var type = model.GetTypeInfo(argument).Type;
            if (type is null || type.TypeKind is TypeKind.Error or TypeKind.Dynamic)
            {
                return true;
            }

            var objectArray = model.Compilation.CreateArrayTypeSymbol(model.Compilation.ObjectType);

            return model.Compilation.ClassifyConversion(type, objectArray).IsImplicit || type.Name is "ReadOnlySpan" or "Span";
        }

        /// <summary>
        /// Whether the call, possibly parenthesized or concatenated, is an argument of a method, constructor or indexer
        /// with an overload taking an interpolated string handler (<c>Debug.Assert</c>, <c>Debug.WriteLineIf</c>,
        /// <c>StringBuilder.Append</c>, ...): an interpolated string binds to that overload, whose handler decides whether
        /// and when the holes are evaluated.
        /// </summary>
        private bool CanBindToInterpolatedStringHandler(InvocationExpressionSyntax call)
        {
            if (model is null)
            {
                return false;
            }

            SyntaxNode expression = call;
            while (expression.Parent is ParenthesizedExpressionSyntax || expression.Parent.IsKind(SyntaxKind.AddExpression))
            {
                expression = expression.Parent;
            }

            if (expression.Parent is not ArgumentSyntax { Parent: BaseArgumentListSyntax { Parent: { } target } })
            {
                return false;
            }

            IEnumerable<ISymbol> overloads;
            if (target is InvocationExpressionSyntax invocation)
            {
                overloads = model.GetMemberGroup(invocation.Expression);
            }
            else
            {
                var info = model.GetSymbolInfo(target);
                overloads = (info.Symbol is null ? info.CandidateSymbols : [info.Symbol])
                    .SelectMany(symbol => symbol.ContainingType?.GetMembers(symbol.Name) ?? []);
            }

            return overloads.Any(overload => overload switch
            {
                IMethodSymbol method => method.Parameters.Any(parameter => IsInterpolatedStringHandler(parameter.Type)),
                IPropertySymbol property => property.Parameters.Any(parameter => IsInterpolatedStringHandler(parameter.Type)),
                _ => false,
            });
        }

        private static bool IsInterpolatedStringHandler(ITypeSymbol type) => type.GetAttributes()
            .Any(attribute => attribute.AttributeClass?.ToDisplayString() == "System.Runtime.CompilerServices.InterpolatedStringHandlerAttribute");

        /// <summary>
        /// This CSharpSyntaxRewriter override transforms valid `string.Format` invocations with string-literal format strings and in-range placeholder indices into equivalent interpolated strings, returning the original node unchanged when the call is not a string-format invocation, has fewer than two arguments, has a named argument (which binds by name, not by the position a placeholder index refers to), is an argument where an interpolated string would bind to an interpolated string handler, uses a non-literal format string, or contains out-of-range placeholders.
        /// </summary>
        /// <param name="node">The node.</param>
        /// <returns>A SyntaxNode value produced by this method.</returns>
        public override SyntaxNode VisitInvocationExpression(InvocationExpressionSyntax node)
        {
            var visited = (InvocationExpressionSyntax)base.VisitInvocationExpression(node);

            if (visited.Expression is not MemberAccessExpressionSyntax memberAccess)
            {
                return visited;
            }

            if (memberAccess.Name.Identifier.Text != "Format")
            {
                return visited;
            }

            var caller = memberAccess.Expression.ToString();
            if (caller != "string" && caller != "String" && caller != "System.String")
            {
                return visited;
            }

            var arguments = visited.ArgumentList.Arguments;
            if (arguments.Count < 2)
            {
                return visited;
            }

            if (arguments.Any(argument => argument.NameColon is not null))
            {
                return visited;
            }

            if (CanBindToInterpolatedStringHandler(node))
            {
                return visited;
            }

            if (arguments.Count == 2 && PassesValuesAsCollection(node.ArgumentList.Arguments[1].Expression))
            {
                return visited;
            }

            // Check if first argument is string literal
            if (arguments[0].Expression is not LiteralExpressionSyntax formatLiteral ||
                !formatLiteral.IsKind(SyntaxKind.StringLiteralExpression))
            {
                return visited;
            }

            var formatString = formatLiteral.Token.ValueText;
            var formatArgs = new ExpressionSyntax[arguments.Count - 1];
            for (var i = 1; i < arguments.Count; i++)
            {
                formatArgs[i - 1] = arguments[i].Expression;
            }

            // Check that all placeholder indices are within range of formatArgs, and that each referenced argument
            // fits on one line: a line break inside an interpolation hole of a regular interpolated string needs C# 11.
            var matches = PlaceholderRegex.Matches(formatString);
            var placeholderCount = 0;

            foreach (Match match in matches)
            {
                if (!match.Groups[1].Success)
                {
                    continue; // escaped brace, copied as literal text
                }

                placeholderCount++;
                if (int.TryParse(match.Groups[1].Value, out var idx))
                {
                    if (idx < 0 || idx >= formatArgs.Length)
                    {
                        return visited; // Invalid index or mismatch, keep original
                    }

                    if (formatArgs[idx].ToString().IndexOfAny(LineBreakCharacters) >= 0)
                    {
                        return visited;
                    }
                }
                else
                {
                    return visited;
                }
            }

            if (placeholderCount == 0)
            {
                return visited;
            }

            var originalArguments = node.ArgumentList.Arguments;
            var repeatable = formatArgs
                .Select((argument, index) => IsRepeatable(argument, originalArguments[index + 1].Expression))
                .ToArray();
            if (!PreservesEvaluation(formatArgs, repeatable, matches) || LosesComments(visited, formatArgs, matches))
            {
                return visited;
            }

            // Build interpolated string components
            var builder = new System.Text.StringBuilder();
            builder.Append("$\"");

            var lastIndex = 0;
            foreach (Match match in matches)
            {
                if (!match.Groups[1].Success)
                {
                    continue; // escaped brace: stays part of the surrounding literal text, where it is escaped the same way
                }

                // Text before match
                if (match.Index > lastIndex)
                {
                    var textSegment = formatString.Substring(lastIndex, match.Index - lastIndex);
                    if (ContainsUnescapedBrace(textSegment))
                    {
                        return visited; // a brace the placeholder grammar does not accept would become an interpolation hole
                    }

                    builder.Append(EscapeForInterpolatedString(textSegment));
                }

                var argIndex = int.Parse(match.Groups[1].Value);
                var argExpr = formatArgs[argIndex].ToString();
                var alignment = match.Groups[2].Success ? "," + match.Groups[2].Value : string.Empty;
                var formatSpecifier = match.Groups[3].Length > 0 ? ":" + EscapeForInterpolatedString(match.Groups[3].Value) : string.Empty;

                // A top-level ':' in a hole starts the format clause, so a conditional expression or an alias-qualified
                // name (global::X) must be parenthesized.
                if (formatArgs[argIndex] is ConditionalExpressionSyntax
                    || formatArgs[argIndex].DescendantNodesAndSelf().Any(n => n is AliasQualifiedNameSyntax))
                {
                    argExpr = "(" + argExpr + ")";
                }

                builder.Append('{');
                builder.Append(argExpr);
                builder.Append(alignment);
                builder.Append(formatSpecifier);
                builder.Append('}');

                lastIndex = match.Index + match.Length;
            }

            if (lastIndex < formatString.Length)
            {
                var textSegment = formatString.Substring(lastIndex);
                if (ContainsUnescapedBrace(textSegment))
                {
                    return visited;
                }

                builder.Append(EscapeForInterpolatedString(textSegment));
            }

            builder.Append('\"');

            var interpolatedText = builder.ToString();
            var parsedExpr = SyntaxFactory.ParseExpression(interpolatedText);

            // ParseExpression stops at the first token it cannot use; keep the call when any text was dropped or misparsed.
            if (parsedExpr.ContainsDiagnostics || parsedExpr.FullSpan.Length != interpolatedText.Length)
            {
                return visited;
            }

            return parsedExpr
                .WithLeadingTrivia(visited.GetLeadingTrivia())
                .WithTrailingTrivia(visited.GetTrailingTrivia());
        }

        /// <summary>
        /// Determines whether moving the arguments into the interpolation holes keeps the program's behaviour:
        /// <list type="bullet">
        /// <item>every argument that is not repeatable (see <see cref="IsRepeatable" />) is evaluated exactly once and in
        /// its original order: any other expression, an unqualified name included, may run a property getter;</item>
        /// <item>a local or parameter is not read on the other side of an argument that assigns, increments or passes it
        /// by reference than it was originally;</item>
        /// <item>every hole before an argument that can change state (a call, an object creation, an assignment, an
        /// increment or decrement, an await) is a literal: <c>string.Format</c> formats the arguments after evaluating all
        /// of them, while an interpolated string formats each hole before evaluating the next, so the change could show
        /// in the text of an earlier hole.</item>
        /// </list>
        /// Repeatable arguments may otherwise be repeated, reordered or dropped.
        /// </summary>
        /// <remarks>
        /// Without a semantic model a local may still be changed by a called method through a closure or a reference,
        /// which is not detected.
        /// </remarks>
        private static bool PreservesEvaluation(ExpressionSyntax[] formatArgs, bool[] repeatable, MatchCollection matches)
        {
            var holes = matches.Cast<Match>()
                .Where(match => match.Groups[1].Success)
                .Select(match => int.Parse(match.Groups[1].Value))
                .ToList();
            var useCounts = new int[formatArgs.Length];
            var lastEvaluatedOnce = -1;
            var earlierHoleIsFormatted = false;
            foreach (var index in holes)
            {
                if (earlierHoleIsFormatted && CanChangeState(formatArgs[index]))
                {
                    return false;
                }

                earlierHoleIsFormatted |= !(formatArgs[index] is LiteralExpressionSyntax);
                useCounts[index]++;
                if (repeatable[index])
                {
                    continue;
                }

                if (useCounts[index] > 1 || index < lastEvaluatedOnce)
                {
                    return false;
                }

                lastEvaluatedOnce = index;
            }

            for (var i = 0; i < formatArgs.Length; i++)
            {
                if (useCounts[i] == 0 && !repeatable[i])
                {
                    return false;
                }
            }

            for (var writerIndex = 0; writerIndex < formatArgs.Length; writerIndex++)
            {
                var writtenNames = GetWrittenIdentifiers(formatArgs[writerIndex]);
                if (writtenNames.Count == 0)
                {
                    continue;
                }

                var writerHole = holes.IndexOf(writerIndex);
                for (var hole = 0; hole < holes.Count; hole++)
                {
                    var readerIndex = holes[hole];
                    if (formatArgs[readerIndex] is IdentifierNameSyntax reader &&
                        writtenNames.Contains(reader.Identifier.ValueText) &&
                        (readerIndex < writerIndex) != (hole < writerHole))
                    {
                        return false;
                    }
                }
            }

            return true;
        }

        /// <summary>
        /// Determines whether evaluating the argument has no effect and always gives the same value between two
        /// evaluations that no other argument separates: a literal, <c>this</c>, or the name of a local or parameter in
        /// scope. Any other name may be a property, whose getter can do anything.
        /// </summary>
        /// <param name="argument">The argument as rewritten so far.</param>
        /// <param name="originalArgument">The same argument in the analyzed tree, whose ancestors are the scopes.</param>
        private static bool IsRepeatable(ExpressionSyntax argument, ExpressionSyntax originalArgument) => argument is LiteralExpressionSyntax ||
                argument is ThisExpressionSyntax ||
                (originalArgument is IdentifierNameSyntax identifier && IsLocalOrParameter(identifier));

        /// <summary>
        /// Determines whether the identifier names a parameter of a function that contains it, the <c>value</c> of an
        /// accessor, or a local whose scope contains it and that is declared before it.
        /// </summary>
        private static bool IsLocalOrParameter(IdentifierNameSyntax identifier)
        {
            var name = identifier.Identifier.ValueText;
            var position = identifier.SpanStart;

            foreach (var ancestor in identifier.Ancestors())
            {
                if (ancestor is BaseTypeDeclarationSyntax)
                {
                    return false;
                }

                if (DeclaresParameter(ancestor, name) || DeclaresLocal(ancestor, name, position))
                {
                    return true;
                }
            }

            return false;
        }

        private static bool DeclaresParameter(SyntaxNode node, string name)
        {
            switch (node)
            {
                case BaseMethodDeclarationSyntax method:
                    return HasParameter(method.ParameterList, name);

                case LocalFunctionStatementSyntax localFunction:
                    return HasParameter(localFunction.ParameterList, name);

                case ParenthesizedLambdaExpressionSyntax lambda:
                    return HasParameter(lambda.ParameterList, name);

                case SimpleLambdaExpressionSyntax lambda:
                    return lambda.Parameter.Identifier.ValueText == name;

                case AnonymousMethodExpressionSyntax anonymousMethod:
                    return HasParameter(anonymousMethod.ParameterList, name);

                case IndexerDeclarationSyntax indexer:
                    return HasParameter(indexer.ParameterList, name);

                case AccessorDeclarationSyntax accessor:
                    return name == "value" && !accessor.IsKind(SyntaxKind.GetAccessorDeclaration);

                default:
                    return false;
            }
        }

        private static bool HasParameter(BaseParameterListSyntax parameterList, string name) => parameterList is not null && parameterList.Parameters.Any(parameter => parameter.Identifier.ValueText == name);

        /// <summary>
        /// Determines whether <paramref name="scope" /> declares a local named <paramref name="name" /> before
        /// <paramref name="position" /> whose scope is <paramref name="scope" />: a declaration statement or an
        /// expression variable (pattern, <c>out var</c>, deconstruction) of a block, switch section or expression body,
        /// the variable of a loop, <c>using</c> or <c>fixed</c> statement, of a <c>catch</c> clause, or of a query.
        /// </summary>
        private static bool DeclaresLocal(SyntaxNode scope, string name, int position)
        {
            switch (scope)
            {
                case ForEachStatementSyntax forEach:
                    return forEach.Identifier.ValueText == name;

                case ForEachVariableStatementSyntax forEachVariable:
                    return DeclaresExpressionVariable(forEachVariable.Variable, scope, name, position);

                case ForStatementSyntax forStatement:
                    return DeclaresVariable(forStatement.Declaration, name) ||
                        forStatement.Initializers.Any(initializer => DeclaresExpressionVariable(initializer, scope, name, position));
                case UsingStatementSyntax usingStatement:
                    return DeclaresVariable(usingStatement.Declaration, name);

                case FixedStatementSyntax fixedStatement:
                    return DeclaresVariable(fixedStatement.Declaration, name);

                case CatchClauseSyntax catchClause:
                    return catchClause.Declaration?.Identifier.ValueText == name;

                case QueryExpressionSyntax query:
                    return query.FromClause.Identifier.ValueText == name ||
                        query.DescendantNodes().Any(node =>
                            (node is FromClauseSyntax from && from.Identifier.ValueText == name) ||
                            (node is LetClauseSyntax let && let.Identifier.ValueText == name) ||
                            (node is JoinClauseSyntax join && (join.Identifier.ValueText == name || join.Into?.Identifier.ValueText == name)) ||
                            (node is QueryContinuationSyntax continuation && continuation.Identifier.ValueText == name));
                case BlockSyntax _:
                case SwitchSectionSyntax _:
                case ArrowExpressionClauseSyntax _:
                case LambdaExpressionSyntax _:
                    return scope.ChildNodes()
                        .OfType<LocalDeclarationStatementSyntax>()
                        .Any(statement => statement.SpanStart < position && DeclaresVariable(statement.Declaration, name)) ||
                        DeclaresExpressionVariable(scope, scope, name, position);
                default:
                    return false;
            }
        }

        private static bool DeclaresVariable(VariableDeclarationSyntax declaration, string name) => declaration is not null && declaration.Variables.Any(variable => variable.Identifier.ValueText == name);

        /// <summary>
        /// Determines whether <paramref name="node" /> contains, before <paramref name="position" />, an expression
        /// variable named <paramref name="name" /> whose nearest enclosing scope is <paramref name="scope" />.
        /// </summary>
        private static bool DeclaresExpressionVariable(SyntaxNode node, SyntaxNode scope, string name, int position) => node.DescendantNodes()
                .OfType<SingleVariableDesignationSyntax>()
                .Any(designation =>
                    designation.SpanStart < position &&
                    designation.Identifier.ValueText == name &&
                    designation.Ancestors().FirstOrDefault(IsExpressionVariableScope) == scope);

        private static bool IsExpressionVariableScope(SyntaxNode node) => node is BlockSyntax ||
                node is SwitchSectionSyntax ||
                node is ArrowExpressionClauseSyntax ||
                node is LambdaExpressionSyntax ||
                node is ForEachVariableStatementSyntax ||
                node is ForStatementSyntax ||
                node is MemberDeclarationSyntax;

        /// <summary>
        /// Determines whether evaluating the expression can change the state of objects: it calls a method, creates
        /// an object, assigns, increments, decrements or awaits.
        /// </summary>
        private static bool CanChangeState(ExpressionSyntax expression) => expression.DescendantNodesAndSelf().Any(node =>
                                                                                        node is InvocationExpressionSyntax ||
                                                                                        node is BaseObjectCreationExpressionSyntax ||
                                                                                        node is AssignmentExpressionSyntax ||
                                                                                        node is AwaitExpressionSyntax ||
                                                                                        node.IsKind(SyntaxKind.PreIncrementExpression) ||
                                                                                        node.IsKind(SyntaxKind.PreDecrementExpression) ||
                                                                                        node.IsKind(SyntaxKind.PostIncrementExpression) ||
                                                                                        node.IsKind(SyntaxKind.PostDecrementExpression));

        /// <summary>
        /// Collects the names of the identifiers an expression assigns, increments, decrements or passes by reference.
        /// </summary>
        private static HashSet<string> GetWrittenIdentifiers(ExpressionSyntax expression)
        {
            var names = new HashSet<string>();
            foreach (var node in expression.DescendantNodesAndSelf())
            {
                SyntaxNode target = node switch
                {
                    AssignmentExpressionSyntax assignment => assignment.Left,
                    PrefixUnaryExpressionSyntax prefix when prefix.IsKind(SyntaxKind.PreIncrementExpression) || prefix.IsKind(SyntaxKind.PreDecrementExpression) => prefix.Operand,
                    PostfixUnaryExpressionSyntax postfix when postfix.IsKind(SyntaxKind.PostIncrementExpression) || postfix.IsKind(SyntaxKind.PostDecrementExpression) => postfix.Operand,
                    ArgumentSyntax argument when argument.RefKindKeyword.IsKind(SyntaxKind.RefKeyword) || argument.RefKindKeyword.IsKind(SyntaxKind.OutKeyword) => argument.Expression,
                    _ => null
                };

                if (target is null)
                {
                    continue;
                }

                foreach (var identifier in target.DescendantNodesAndSelf().OfType<IdentifierNameSyntax>())
                {
                    names.Add(identifier.Identifier.ValueText);
                }
            }

            return names;
        }

        /// <summary>
        /// Determines whether the call contains a comment or directive that the rewrite would delete: everything
        /// inside the call except the text of the arguments that are moved into the interpolated string.
        /// </summary>
        private static bool LosesComments(InvocationExpressionSyntax call, ExpressionSyntax[] formatArgs, MatchCollection matches)
        {
            var keptSpans = matches.Cast<Match>()
                .Where(match => match.Groups[1].Success)
                .Select(match => formatArgs[int.Parse(match.Groups[1].Value)].Span)
                .ToList();

            return call.DescendantTrivia(call.Span).Any(trivia =>
                !trivia.IsKind(SyntaxKind.WhitespaceTrivia) &&
                !trivia.IsKind(SyntaxKind.EndOfLineTrivia) &&
                !keptSpans.Any(span => span.Contains(trivia.Span)));
        }

        /// <summary>
        /// Determines whether the literal text contains a brace that is not part of an escaped pair (<c>{{</c> or
        /// <c>}}</c>).
        /// </summary>
        /// <param name="text">The literal text between placeholders.</param>
        /// <returns><see langword="true" /> when an unescaped brace is present.</returns>
        private static bool ContainsUnescapedBrace(string text)
        {
            for (var i = 0; i < text.Length; i++)
            {
                var c = text[i];
                if (c != '{' && c != '}')
                {
                    continue;
                }

                if (i + 1 < text.Length && text[i + 1] == c)
                {
                    i++;
                    continue;
                }

                return true;
            }

            return false;
        }

        /// <summary>
        /// Escapes a string for use in an interpolated string: backslashes, double quotes, carriage returns, line feeds and
        /// tabs get their escape sequence, and the other characters that would not show as themselves in the file (control
        /// and format characters, line and paragraph separators, unassigned code points, surrogates not part of a pair)
        /// are written as <c>\uXXXX</c>.
        /// </summary>
        /// <param name="text">The text.</param>
        /// <returns>The text as it is written between the quotes of an interpolated string.</returns>
        private static string EscapeForInterpolatedString(string text)
        {
            var builder = new System.Text.StringBuilder(text.Length);
            for (var i = 0; i < text.Length; i++)
            {
                var c = text[i];
                switch (c)
                {
                    case '\\':
                        builder.Append("\\\\");
                        continue;
                    case '"':
                        builder.Append("\\\"");
                        continue;
                    case '\r':
                        builder.Append("\\r");
                        continue;
                    case '\n':
                        builder.Append("\\n");
                        continue;
                    case '\t':
                        builder.Append("\\t");
                        continue;
                }

                if (char.IsHighSurrogate(c) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1]))
                {
                    builder.Append(c).Append(text[i + 1]);
                    i++;
                }
                else if (IsInvisible(c))
                {
                    builder.Append("\\u").Append(((int)c).ToString("X4", System.Globalization.CultureInfo.InvariantCulture));
                }
                else
                {
                    builder.Append(c);
                }
            }

            return builder.ToString();
        }

        private static bool IsInvisible(char c) => char.GetUnicodeCategory(c) is System.Globalization.UnicodeCategory.Control
            or System.Globalization.UnicodeCategory.Format
            or System.Globalization.UnicodeCategory.LineSeparator
            or System.Globalization.UnicodeCategory.ParagraphSeparator
            or System.Globalization.UnicodeCategory.OtherNotAssigned
            or System.Globalization.UnicodeCategory.Surrogate;
    }
}
