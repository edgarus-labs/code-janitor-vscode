using System.Text.Json.Nodes;
using CodeJanitor.Engine.Contracts;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace CodeJanitor.Engine.Queries;

/// <summary>
/// <c>structure</c>: the namespaces, types and members of the file and its regions (no arguments). Result:
/// <code>
/// { "items": Item[], "regions": Region[] }
/// Item = { "kind": string, "name": string, "access": string|null, "modifiers": string[],
///          "returnType": string|null, "parameters": [{ "name": string, "type": string }], "typeParameters": string[],
///          "baseTypes": string[], "startLine": int, "endLine": int, "complexity": int|null,
///          "accessors": [{ "kind": string, "startLine": int, "endLine": int, "complexity": int }],
///          "children": Item[] }
/// Region = { "name": string, "startLine": int, "endLine": int|null, "children": Region[] }
/// </code>
/// <c>kind</c> is <c>namespace</c>, <c>class</c>, <c>struct</c>, <c>record</c>, <c>interface</c>, <c>enum</c>,
/// <c>delegate</c>, <c>field</c>, <c>constant</c>, <c>event</c>, <c>property</c>, <c>indexer</c>, <c>method</c>,
/// <c>constructor</c>, <c>destructor</c>, <c>operator</c>, <c>conversion</c> or <c>enumMember</c>; one field item per
/// declared variable. <c>access</c> is the declared accessibility from the semantic model (<c>public</c>,
/// <c>internal</c>, <c>protected internal</c>, <c>protected</c>, <c>private protected</c>, <c>private</c>), null for
/// namespaces. Lines are 0-based and inclusive, from the first attribute to the end of the declaration.
/// <c>complexity</c> is the McCabe complexity of methods, constructors, destructors, operators, conversions,
/// properties, indexers and events with accessors (Visual Studio <c>CodeElementHelper.CalculateComplexity</c>),
/// null for the others; <c>accessors</c> lists the accessors of properties, indexers and events. A region without
/// <c>#endregion</c> has a null <c>endLine</c>.
/// </summary>
public sealed class StructureQuery : IDocumentQuery
{
    public string Name => "structure";

    public async Task<JsonNode?> QueryAsync(Document document, IEffectiveSettings settings, JsonObject? arguments, CancellationToken cancellationToken)
    {
        var root = await document.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false);
        if (root is not CompilationUnitSyntax unit)
        {
            return new JsonObject { ["items"] = new JsonArray(), ["regions"] = new JsonArray() };
        }

        var model = await document.GetSemanticModelAsync(cancellationToken).ConfigureAwait(false);
        var walker = new Walker(model, cancellationToken);

