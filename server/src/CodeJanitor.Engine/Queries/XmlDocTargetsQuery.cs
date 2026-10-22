using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using CodeJanitor.Engine.Contracts;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace CodeJanitor.Engine.Queries;

/// <summary>
/// <c>xmlDocTargets</c>: the members without XML documentation that the AI XML documentation command documents, in
/// declaration order. Arguments, the
/// <c>codeJanitor.ai.xmlDoc.*</c> filters:
/// <c>{ maxMembersPerFile, maxInputCharsPerMember, ignoreGeneratedCode, ignoreObsolete, ignoreTestMethods, ignorePattern }</c>;
/// <c>maxMembersPerFile</c> caps only the members that need a model request (methods, constructors, types).
/// Result, an array of:
/// <code>
/// { "name": string, "kind": "method"|"constructor"|"class"|"struct"|"record"|"interface"|"enum"|"property"|"field"|"indexer"|"event",
///   "text": string,              // the member, attributes included, truncated to maxInputCharsPerMember
///   "insertionLine": int,        // 0-based line of the member's first token (attributes included): the block goes before it
///   "indent": string,            // the leading whitespace of that line
///   "signature": string,         // the declaration from its modifiers up to its body, whitespace collapsed
///   "body": string,              // a method's or constructor's body or expression body, trimmed; "" otherwise
///   "parameters": [{ "name": string, "type": string }],   // methods, constructors, a record's primary constructor
///   "typeParameters": string[],
///   "returnType": string|null,   // a method's return type, "void" included
///   "containingType": { "name": string, "kind": string }|null,
///   "exceptions": string[],      // thrown `new X(...)` types and the ThrowIf* helpers' exceptions
///   "accessors": { "get": bool, "set": bool }|null,       // properties; init counts as set, an expression body as get
///   "baseTypes": string[], "members": string[], "modifiers": string[] }  // types: base list, "Name (Type)" / "Name()" / names, modifiers
/// </code>
/// </summary>
public sealed partial class XmlDocTargetsQuery : IDocumentQuery
{
    private static readonly string[] TestAttributes = ["TestMethod", "Fact", "Theory", "Test", "TestCase", "DataTestMethod"];
    private static readonly TimeSpan IgnoreTimeout = TimeSpan.FromSeconds(1);

    public string Name => "xmlDocTargets";

    public async Task<JsonNode?> QueryAsync(Document document, IEffectiveSettings settings, JsonObject? arguments, CancellationToken cancellationToken)
    {
        var root = await document.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false);
        var text = await document.GetTextAsync(cancellationToken).ConfigureAwait(false);
        if (root is null || string.IsNullOrWhiteSpace(text.ToString()))
        {
            return new JsonArray();
        }

        var options = Options.From(arguments);

