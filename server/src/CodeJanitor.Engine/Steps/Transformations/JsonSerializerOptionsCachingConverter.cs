using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace CodeJanitor.Engine.Steps.Transformations;

/// <summary>
/// CA1869 (cache and reuse <c>JsonSerializerOptions</c> instances): options built only from constants and passed to one
/// <c>System.Text.Json.JsonSerializer</c> call, directly or through a local used nowhere else, move to a
/// <c>private static readonly</c> field of the type declaring the call (<c>JsonOptions</c>, numbered when the name is taken).
/// Options created where the code runs once (a static constructor or static initializer), options whose settings depend on the
/// call, and options outside a class, struct or record body that starts on a line of its own are left as they are.
/// </summary>
internal sealed class JsonSerializerOptionsCachingConverter
{
    private const string BaseName = "JsonOptions";
    private const string DefaultIndent = "    ";

    /// <summary>The text of <paramref name="document"/> with the options it can cache moved to fields.</summary>
    public async Task<string> CacheAsync(Document document, CancellationToken cancellationToken)
    {
        var text = await document.GetTextAsync(cancellationToken).ConfigureAwait(false);
        var root = await document.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false);
        var model = await document.GetSemanticModelAsync(cancellationToken).ConfigureAwait(false);
        var optionsType = model?.Compilation.GetTypeByMetadataName("System.Text.Json.JsonSerializerOptions");
        var serializerType = model?.Compilation.GetTypeByMetadataName("System.Text.Json.JsonSerializer");
        if (root is null || model is null || optionsType is null || serializerType is null)
        {
            return text.ToString();
        }

        var used = root.DescendantTokens().Where(token => token.IsKind(SyntaxKind.IdentifierToken)).Select(token => token.ValueText).ToHashSet(StringComparer.Ordinal);
        var newline = text.ToString().Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n";
        var fields = new Dictionary<TypeDeclarationSyntax, List<string>>();
        var changes = new List<TextChange>();

        foreach (var creation in root.DescendantNodes().OfType<BaseObjectCreationExpressionSyntax>())
        {
            if (!SymbolEqualityComparer.Default.Equals(model.GetTypeInfo(creation, cancellationToken).Type, optionsType)
                || !IsBuiltFromConstants(creation, model, cancellationToken)
                || RunsOnce(creation)
                || FieldOwner(creation) is not { } owner
                || SerializerUse(creation, model, serializerType, cancellationToken) is not { } use)
            {
                continue;
            }

            var name = BaseName;
            for (var index = 1; used.Contains(name) || !model.LookupSymbols(use.Argument.SpanStart, name: name).IsEmpty; index++)
            {
                name = BaseName + index;
            }

            used.Add(name);
            var typeText = optionsType.ToMinimalDisplayString(model, owner.OpenBraceToken.SpanStart);
            if (!fields.TryGetValue(owner, out var declarations))
            {
                fields[owner] = declarations = [];
            }

            declarations.Add($"private static readonly {typeText} {name} = {creation.WithoutTrivia().ToFullString()};");
            changes.Add(new TextChange(use.Argument.Span, name));
            if (use.Declaration is { } declaration)
            {
                changes.Add(new TextChange(LineOrSpanOf(text, declaration), string.Empty));
            }
        }

        foreach (var (owner, declarations) in fields)
        {
            changes.Add(new TextChange(new TextSpan(owner.OpenBraceToken.Span.End, 0), FieldsText(text, owner, declarations, newline)));
        }