        return new JsonObject
        {
            ["items"] = new JsonArray([.. unit.Members.SelectMany(walker.Items)]),
            ["regions"] = Regions(unit),
        };
    }

    private static JsonArray Regions(CompilationUnitSyntax unit)
    {
        var top = new JsonArray();
        var open = new Stack<(JsonObject Region, JsonArray Children)>();
        foreach (var directive in unit.DescendantTrivia(descendIntoTrivia: true).Where(trivia => trivia.IsKind(SyntaxKind.RegionDirectiveTrivia) || trivia.IsKind(SyntaxKind.EndRegionDirectiveTrivia)))
        {
            var line = QuerySyntax.Line(unit.SyntaxTree, directive.SpanStart);
            if (directive.IsKind(SyntaxKind.RegionDirectiveTrivia))
            {
                var children = new JsonArray();
                var region = new JsonObject
                {
                    ["name"] = Reorganize.EntryBuilder.RegionName(directive.ToString()),
                    ["startLine"] = line,
                    ["endLine"] = null,
                    ["children"] = children,
                };
                (open.Count > 0 ? open.Peek().Children : top).Add(region);
                open.Push((region, children));
            }
            else if (open.Count > 0)
            {
                open.Pop().Region["endLine"] = line;
            }
        }

        return top;
    }

    private sealed class Walker(SemanticModel? model, CancellationToken cancellationToken)
    {
        public IEnumerable<JsonNode?> Items(MemberDeclarationSyntax member)
        {
            switch (member)
            {
                case BaseNamespaceDeclarationSyntax @namespace:
                    yield return Item(member, "namespace", @namespace.Name.ToString(), null, [.. @namespace.Members.SelectMany(Items)]);
                    break;

                case EnumDeclarationSyntax @enum:
                    yield return Item(member, "enum", @enum.Identifier.ValueText, Access(member), [.. @enum.Members.Select(enumMember => (JsonNode?)Item(enumMember, "enumMember", enumMember.Identifier.ValueText, null, []))]);
                    break;

                case TypeDeclarationSyntax type:
                    var item = Item(member, QuerySyntax.TypeKind(type), type.Identifier.ValueText, Access(member), [.. type.Members.SelectMany(Items)]);
                    item["typeParameters"] = QuerySyntax.Strings(QuerySyntax.TypeParameters(type));
                    item["parameters"] = QuerySyntax.Parameters(type.ParameterList);
                    item["baseTypes"] = QuerySyntax.Strings(type.BaseList?.Types.Select(baseType => baseType.ToString()) ?? []);
                    yield return item;
                    break;

                case DelegateDeclarationSyntax @delegate:
                    var delegateItem = Item(member, "delegate", @delegate.Identifier.ValueText, Access(member), []);
                    delegateItem["returnType"] = @delegate.ReturnType.ToString();
                    delegateItem["parameters"] = QuerySyntax.Parameters(@delegate.ParameterList);
                    delegateItem["typeParameters"] = QuerySyntax.Strings(QuerySyntax.TypeParameters(@delegate));
                    yield return delegateItem;
                    break;

                case BaseFieldDeclarationSyntax field:
                    var kind = field is EventFieldDeclarationSyntax ? "event" : field.Modifiers.Any(SyntaxKind.ConstKeyword) ? "constant" : "field";
                    foreach (var variable in field.Declaration.Variables)
                    {
                        var fieldItem = Item(member, kind, variable.Identifier.ValueText, Access(variable), []);
                        fieldItem["returnType"] = field.Declaration.Type.ToString();
                        yield return fieldItem;
                    }

                    break;

                case BaseMethodDeclarationSyntax method:
                    var methodItem = Item(member, MethodKind(method), QuerySyntax.NameOf(method), Access(member), []);
                    methodItem["returnType"] = method switch
                    {
                        MethodDeclarationSyntax returning => returning.ReturnType.ToString(),
                        OperatorDeclarationSyntax @operator => @operator.ReturnType.ToString(),
                        ConversionOperatorDeclarationSyntax conversion => conversion.Type.ToString(),
                        _ => null,
                    };
                    methodItem["parameters"] = QuerySyntax.Parameters(method.ParameterList);
                    methodItem["typeParameters"] = QuerySyntax.Strings(QuerySyntax.TypeParameters(method));
                    methodItem["complexity"] = QuerySyntax.Complexity(method);
                    yield return methodItem;
                    break;

                case BasePropertyDeclarationSyntax property:
                    var propertyKind = property switch
                    {
                        IndexerDeclarationSyntax => "indexer",
                        EventDeclarationSyntax => "event",
                        _ => "property",
                    };
                    var propertyItem = Item(member, propertyKind, property is IndexerDeclarationSyntax ? "this[]" : QuerySyntax.NameOf(property), Access(member), []);
                    propertyItem["returnType"] = property.Type.ToString();
                    if (property is IndexerDeclarationSyntax indexer)
                    {
                        propertyItem["parameters"] = QuerySyntax.Parameters(indexer.ParameterList);
                    }

                    propertyItem["complexity"] = QuerySyntax.Complexity(property);
                    propertyItem["accessors"] = new JsonArray([.. (property.AccessorList?.Accessors ?? default).Select(accessor => (JsonNode?)new JsonObject
                    {
                        ["kind"] = accessor.Keyword.ValueText,
                        ["startLine"] = QuerySyntax.Line(accessor.SyntaxTree, accessor.SpanStart),
                        ["endLine"] = QuerySyntax.EndLine(accessor),
                        ["complexity"] = QuerySyntax.Complexity(accessor),
                    })]);
                    yield return propertyItem;
                    break;
            }
        }

        private static string MethodKind(BaseMethodDeclarationSyntax method) => method switch
        {
            ConstructorDeclarationSyntax => "constructor",
            DestructorDeclarationSyntax => "destructor",
            OperatorDeclarationSyntax => "operator",
            ConversionOperatorDeclarationSyntax => "conversion",
            _ => "method",
        };

        private static JsonObject Item(SyntaxNode node, string kind, string name, string? access, JsonArray children) => new()
        {
            ["kind"] = kind,
            ["name"] = name,
            ["access"] = access,
            ["modifiers"] = QuerySyntax.Strings(node is MemberDeclarationSyntax member ? member.Modifiers.Select(modifier => modifier.Text) : []),
            ["returnType"] = null,
            ["parameters"] = new JsonArray(),
            ["typeParameters"] = new JsonArray(),
            ["baseTypes"] = new JsonArray(),
            ["startLine"] = QuerySyntax.Line(node.SyntaxTree, node.SpanStart),
            ["endLine"] = QuerySyntax.EndLine(node),
            ["complexity"] = null,
            ["accessors"] = new JsonArray(),
            ["children"] = children,
        };

        private string? Access(SyntaxNode node) =>
            model?.GetDeclaredSymbol(node, cancellationToken)?.DeclaredAccessibility switch
            {
                Accessibility.Public => "public",
                Accessibility.Internal => "internal",
                Accessibility.ProtectedOrInternal => "protected internal",
                Accessibility.Protected => "protected",
                Accessibility.ProtectedAndInternal => "private protected",
                Accessibility.Private => "private",
                _ => null,
            };
    }
}