        return new JsonArray([.. SelectTargets(root, options).Select(member => (JsonNode?)Describe(member, text, options))]);
    }

    internal sealed record Options(int MaxMembersPerFile, int MaxInputCharsPerMember, bool IgnoreGeneratedCode, bool IgnoreObsolete, bool IgnoreTestMethods, string IgnorePattern)
    {
        public static Options From(JsonObject? arguments)
        {
            int Int(string key, int fallback) => arguments?[key] is not JsonValue value
                ? fallback
                : value.TryGetValue<int>(out var whole) ? whole : value.TryGetValue<double>(out var number) ? (int)number : fallback;
            bool Bool(string key) => arguments?[key] is JsonValue value && value.TryGetValue<bool>(out var flag) && flag;

            var max = Int("maxMembersPerFile", 25);

            return new Options(
                max > 0 ? max : 25,
                Int("maxInputCharsPerMember", 2500),
                Bool("ignoreGeneratedCode"),
                Bool("ignoreObsolete"),
                Bool("ignoreTestMethods"),
                arguments?["ignorePattern"] is JsonValue pattern && pattern.TryGetValue<string>(out var text) ? ValidPattern(text) : string.Empty);
        }

        private static string ValidPattern(string pattern)
        {
            if (!string.IsNullOrWhiteSpace(pattern))
            {
                RequireValidIgnorePattern(pattern);
            }

            return pattern;
        }
    }

    /// <summary>The documentable members in declaration order; the budget applies only to the members that need a model request.</summary>
    internal static List<MemberDeclarationSyntax> SelectTargets(SyntaxNode root, Options options)
    {
        var eligible = root.DescendantNodes().OfType<MemberDeclarationSyntax>().Where(IsDocumentable).Where(member => CanDocument(member, options)).ToList();
        var ai = eligible.Where(RequiresAi).Take(options.MaxMembersPerFile).ToHashSet();

        return eligible.Where(member => !RequiresAi(member) || ai.Contains(member)).ToList();
    }

    private static bool IsDocumentable(MemberDeclarationSyntax member) =>
        member is MethodDeclarationSyntax or ConstructorDeclarationSyntax or ClassDeclarationSyntax or StructDeclarationSyntax or RecordDeclarationSyntax
            or InterfaceDeclarationSyntax or EnumDeclarationSyntax or PropertyDeclarationSyntax or FieldDeclarationSyntax or IndexerDeclarationSyntax
            or EventDeclarationSyntax or EventFieldDeclarationSyntax;

    /// <summary>Property, field, indexer and event wording is formulaic, so it never costs a model request.</summary>
    private static bool RequiresAi(MemberDeclarationSyntax member) => member is MethodDeclarationSyntax or ConstructorDeclarationSyntax or BaseTypeDeclarationSyntax;

    private static bool CanDocument(MemberDeclarationSyntax member, Options options)
    {
        switch (member)
        {
            case MethodDeclarationSyntax method:
                return !IsInInterface(method)
                    && !HasModifier(method, SyntaxKind.AbstractKeyword, SyntaxKind.ExternKeyword)
                    && (method.Body is not null || method.ExpressionBody is not null)
                    && CommonFilters(method, options)
                    && !(options.IgnoreTestMethods && (HasAttribute(method, TestAttributes) || IsLikelyTestType(ContainingType(method))))
                    && !MatchesIgnorePattern(method, options.IgnorePattern);

            case ConstructorDeclarationSyntax constructor:
                return !HasModifier(constructor, SyntaxKind.StaticKeyword, SyntaxKind.ExternKeyword)
                    && (constructor.Body is not null || constructor.ExpressionBody is not null)
                    && CommonFilters(constructor, options)
                    && !(options.IgnoreTestMethods && IsLikelyTestType(ContainingType(constructor)))
                    && !MatchesIgnorePattern(constructor, options.IgnorePattern);
        }

        if (IsInInterface(member) && member is not InterfaceDeclarationSyntax)
        {
            return false;
        }

        if (member is FieldDeclarationSyntax field
            && (field.Declaration.Variables.Count == 0 || !HasModifier(field, SyntaxKind.PublicKeyword, SyntaxKind.InternalKeyword, SyntaxKind.ProtectedKeyword, SyntaxKind.ConstKeyword)))
        {
            return false;
        }

        if (options.IgnoreTestMethods && member is BaseTypeDeclarationSyntax type && IsLikelyTestType(type))
        {
            return false;
        }

        return CommonFilters(member, options);
    }

    private static bool CommonFilters(MemberDeclarationSyntax member, Options options) =>
        !HasDocumentation(member)
        && !(options.IgnoreObsolete && HasAttribute(member, ["Obsolete"]))
        && !(options.IgnoreGeneratedCode && (HasAttribute(member, ["GeneratedCode", "CompilerGenerated"]) || ContainingType(member) is { } owner && HasAttribute(owner, ["GeneratedCode", "CompilerGenerated"])));

    private static bool HasDocumentation(MemberDeclarationSyntax member) =>
        member.GetLeadingTrivia().Any(trivia => trivia.IsKind(SyntaxKind.SingleLineDocumentationCommentTrivia) || trivia.IsKind(SyntaxKind.MultiLineDocumentationCommentTrivia));

    private static bool IsInInterface(MemberDeclarationSyntax member) => member.Parent is InterfaceDeclarationSyntax;

    private static BaseTypeDeclarationSyntax? ContainingType(MemberDeclarationSyntax member) => member.Parent as BaseTypeDeclarationSyntax;

    private static bool HasModifier(MemberDeclarationSyntax member, params SyntaxKind[] kinds) => member.Modifiers.Any(modifier => kinds.Contains(modifier.Kind()));

    /// <summary>An attribute named one of <paramref name="names"/>, compared case-insensitively without namespace or <c>Attribute</c> suffix.</summary>
    private static bool HasAttribute(MemberDeclarationSyntax member, IReadOnlyCollection<string> names) =>
        member.AttributeLists.SelectMany(list => list.Attributes).Any(attribute =>
        {
            var name = attribute.Name.ToString().Split('.')[^1].Split("::")[^1];
            if (name.EndsWith("Attribute", StringComparison.Ordinal))
            {
                name = name[..^"Attribute".Length];
            }

            return names.Any(candidate => string.Equals(candidate, name, StringComparison.OrdinalIgnoreCase));
        });

    private static bool IsLikelyTestType(BaseTypeDeclarationSyntax? type) =>
        type is not null && (TestTypeName().IsMatch(type.Identifier.ValueText) || HasAttribute(type, TestAttributes));

    private static bool MatchesIgnorePattern(MemberDeclarationSyntax member, string pattern)
    {
        if (string.IsNullOrWhiteSpace(pattern))
        {
            return false;
        }

        var typeName = ContainingType(member)?.Identifier.ValueText ?? string.Empty;
        var namespaceName = member.Ancestors().OfType<BaseNamespaceDeclarationSyntax>().FirstOrDefault()?.Name.ToString() ?? string.Empty;
        var memberName = member switch
        {
            MethodDeclarationSyntax method => method.Identifier.ValueText,
            ConstructorDeclarationSyntax constructor => constructor.Identifier.ValueText,
            _ => string.Empty,
        };
        var fullName = namespaceName.Length > 0 ? $"{namespaceName}.{typeName}.{memberName}" : $"{typeName}.{memberName}";

        try
        {
            return Regex.IsMatch(fullName, pattern, RegexOptions.IgnoreCase, IgnoreTimeout);
        }
        catch (RegexMatchTimeoutException)
        {
            throw new ArgumentException($"The ignore pattern '{pattern}' took more than a second to test '{fullName}'.", nameof(pattern));
        }
    }

    private static void RequireValidIgnorePattern(string pattern)
    {
        try
        {
            _ = new Regex(pattern, RegexOptions.IgnoreCase, IgnoreTimeout);
        }
        catch (ArgumentException exception)
        {
            throw new ArgumentException($"The ignore pattern '{pattern}' is not a valid regular expression: {exception.Message}", nameof(pattern), exception);
        }
    }

    private static JsonObject Describe(MemberDeclarationSyntax member, SourceText text, Options options)
    {
        var line = text.Lines.GetLineFromPosition(member.SpanStart);
        var lineText = line.ToString();
        var memberText = text.ToString(member.Span);
        var containing = ContainingType(member);

        return new JsonObject
        {
            ["name"] = member is IndexerDeclarationSyntax ? "this[]" : QuerySyntax.NameOf(member),
            ["kind"] = KindOf(member),
            ["text"] = memberText.Length <= options.MaxInputCharsPerMember ? memberText : memberText[..Math.Max(0, options.MaxInputCharsPerMember)] + "...",
            ["insertionLine"] = line.LineNumber,
            ["indent"] = lineText[..(lineText.Length - lineText.TrimStart(' ', '\t').Length)],
            ["signature"] = QuerySyntax.Signature(member),
            ["body"] = QuerySyntax.Body(member),
            ["parameters"] = QuerySyntax.Parameters(member switch
            {
                BaseMethodDeclarationSyntax method => method.ParameterList,
                RecordDeclarationSyntax record => record.ParameterList,
                _ => null,
            }),
            ["typeParameters"] = QuerySyntax.Strings(QuerySyntax.TypeParameters(member)),
            ["returnType"] = member is MethodDeclarationSyntax returning ? returning.ReturnType.ToString() : null,
            ["containingType"] = containing is null ? null : new JsonObject { ["name"] = containing.Identifier.ValueText, ["kind"] = QuerySyntax.TypeKind(containing) },
            ["exceptions"] = QuerySyntax.Strings(member is BaseMethodDeclarationSyntax ? ThrownExceptions(member) : []),
            ["accessors"] = member is PropertyDeclarationSyntax property ? Accessors(property) : null,
            ["baseTypes"] = QuerySyntax.Strings(member is BaseTypeDeclarationSyntax { BaseList: { } baseList } ? baseList.Types.Select(type => type.ToString()) : []),
            ["members"] = QuerySyntax.Strings(member is BaseTypeDeclarationSyntax type ? TypeMembers(type) : []),
            ["modifiers"] = QuerySyntax.Strings(member is BaseTypeDeclarationSyntax ? member.Modifiers.Select(modifier => modifier.Text) : []),
        };
    }

    private static string KindOf(MemberDeclarationSyntax member) => member switch
    {
        MethodDeclarationSyntax => "method",
        ConstructorDeclarationSyntax => "constructor",
        BaseTypeDeclarationSyntax type => QuerySyntax.TypeKind(type),
        PropertyDeclarationSyntax => "property",
        IndexerDeclarationSyntax => "indexer",
        FieldDeclarationSyntax => "field",
        _ => "event",
    };

    /// <summary>The exceptions a member throws: <c>throw new X(...)</c> and the <c>ThrowIf*</c> guard helpers.</summary>
    private static IEnumerable<string> ThrownExceptions(MemberDeclarationSyntax member)
    {
        var exceptions = new List<string>();
        void Add(string type)
        {
            if (!exceptions.Contains(type))
            {
                exceptions.Add(type);
            }
        }

        foreach (var node in member.DescendantNodes())
        {
            switch (node)
            {
                case ThrowStatementSyntax { Expression: ObjectCreationExpressionSyntax creation }:
                    Add(creation.Type.ToString());
                    break;
                case ThrowExpressionSyntax { Expression: ObjectCreationExpressionSyntax creation }:
                    Add(creation.Type.ToString());
                    break;
                case InvocationExpressionSyntax invocation:
                    var name = invocation.Expression.ToString();
                    if (name.Contains("ThrowIfNullOrEmpty", StringComparison.OrdinalIgnoreCase) || name.Contains("ThrowIfNullOrWhiteSpace", StringComparison.OrdinalIgnoreCase))
                    {
                        Add("ArgumentException");
                    }
                    else if (name.Contains("ThrowIfNull", StringComparison.OrdinalIgnoreCase))
                    {
                        Add("ArgumentNullException");
                    }
                    else if (name.Contains("ThrowIfNegative", StringComparison.OrdinalIgnoreCase))
                    {
                        Add("ArgumentOutOfRangeException");
                    }

                    break;
            }
        }

        return exceptions;
    }

    private static JsonObject Accessors(PropertyDeclarationSyntax property)
    {
        var accessors = property.AccessorList?.Accessors ?? default;
        var get = accessors.Any(accessor => accessor.IsKind(SyntaxKind.GetAccessorDeclaration)) || property.ExpressionBody is not null;
        var set = accessors.Any(accessor => accessor.IsKind(SyntaxKind.SetAccessorDeclaration) || accessor.IsKind(SyntaxKind.InitAccessorDeclaration));

        return new JsonObject { ["get"] = get, ["set"] = set };
    }

    /// <summary>A type's parameters and members: <c>Name (Type)</c> for parameters and properties, <c>Name()</c> for methods and constructors, the names of fields and enum members.</summary>
    private static IEnumerable<string> TypeMembers(BaseTypeDeclarationSyntax type)
    {
        if (type is TypeDeclarationSyntax { ParameterList: { } parameters })
        {
            foreach (var parameter in parameters.Parameters)
            {
                yield return $"{parameter.Identifier.ValueText} ({parameter.Type?.ToString() ?? "object"})";
            }
        }

        if (type is EnumDeclarationSyntax @enum)
        {
            foreach (var enumMember in @enum.Members)
            {
                yield return enumMember.Identifier.ValueText;
            }

            yield break;
        }

        foreach (var member in ((TypeDeclarationSyntax)type).Members)
        {
            switch (member)
            {
                case PropertyDeclarationSyntax property:
                    yield return $"{property.Identifier.ValueText} ({property.Type})";
                    break;
                case MethodDeclarationSyntax method:
                    yield return $"{method.Identifier.ValueText}()";
                    break;
                case ConstructorDeclarationSyntax constructor:
                    yield return $"{constructor.Identifier.ValueText}()";
                    break;
                case FieldDeclarationSyntax field:
                    foreach (var variable in field.Declaration.Variables)
                    {
                        yield return variable.Identifier.ValueText;
                    }

                    break;
            }
        }
    }

    [GeneratedRegex("tests?$", RegexOptions.IgnoreCase)]
    private static partial Regex TestTypeName();
}