        return changes.Count == 0 ? text.ToString() : text.WithChanges(changes).ToString();
    }

    /// <summary>The added fields after the opening brace: blank lines separate a multi-line field, and the last field from a first member that is not a single-line field.</summary>
    private static string FieldsText(SourceText text, TypeDeclarationSyntax owner, List<string> declarations, string newline)
    {
        var first = owner.Members.FirstOrDefault();
        var indent = first is not null ? IndentOf(text, first.SpanStart) : IndentOf(text, owner.SpanStart) + DefaultIndent;
        var lines = string.Concat(declarations.Select((declaration, index) =>
            (index > 0 && declarations[index - 1].Contains('\n', StringComparison.Ordinal) ? newline : string.Empty) + newline + indent + declaration));
        var lastIsMultiLine = declarations[^1].Contains('\n', StringComparison.Ordinal);
        var blank = first is not null && (lastIsMultiLine || first is not FieldDeclarationSyntax || first.ToString().Contains('\n', StringComparison.Ordinal)) ? newline : string.Empty;

        return lines + blank;
    }

    private static string IndentOf(SourceText text, int position)
    {
        var prefix = text.ToString(TextSpan.FromBounds(text.Lines.GetLineFromPosition(position).Start, position));

        return prefix[..(prefix.Length - prefix.TrimStart(' ', '\t').Length)];
    }

    /// <summary>The whole line of a statement alone on its line, otherwise the statement.</summary>
    private static TextSpan LineOrSpanOf(SourceText text, StatementSyntax statement)
    {
        var line = text.Lines.GetLineFromPosition(statement.SpanStart);
        var before = text.ToString(TextSpan.FromBounds(line.Start, statement.SpanStart));
        var after = statement.Span.End <= line.End ? text.ToString(TextSpan.FromBounds(statement.Span.End, line.End)) : null;

        return string.IsNullOrWhiteSpace(before) && after is not null && string.IsNullOrWhiteSpace(after) ? line.SpanIncludingLineBreak : statement.Span;
    }

    /// <summary>The class, struct or record declaring the creation, when its body starts on a line of its own.</summary>
    private static TypeDeclarationSyntax? FieldOwner(SyntaxNode creation)
    {
        var owner = creation.Ancestors().OfType<TypeDeclarationSyntax>().FirstOrDefault();

        return owner is ClassDeclarationSyntax or StructDeclarationSyntax or RecordDeclarationSyntax
            && owner.OpenBraceToken.IsKind(SyntaxKind.OpenBraceToken)
            && !owner.OpenBraceToken.IsMissing
            && owner.OpenBraceToken.TrailingTrivia.Any(trivia => trivia.IsKind(SyntaxKind.EndOfLineTrivia))
            ? owner
            : null;
    }

    /// <summary>Whether the creation runs once per program: in a static constructor or a static field or property initializer.</summary>
    private static bool RunsOnce(SyntaxNode creation)
    {
        foreach (var ancestor in creation.Ancestors())
        {
            switch (ancestor)
            {
                case AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax or AccessorDeclarationSyntax:
                case ArrowExpressionClauseSyntax { Parent: PropertyDeclarationSyntax or IndexerDeclarationSyntax }:
                    return false;
                case ConstructorDeclarationSyntax constructor:
                    return constructor.Modifiers.Any(SyntaxKind.StaticKeyword);
                case BaseMethodDeclarationSyntax:
                    return false;
                case BaseFieldDeclarationSyntax field:
                    return field.Modifiers.Any(SyntaxKind.StaticKeyword) || field.Modifiers.Any(SyntaxKind.ConstKeyword);
                case PropertyDeclarationSyntax property:
                    return property.Modifiers.Any(SyntaxKind.StaticKeyword);
            }
        }

        return false;
    }

    /// <summary>Whether every argument and member the creation sets is a constant or a stateless System.Text.Json value.</summary>
    private static bool IsBuiltFromConstants(BaseObjectCreationExpressionSyntax creation, SemanticModel model, CancellationToken cancellationToken)
    {
        if (creation.ArgumentList?.Arguments.Any(argument => !model.GetConstantValue(argument.Expression, cancellationToken).HasValue) == true)
        {
            return false;
        }

        return creation.Initializer?.Expressions.All(expression =>
            expression is AssignmentExpressionSyntax { Left: IdentifierNameSyntax } assignment
            && (assignment.Right is InitializerExpressionSyntax collection
                ? collection.IsKind(SyntaxKind.CollectionInitializerExpression) && collection.Expressions.All(item => IsStatelessConverter(item, model, cancellationToken))
                : IsStateless(assignment.Right, model, cancellationToken))) != false;
    }

    /// <summary>A constant, or a static property or field of System.Text.Json or System.Text.Encodings.Web (<c>JsonNamingPolicy.CamelCase</c>).</summary>
    private static bool IsStateless(ExpressionSyntax expression, SemanticModel model, CancellationToken cancellationToken) =>
        model.GetConstantValue(expression, cancellationToken).HasValue
        || (expression is MemberAccessExpressionSyntax or IdentifierNameSyntax
            && model.GetSymbolInfo(expression, cancellationToken).Symbol is { IsStatic: true, Kind: SymbolKind.Property or SymbolKind.Field } symbol
            && IsJsonNamespace(symbol.ContainingNamespace));

    /// <summary>A parameterless converter of System.Text.Json.Serialization (<c>new JsonStringEnumConverter()</c>).</summary>
    private static bool IsStatelessConverter(ExpressionSyntax expression, SemanticModel model, CancellationToken cancellationToken) =>
        expression is BaseObjectCreationExpressionSyntax { Initializer: null } creation
        && (creation.ArgumentList is null || creation.ArgumentList.Arguments.Count == 0)
        && model.GetTypeInfo(creation, cancellationToken).Type is { } type
        && type.ContainingNamespace.ToDisplayString() == "System.Text.Json.Serialization";

    private static bool IsJsonNamespace(INamespaceSymbol? symbol)
    {
        var name = symbol?.ToDisplayString();

        return name is "System.Text.Json" or "System.Text.Json.Serialization" or "System.Text.Encodings.Web";
    }

    /// <summary>
    /// The serializer argument the options are: the creation passed to a <c>JsonSerializer</c> method, or the one use of the local
    /// it initializes (with the declaration to remove).
    /// </summary>
    private static (ExpressionSyntax Argument, LocalDeclarationStatementSyntax? Declaration)? SerializerUse(BaseObjectCreationExpressionSyntax creation, SemanticModel model, INamedTypeSymbol serializerType, CancellationToken cancellationToken)
    {
        if (IsSerializerArgument(creation, model, serializerType, cancellationToken))
        {
            return (creation, null);
        }

        if (creation.Parent is not EqualsValueClauseSyntax { Parent: VariableDeclaratorSyntax declarator }
            || declarator.Parent is not VariableDeclarationSyntax { Variables.Count: 1, Parent: LocalDeclarationStatementSyntax statement }
            || statement.Modifiers.Count > 0
            || !statement.UsingKeyword.IsKind(SyntaxKind.None)
            || statement.Parent is not BlockSyntax block
            || model.GetDeclaredSymbol(declarator, cancellationToken) is not ILocalSymbol local)
        {
            return null;
        }

        var references = block.DescendantNodes()
            .OfType<IdentifierNameSyntax>()
            .Where(identifier => identifier.Identifier.ValueText == local.Name && SymbolEqualityComparer.Default.Equals(model.GetSymbolInfo(identifier, cancellationToken).Symbol, local))
            .ToList();

        return references is [var reference] && IsSerializerArgument(reference, model, serializerType, cancellationToken) ? (reference, statement) : null;
    }

    private static bool IsSerializerArgument(ExpressionSyntax expression, SemanticModel model, INamedTypeSymbol serializerType, CancellationToken cancellationToken) =>
        expression.Parent is ArgumentSyntax { RefKindKeyword.RawKind: 0, Parent: ArgumentListSyntax { Parent: InvocationExpressionSyntax invocation } }
        && model.GetSymbolInfo(invocation, cancellationToken).Symbol is IMethodSymbol method
        && SymbolEqualityComparer.Default.Equals(method.ContainingType, serializerType);
}
