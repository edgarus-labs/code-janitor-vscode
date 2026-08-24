using CodeJanitor.Properties;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace CodeJanitor.Logic.Ai;

/// <summary>
/// Roslyn-based XML documentation generation, ported from CodeJanitorShared/Logic/Ai/
/// AiXmlDocumentationLogic.cs (Visual Studio extension). Everything that talked to EnvDTE, the
/// VS output window or the HTTP client was left behind: the engine only decides *which* members
/// need documentation, *what* to ask the model about them, and *how* the resulting comment block
/// is rendered and inserted. The AI round-trip itself is performed by the VS Code extension,
/// which sends the summaries back through <see cref="ApplySummaries"/>.
/// </summary>
public static class XmlDocumentationGenerator
{
    /// <summary>
    /// The system prompt used for both method and type summaries, copied verbatim from
    /// AiXmlDocumentationLogic.CreateSummary.
    /// </summary>
    public const string SystemPrompt =
        "You are a principal .NET software architect and technical writer authoring official Microsoft-standard XML documentation comments (<summary>).\n" +
        "Your task is to write a single-sentence, professional, production-grade summary for the given C# code element.\n" +
        "Rules:\n" +
        "1. Output EXACTLY ONE concise, high-quality summary sentence in plain text. No XML tags, no markdown quotes, no preambles, no reasoning, no thinking steps.\n" +
        "2. Never output generic or vague filler like 'Performs the operation.', 'Represents the class.', 'Executes the method.', or 'Contains data.'.\n" +
        "3. Use standard .NET conventions:\n" +
        "   - Commands (e.g., CreateRecipeCommand): 'Represents a command to create a new recipe with the specified details.'\n" +
        "   - Queries (e.g., GetRecipeByIdQuery): 'Represents a query to retrieve recipe details by identifier.'\n" +
        "   - DTOs / Records / Models: 'Represents the data structure containing {domain} details.'\n" +
        "   - Interfaces: 'Defines a contract for {domain} operations.'\n" +
        "   - Methods: start with third-person singular present tense active verbs ('Creates...', 'Calculates...', 'Asynchronously processes...', 'Handles...').\n" +
        "   - Enums: 'Specifies the available {category} options.'\n" +
        "4. Pay close attention to the element name, base types, interfaces, parameters, and properties to deduce the exact business domain semantics.";

    /// <summary>
    /// Parses the source and returns the members that should be documented, in declaration order,
    /// together with the prompt to ask the model (AI members) or the deterministic summary that
    /// needs no request at all (properties, fields, indexers, events).
    /// </summary>
    public static IReadOnlyList<XmlDocTarget> PlanTargets(string source, XmlDocRunOptions options)
    {
        var result = new List<XmlDocTarget>();
        if (string.IsNullOrWhiteSpace(source))
        {
            return result;
        }

        options ??= XmlDocRunOptions.CreateDefault(0);

        var tree = CSharpSyntaxTree.ParseText(source);
        var text = tree.GetText();
        var targets = SelectTargets(tree.GetRoot(), options);

        for (var i = 0; i < targets.Count; i++)
        {
            var member = targets[i];
            var spanStart = member.GetFirstToken().SpanStart;
            var requiresAi = RequiresAiSummary(member);

            result.Add(new XmlDocTarget
            {
                Index = i,
                Kind = DescribeKind(member),
                MemberName = DescribeName(member),
                Line = text.Lines.GetLinePosition(spanStart).Line,
                RequiresAi = requiresAi,
                Prompt = requiresAi
                    ? member is MethodDeclarationSyntax method
                        ? BuildMethodPrompt(method, options)
                        : BuildTypePrompt((BaseTypeDeclarationSyntax)member, options)
                    : null,
                FallbackSummary = BuildFallbackSummary(member),
            });
        }

        return result;
    }

    /// <summary>
    /// Re-plans the same members as <see cref="PlanTargets"/> and inserts a documentation block for
    /// each one, using the summary supplied for its index. Members whose summary is missing keep
    /// their deterministic text when they never needed AI, and are skipped otherwise.
    /// </summary>
    public static string ApplySummaries(string source, XmlDocRunOptions options, IReadOnlyDictionary<int, string> summaries)
    {
        if (string.IsNullOrWhiteSpace(source))
        {
            return source;
        }

        options ??= XmlDocRunOptions.CreateDefault(0);
        summaries ??= new Dictionary<int, string>();

        var targets = SelectTargets(CSharpSyntaxTree.ParseText(source).GetRoot(), options);
        if (targets.Count == 0)
        {
            return source;
        }

        var indexByMember = new Dictionary<MemberDeclarationSyntax, int>(ReferenceEqualityComparer.Instance);
        for (var i = 0; i < targets.Count; i++)
        {
            indexByMember[targets[i]] = i;
        }

        return ApplyToSource(source, targets, member =>
        {
            if (summaries.TryGetValue(indexByMember[member], out var summary) && !string.IsNullOrWhiteSpace(summary))
            {
                return summary;
            }

            return RequiresAiSummary(member) ? null : BuildFallbackSummary(member);
        });
    }

    /// <summary>
    /// Generates XML documentation for the members in the source using the given summary provider
    /// and default run options. Ported from AiXmlDocumentationLogic.GenerateXmlDocumentationForSource.
    /// </summary>
    public static string GenerateXmlDocumentationForSource(string source, Func<MemberDeclarationSyntax, string> summaryProvider, int maxMethodsPerFile)
    {
        return GenerateXmlDocumentationForSource(source, summaryProvider, XmlDocRunOptions.CreateDefault(maxMethodsPerFile));
    }

    /// <summary>
    /// Generates XML documentation for the members in the source using the given summary provider
    /// and run options.
    /// </summary>
    public static string GenerateXmlDocumentationForSource(string source, Func<MemberDeclarationSyntax, string> summaryProvider, XmlDocRunOptions options)
    {
        if (string.IsNullOrWhiteSpace(source) || summaryProvider is null)
        {
            return source;
        }

        options ??= XmlDocRunOptions.CreateDefault(0);

        var targets = SelectTargets(CSharpSyntaxTree.ParseText(source).GetRoot(), options);
        if (targets.Count == 0)
        {
            return source;
        }

        return ApplyToSource(source, targets, summaryProvider);
    }

    /// <summary>
    /// Selects the documentable members, ordered by declaration position, applying the
    /// MaxMethodsPerFile budget to the members that need an AI request (methods and types) while
    /// letting deterministic members (fields, properties, indexers, events) through in one pass.
    /// </summary>
    private static List<MemberDeclarationSyntax> SelectTargets(SyntaxNode root, XmlDocRunOptions options)
    {
        var skippedByFilter = 0;
        var eligibleMembers = root.DescendantNodes()
            .OfType<MemberDeclarationSyntax>()
            .Where(x => CanDocumentMember(x, options, ref skippedByFilter))
            .OrderBy(x => x.GetFirstToken().SpanStart)
            .ToList();

        if (eligibleMembers.Count == 0)
        {
            return eligibleMembers;
        }

        var methodLimit = PositiveOrDefault(options.MaxMethodsPerFile, 25);

        var aiCandidates = eligibleMembers.Where(RequiresAiSummary).ToList();
        var deterministicMembers = eligibleMembers.Where(x => !RequiresAiSummary(x)).ToList();

        if (aiCandidates.Count > methodLimit)
        {
            aiCandidates = aiCandidates.Take(methodLimit).ToList();
        }

        return aiCandidates.Concat(deterministicMembers)
            .OrderBy(x => x.GetFirstToken().SpanStart)
            .ToList();
    }

    /// <summary>
    /// Inserts the documentation blocks bottom-up so earlier insertions never invalidate the
    /// spans of the members still to be processed.
    /// </summary>
    private static string ApplyToSource(string source, List<MemberDeclarationSyntax> targets, Func<MemberDeclarationSyntax, string> summaryProvider)
    {
        var builder = new StringBuilder(source);

        foreach (var member in targets.OrderByDescending(x => x.GetFirstToken().SpanStart))
        {
            var insertPosition = GetLineStart(builder.ToString(), member.GetFirstToken().SpanStart);
            var indent = GetLineIndent(builder.ToString(), insertPosition);

            var rawSummary = summaryProvider(member);
            if (string.IsNullOrWhiteSpace(rawSummary))
            {
                continue;
            }

            var summary = NormalizeSentence(rawSummary);

            var exceptions = member is MethodDeclarationSyntax methodForExceptions
                ? DetectThrownExceptions(methodForExceptions).ToList()
                : new List<string>();

            builder.Insert(insertPosition, BuildXmlCommentBlock(indent, member, summary, exceptions));
        }

        return builder.ToString();
    }

    /// <summary>
    /// Property, field, indexer, and event wording is formulaic, so spending an AI request on it
    /// buys nothing - only methods and types are sent to the model.
    /// </summary>
    private static bool RequiresAiSummary(MemberDeclarationSyntax member)
    {
        return member is MethodDeclarationSyntax || member is BaseTypeDeclarationSyntax;
    }

    private static string DescribeKind(MemberDeclarationSyntax member)
    {
        return member switch
        {
            MethodDeclarationSyntax => "method",
            InterfaceDeclarationSyntax => "interface",
            EnumDeclarationSyntax => "enum",
            RecordDeclarationSyntax => "record",
            StructDeclarationSyntax => "struct",
            BaseTypeDeclarationSyntax => "class",
            PropertyDeclarationSyntax => "property",
            IndexerDeclarationSyntax => "indexer",
            FieldDeclarationSyntax => "field",
            EventDeclarationSyntax or EventFieldDeclarationSyntax => "event",
            _ => "member",
        };
    }

    private static string DescribeName(MemberDeclarationSyntax member)
    {
        return member switch
        {
            MethodDeclarationSyntax method => method.Identifier.ValueText,
            BaseTypeDeclarationSyntax type => type.Identifier.ValueText,
            PropertyDeclarationSyntax property => property.Identifier.ValueText,
            IndexerDeclarationSyntax => "this[]",
            EventDeclarationSyntax eventDeclaration => eventDeclaration.Identifier.ValueText,
            FieldDeclarationSyntax field => field.Declaration.Variables.FirstOrDefault()?.Identifier.ValueText ?? "field",
            EventFieldDeclarationSyntax eventField => eventField.Declaration.Variables.FirstOrDefault()?.Identifier.ValueText ?? "event",
            _ => "member",
        };
    }

    private static int PositiveOrDefault(int value, int fallback)
    {
        return value > 0 ? value : fallback;
    }

    /// <summary>
    /// Types, properties, fields, indexers, and events carry no parameters or exceptions, so they only need the shared
    /// attribute and existing-documentation filters.
    /// </summary>
    private static bool CanDocumentMember(MemberDeclarationSyntax member, XmlDocRunOptions options, ref int filteredCounter)
    {
        if (member is null)
        {
            return false;
        }

        if (member is MethodDeclarationSyntax method)
        {
            return CanDocumentMethod(method, options, ref filteredCounter);
        }

        if (!(member is BaseTypeDeclarationSyntax) &&
            !(member is PropertyDeclarationSyntax) &&
            !(member is FieldDeclarationSyntax) &&
            !(member is IndexerDeclarationSyntax) &&
            !(member is EventDeclarationSyntax) &&
            !(member is EventFieldDeclarationSyntax))
        {
            return false;
        }

        if ((member is PropertyDeclarationSyntax || member is FieldDeclarationSyntax || member is EventDeclarationSyntax || member is EventFieldDeclarationSyntax || member is IndexerDeclarationSyntax) &&
            member.Parent is InterfaceDeclarationSyntax)
        {
            return false;
        }

        if (member is FieldDeclarationSyntax field)
        {
            if (field.Declaration.Variables.Count == 0)
            {
                return false;
            }

            var isAccessibleOrConst = field.Modifiers.Any(m =>
                m.IsKind(SyntaxKind.PublicKeyword) ||
                m.IsKind(SyntaxKind.InternalKeyword) ||
                m.IsKind(SyntaxKind.ProtectedKeyword) ||
                m.IsKind(SyntaxKind.ConstKeyword));

            if (!isAccessibleOrConst)
            {
                return false;
            }
        }

        if (options.IgnoreTestMethods && member is BaseTypeDeclarationSyntax testType &&
            (testType.Identifier.ValueText.EndsWith("Tests", StringComparison.OrdinalIgnoreCase) ||
             testType.Identifier.ValueText.EndsWith("Test", StringComparison.OrdinalIgnoreCase)))
        {
            filteredCounter++;

            return false;
        }

        if (HasDocumentationComment(member))
        {
            filteredCounter++;

            return false;
        }

        if (options.IgnoreObsolete && HasAnyAttribute(member, "Obsolete"))
        {
            filteredCounter++;

            return false;
        }

        if (options.IgnoreGeneratedCode && (HasAnyAttribute(member, "GeneratedCode", "CompilerGenerated") ||
                                            HasAnyAttribute(member.Parent as MemberDeclarationSyntax, "GeneratedCode", "CompilerGenerated")))
        {
            filteredCounter++;

            return false;
        }

        return true;
    }

    /// <summary>
    /// Returns true only for non-interface, non-abstract, non-extern methods with a body that lack an existing documentation comment and do not match the configured ignore options.
    /// </summary>
    private static bool CanDocumentMethod(MethodDeclarationSyntax method, XmlDocRunOptions options, ref int filteredCounter)
    {
        if (method is null)
        {
            return false;
        }

        if (method.Parent is InterfaceDeclarationSyntax)
        {
            return false;
        }

        if (method.Modifiers.Any(x => x.IsKind(SyntaxKind.AbstractKeyword) || x.IsKind(SyntaxKind.ExternKeyword)))
        {
            return false;
        }

        if (method.Body is null && method.ExpressionBody is null)
        {
            return false;
        }

        if (HasDocumentationComment(method))
        {
            filteredCounter++;

            return false;
        }

        if (options.IgnoreObsolete && HasAnyAttribute(method, "Obsolete"))
        {
            filteredCounter++;

            return false;
        }

        if (options.IgnoreGeneratedCode && (HasAnyAttribute(method, "GeneratedCode", "CompilerGenerated") ||
                                            HasAnyAttribute(method.Parent as MemberDeclarationSyntax, "GeneratedCode", "CompilerGenerated")))
        {
            filteredCounter++;

            return false;
        }

        if (options.IgnoreTestMethods && IsLikelyTestMethod(method))
        {
            filteredCounter++;

            return false;
        }

        if (!string.IsNullOrWhiteSpace(options.IgnorePattern) && MatchesIgnorePattern(method, options.IgnorePattern))
        {
            filteredCounter++;

            return false;
        }

        return true;
    }

    /// <summary>
    /// Returns true if the member declaration contains any attribute whose name (ignoring namespace, case, and the "Attribute" suffix) matches one of the supplied target names.
    /// </summary>
    private static bool HasAnyAttribute(MemberDeclarationSyntax declaration, params string[] names)
    {
        if (declaration is null)
        {
            return false;
        }

        var targetNames = new HashSet<string>(names ?? new string[0], StringComparer.OrdinalIgnoreCase);
        foreach (var list in declaration.AttributeLists)
        {
            foreach (var attribute in list.Attributes)
            {
                var raw = attribute.Name.ToString();
                if (string.IsNullOrWhiteSpace(raw))
                {
                    continue;
                }

                var normalized = raw.Split('.').Last().Replace("Attribute", string.Empty);
                if (targetNames.Contains(normalized))
                {
                    return true;
                }
            }
        }

        return false;
    }

    /// <summary>
    /// Determines whether a method is likely a test method by checking for common test attributes or a containing type name ending with "Tests"/"Test".
    /// </summary>
    private static bool IsLikelyTestMethod(MethodDeclarationSyntax method)
    {
        if (HasAnyAttribute(method, "TestMethod", "Fact", "Theory", "Test", "TestCase", "DataTestMethod"))
        {
            return true;
        }

        var containingTypeName = (method.Parent as TypeDeclarationSyntax)?.Identifier.ValueText ?? string.Empty;

        return containingTypeName.EndsWith("Tests", StringComparison.OrdinalIgnoreCase) ||
               containingTypeName.EndsWith("Test", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Determines whether a method's fully qualified name (namespace.type.method) matches the given regex pattern case-insensitively.
    /// </summary>
    private static bool MatchesIgnorePattern(MethodDeclarationSyntax method, string ignorePattern)
    {
        if (string.IsNullOrWhiteSpace(ignorePattern))
        {
            return false;
        }

        try
        {
            var containingType = (method.Parent as TypeDeclarationSyntax)?.Identifier.ValueText ?? string.Empty;
            var containingNamespace = method.Ancestors().OfType<NamespaceDeclarationSyntax>().FirstOrDefault()?.Name.ToString() ?? string.Empty;
            var fullName = string.IsNullOrWhiteSpace(containingNamespace)
                ? containingType + "." + method.Identifier.ValueText
                : containingNamespace + "." + containingType + "." + method.Identifier.ValueText;

            return Regex.IsMatch(fullName, ignorePattern, RegexOptions.IgnoreCase);
        }
        catch (Exception)
        {
            return false;
        }
    }

    /// <summary>
    /// Determines whether the provided SyntaxNode includes documentation comments within its leading trivia.
    /// </summary>
    private static bool HasDocumentationComment(SyntaxNode member)
    {
        if (member is null)
        {
            return false;
        }

        return member.GetLeadingTrivia().Any(trivia =>
        {
            if (trivia.IsKind(SyntaxKind.SingleLineDocumentationCommentTrivia) ||
                trivia.IsKind(SyntaxKind.MultiLineDocumentationCommentTrivia))
            {
                return true;
            }

            var structure = trivia.GetStructure();

            return structure is not null &&
                   (structure.IsKind(SyntaxKind.SingleLineDocumentationCommentTrivia) ||
                    structure.IsKind(SyntaxKind.MultiLineDocumentationCommentTrivia));
        });
    }

    /// <summary>
    /// Builds the model prompt for a method from its stripped signature, optionally truncated body text, and detected thrown exceptions.
    /// </summary>
    private static string BuildMethodPrompt(MethodDeclarationSyntax method, XmlDocRunOptions options)
    {
        var signature = method.WithBody(null)
            .WithExpressionBody(null)
            .WithSemicolonToken(default(SyntaxToken))
            .NormalizeWhitespace()
            .ToFullString();

        var bodyText = method.Body is not null
            ? method.Body.ToFullString().Trim()
            : method.ExpressionBody?.ToFullString().Trim() ?? string.Empty;

        var exceptionList = string.Join(", ", DetectThrownExceptions(method));
        if (string.IsNullOrWhiteSpace(exceptionList))
        {
            exceptionList = "none detected";
        }

        return
            "Generate a professional C# XML documentation <summary> sentence for the following C# method:\n" +
            "Signature: " + signature + "\n" +
            "Method body:\n" + Truncate(bodyText, options.MaxInputCharsPerMethod) + "\n" +
            "Detected thrown exceptions: " + exceptionList + "\n\n" +
            "Guidelines:\n" +
            "- Start with a third-person singular active verb (e.g., 'Asynchronously retrieves...', 'Executes the...', 'Validates and parses...').\n" +
            "- Describe what the method does and any important outcome or side effect.\n" +
            "- Do NOT output vague generic filler like 'Performs the operation.' or 'Executes the action.'\n" +
            "- Output ONLY the single summary sentence (plain text, no XML, no quotes, no reasoning).";
    }

    /// <summary>
    /// Describes a type by its declaration header, base types/interfaces, constructor parameters (for records),
    /// and member signatures.
    /// </summary>
    private static string BuildTypePrompt(BaseTypeDeclarationSyntax type, XmlDocRunOptions options)
    {
        var header = type.Identifier.ValueText;
        var kind = type is InterfaceDeclarationSyntax ? "interface"
            : type is EnumDeclarationSyntax ? "enum"
            : type is StructDeclarationSyntax ? "struct"
            : type is RecordDeclarationSyntax ? "record"
            : "class";

        var memberNames = new List<string>();

        // For positional records (e.g. record Foo(int A, string B)), extract parameters
        if (type is RecordDeclarationSyntax recordDeclaration && recordDeclaration.ParameterList is not null)
        {
            foreach (var parameter in recordDeclaration.ParameterList.Parameters)
            {
                var paramType = parameter.Type?.ToString() ?? "object";
                memberNames.Add(parameter.Identifier.ValueText + " (" + paramType + ")");
            }
        }

        if (type is TypeDeclarationSyntax typeDeclaration)
        {
            foreach (var member in typeDeclaration.Members)
            {
                if (member is PropertyDeclarationSyntax p) memberNames.Add(p.Identifier.ValueText + " (" + (p.Type?.ToString() ?? "property") + ")");
                else if (member is MethodDeclarationSyntax m) memberNames.Add(m.Identifier.ValueText + "()");
                else if (member is FieldDeclarationSyntax f) memberNames.AddRange(f.Declaration.Variables.Select(v => v.Identifier.ValueText));
            }
        }
        else if (type is EnumDeclarationSyntax enumDeclaration)
        {
            memberNames.AddRange(enumDeclaration.Members.Select(x => x.Identifier.ValueText));
        }

        var baseTypes = type.BaseList?.Types.Select(t => t.Type.ToString()).ToList();
        var baseListText = baseTypes is not null && baseTypes.Count > 0
            ? string.Join(", ", baseTypes)
            : "none";

        var members = memberNames.Count == 0 ? "none" : string.Join(", ", memberNames);

        var declarationSignature = type.Modifiers.ToString() + " " + kind + " " + header;
        if (type is RecordDeclarationSyntax rec && rec.ParameterList is not null)
        {
            declarationSignature += rec.ParameterList.ToString();
        }

        if (type.BaseList is not null)
        {
            declarationSignature += " " + type.BaseList.ToString();
        }

        return
            "Generate a professional C# XML documentation <summary> sentence for the following C# " + kind + ":\n" +
            "Declaration: " + declarationSignature + "\n" +
            "Kind: " + kind + "\n" +
            "Name: " + header + "\n" +
            "Implemented interfaces / base types: " + baseListText + "\n" +
            "Parameters / Properties / Members: " + Truncate(members, options.MaxInputCharsPerMethod) + "\n\n" +
            "Guidelines:\n" +
            "- If this is a Command (e.g. implements ICommand, IRequest, or ends with 'Command'): start with 'Represents a command to {action}...' or 'Defines the command for {action}...' describing what action will be initiated and what data it carries.\n" +
            "- If this is a Query (e.g. implements IQuery, IRequest, or ends with 'Query'): start with 'Represents a query to retrieve {noun}...'.\n" +
            "- If this is a DTO, response, or event (e.g. ends with 'Dto', 'Response', 'Event'): start with 'Represents {noun}...' describing the data it encapsulates.\n" +
            "- If this is an Interface: start with 'Defines a contract for...' or 'Provides an abstraction for...'.\n" +
            "- If this is a marker interface with no members: state that it serves as a marker/indicator contract for type checking or pipeline dispatch.\n" +
            "- If this is a Class/Struct/Record: start with 'Represents...' or 'Provides...' describing its primary responsibility.\n" +
            "- If this is an Enum: start with 'Specifies...' or 'Defines constants for...'.\n" +
            "- Do NOT output vague generic filler like 'Performs the operation.' or 'Represents the object.' Be specific to the domain name and properties.\n" +
            "- Output ONLY the single summary sentence (plain text, no XML, no quotes, no reasoning).";
    }

    private static string BuildFieldSummary(FieldDeclarationSyntax field)
    {
        var firstVar = field.Declaration.Variables.FirstOrDefault();
        var name = firstVar is not null ? firstVar.Identifier.ValueText : "value";

        return "The " + SplitIdentifier(name).ToLowerInvariant() + ".";
    }

    private static string BuildIndexerSummary(IndexerDeclarationSyntax indexer)
    {
        return "Gets or sets the element at the specified index.";
    }

    private static string BuildEventSummary(MemberDeclarationSyntax eventMember)
    {
        var name = "event";
        if (eventMember is EventDeclarationSyntax ed)
        {
            name = ed.Identifier.ValueText;
        }
        else if (eventMember is EventFieldDeclarationSyntax efd)
        {
            var v = efd.Declaration.Variables.FirstOrDefault();
            if (v is not null)
            {
                name = v.Identifier.ValueText;
            }
        }

        return "Occurs when " + SplitIdentifier(name).ToLowerInvariant() + ".";
    }

    /// <summary>
    /// Detects exception types thrown by a method by collecting names from `throw` statements and expressions and inferring argument exceptions from `ThrowIf*` guard helper invocations.
    /// </summary>
    private static IEnumerable<string> DetectThrownExceptions(MethodDeclarationSyntax method)
    {
        var exceptions = new HashSet<string>(StringComparer.Ordinal);

        foreach (var throwStatement in method.DescendantNodes().OfType<ThrowStatementSyntax>())
        {
            var createdType = TryGetThrownTypeName(throwStatement.Expression);
            if (!string.IsNullOrWhiteSpace(createdType))
            {
                exceptions.Add(createdType);
            }
        }

        foreach (var throwExpression in method.DescendantNodes().OfType<ThrowExpressionSyntax>())
        {
            var createdType = TryGetThrownTypeName(throwExpression.Expression);
            if (!string.IsNullOrWhiteSpace(createdType))
            {
                exceptions.Add(createdType);
            }
        }

        // Guard helper patterns often used instead of explicit throw new statements.
        foreach (var invocation in method.DescendantNodes().OfType<InvocationExpressionSyntax>())
        {
            var name = invocation.Expression.ToString();
            if (name.IndexOf("ThrowIfNull", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                exceptions.Add("ArgumentNullException");
            }
            else if (name.IndexOf("ThrowIfNullOrEmpty", StringComparison.OrdinalIgnoreCase) >= 0 ||
                     name.IndexOf("ThrowIfNullOrWhiteSpace", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                exceptions.Add("ArgumentException");
            }
            else if (name.IndexOf("ThrowIfNegative", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                exceptions.Add("ArgumentOutOfRangeException");
            }
        }

        return exceptions;
    }

    private static string TryGetThrownTypeName(ExpressionSyntax expression)
    {
        if (expression is ObjectCreationExpressionSyntax creation && creation.Type is not null)
        {
            return creation.Type.ToString();
        }

        return null;
    }

    /// <summary>
    /// Finds the start index of the line containing the character at the specified index. The
    /// member's own line already carries its indentation, so the block is inserted at the start of
    /// that line rather than at the declaration token.
    /// </summary>
    private static int GetLineStart(string text, int index)
    {
        var lineStart = text.LastIndexOf('\n', Math.Max(0, Math.Min(index, text.Length) - 1));

        return lineStart < 0 ? 0 : lineStart + 1;
    }

    /// <summary>
    /// Builds an XML documentation comment block string for a member by appending an indented &lt;summary&gt; element,
    /// and for methods, constructors, and positional records additionally appending &lt;param&gt; elements, a &lt;returns&gt; element,
    /// and ordered &lt;exception&gt; elements.
    /// </summary>
    private static string BuildXmlCommentBlock(string indent, MemberDeclarationSyntax member, string summary, IEnumerable<string> exceptionTypes)
    {
        var sb = new StringBuilder();

        sb.Append(indent).AppendLine("/// <summary>");
        sb.Append(indent).Append("/// ").AppendLine(XmlEscape(summary));
        sb.Append(indent).AppendLine("/// </summary>");

        // 1. Positional records or primary constructors parameters
        IEnumerable<ParameterSyntax> parameters = null;
        if (member is MethodDeclarationSyntax method)
        {
            parameters = method.ParameterList?.Parameters;
        }
        else if (member is ConstructorDeclarationSyntax constructor)
        {
            parameters = constructor.ParameterList?.Parameters;
        }
        else if (member is RecordDeclarationSyntax record)
        {
            parameters = record.ParameterList?.Parameters;
        }

        if (parameters is not null)
        {
            foreach (var parameter in parameters)
            {
                var parameterName = parameter.Identifier.ValueText;
                if (!string.IsNullOrWhiteSpace(parameterName))
                {
                    var paramType = parameter.Type?.ToString();
                    sb.Append(indent)
                        .Append("/// <param name=\"")
                        .Append(parameterName)
                        .Append("\">")
                        .Append(XmlEscape(BuildParameterDescription(parameterName, paramType)))
                        .AppendLine("</param>");
                }
            }
        }

        // 2. Return description for methods
        if (member is MethodDeclarationSyntax m)
        {
            var returnTypeStr = m.ReturnType?.ToString();
            var returnsVoid = string.Equals(returnTypeStr, "void", StringComparison.OrdinalIgnoreCase);

            if (!returnsVoid && !string.IsNullOrWhiteSpace(returnTypeStr))
            {
                sb.Append(indent)
                    .Append("/// <returns>")
                    .Append(XmlEscape(BuildReturnDescription(returnTypeStr, m.Identifier.ValueText)))
                    .AppendLine("</returns>");
            }
        }

        // 3. Exceptions
        if (exceptionTypes is not null)
        {
            foreach (var exceptionType in exceptionTypes.OrderBy(x => x, StringComparer.Ordinal))
            {
                sb.Append(indent)
                    .Append("/// <exception cref=\"")
                    .Append(XmlEscape(exceptionType))
                    .Append("\">")
                    .Append(XmlEscape("Thrown when an error occurs during execution."))
                    .AppendLine("</exception>");
            }
        }

        return sb.ToString();
    }

    /// <summary>
    /// Builds a professional, context-aware description for a parameter based on its name and type.
    /// </summary>
    private static string BuildParameterDescription(string parameterName, string parameterType = null)
    {
        if (string.IsNullOrWhiteSpace(parameterName))
        {
            return "The parameter value.";
        }

        if (string.Equals(parameterName, "cancellationToken", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(parameterType, "CancellationToken", StringComparison.OrdinalIgnoreCase))
        {
            return "The cancellation token to monitor for cancellation requests.";
        }

        if (string.Equals(parameterName, "id", StringComparison.OrdinalIgnoreCase))
        {
            return "The unique identifier.";
        }

        if (parameterName.EndsWith("Id", StringComparison.OrdinalIgnoreCase) && parameterName.Length > 2)
        {
            var entity = parameterName.Substring(0, parameterName.Length - 2);

            return "The unique identifier of the " + SplitIdentifier(entity).ToLowerInvariant() + ".";
        }

        if (parameterName.EndsWith("Dto", StringComparison.OrdinalIgnoreCase) ||
            parameterName.EndsWith("Request", StringComparison.OrdinalIgnoreCase) ||
            parameterName.EndsWith("Command", StringComparison.OrdinalIgnoreCase))
        {
            return "The " + SplitIdentifier(parameterName).ToLowerInvariant() + " containing the operation data.";
        }

        var split = SplitIdentifier(parameterName).ToLowerInvariant();

        if (parameterType is not null && (parameterType.StartsWith("List<") || parameterType.StartsWith("IList<") || parameterType.StartsWith("IEnumerable<") || parameterType.StartsWith("IReadOnlyList<") || parameterType.EndsWith("[]")))
        {
            return "The collection of " + split + ".";
        }

        return "The " + split + ".";
    }

    /// <summary>
    /// Builds a professional, context-aware description for a method return type.
    /// </summary>
    private static string BuildReturnDescription(string returnType, string methodName = null)
    {
        if (string.IsNullOrWhiteSpace(returnType))
        {
            return "The result of the operation.";
        }

        if (string.Equals(returnType, "bool", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(returnType, "Boolean", StringComparison.OrdinalIgnoreCase))
        {
            if (!string.IsNullOrWhiteSpace(methodName) &&
                (methodName.StartsWith("Is", StringComparison.OrdinalIgnoreCase) ||
                 methodName.StartsWith("Has", StringComparison.OrdinalIgnoreCase) ||
                 methodName.StartsWith("Can", StringComparison.OrdinalIgnoreCase) ||
                 methodName.StartsWith("Try", StringComparison.OrdinalIgnoreCase)))
            {
                return "true if the condition is met; otherwise, false.";
            }

            return "true if the operation succeeded; otherwise, false.";
        }

        if (string.Equals(returnType, "Task", StringComparison.OrdinalIgnoreCase))
        {
            return "A task representing the asynchronous operation.";
        }

        if (string.Equals(returnType, "ValueTask", StringComparison.OrdinalIgnoreCase))
        {
            return "A value task representing the asynchronous operation.";
        }

        if (returnType.StartsWith("Task<", StringComparison.OrdinalIgnoreCase) && returnType.EndsWith(">"))
        {
            var inner = returnType.Substring(5, returnType.Length - 6).Trim();
            if (string.Equals(inner, "bool", StringComparison.OrdinalIgnoreCase))
            {
                return "A task representing the asynchronous operation. The task result is true if successful; otherwise, false.";
            }

            return "A task representing the asynchronous operation. The task result contains the " + CleanGenericTypeName(inner) + ".";
        }

        if (returnType.StartsWith("ValueTask<", StringComparison.OrdinalIgnoreCase) && returnType.EndsWith(">"))
        {
            var inner = returnType.Substring(10, returnType.Length - 11).Trim();

            return "A value task representing the asynchronous operation. The task result contains the " + CleanGenericTypeName(inner) + ".";
        }

        if (returnType.StartsWith("IEnumerable<") || returnType.StartsWith("IReadOnlyList<") || returnType.StartsWith("List<") || returnType.EndsWith("[]"))
        {
            return "A collection of " + CleanGenericTypeName(returnType) + " items.";
        }

        return "The " + CleanGenericTypeName(returnType) + " result.";
    }

    /// <summary>
    /// Converts a generic type name into a simplified, lowercase identifier by stripping generic arguments and array brackets.
    /// </summary>
    private static string CleanGenericTypeName(string typeName)
    {
        if (string.IsNullOrWhiteSpace(typeName))
        {
            return "result";
        }

        var idx = typeName.IndexOf('<');
        var baseName = idx > 0 ? typeName.Substring(0, idx) : typeName;
        baseName = baseName.Replace("[]", string.Empty);

        return SplitIdentifier(baseName).ToLowerInvariant();
    }

    /// <summary>
    /// Builds a documentation summary string for a property following official .NET documentation conventions.
    /// </summary>
    private static string BuildPropertySummary(PropertyDeclarationSyntax property)
    {
        var accessors = property.AccessorList?.Accessors;
        var hasGet = accessors?.Any(x => x.IsKind(SyntaxKind.GetAccessorDeclaration)) ?? property.ExpressionBody is not null;
        var hasSet = accessors?.Any(x => x.IsKind(SyntaxKind.SetAccessorDeclaration) || x.IsKind(SyntaxKind.InitAccessorDeclaration)) ?? false;

        if (!hasGet && !hasSet && property.Initializer is not null)
        {
            hasGet = true;
        }

        var propType = property.Type?.ToString() ?? string.Empty;
        var isBool = string.Equals(propType, "bool", StringComparison.OrdinalIgnoreCase) ||
                     string.Equals(propType, "Boolean", StringComparison.OrdinalIgnoreCase);

        var propName = property.Identifier.ValueText;
        var split = SplitIdentifier(propName).ToLowerInvariant();

        if (isBool)
        {
            return hasGet && hasSet
                ? "Gets or sets a value indicating whether " + split + "."
                : hasSet
                    ? "Sets a value indicating whether " + split + "."
                    : "Gets a value indicating whether " + split + ".";
        }

        var verb = hasGet && hasSet ? "Gets or sets" : hasSet ? "Sets" : "Gets";

        if (propType.StartsWith("List<") || propType.StartsWith("IList<") || propType.StartsWith("IReadOnlyList<") ||
            propType.StartsWith("IEnumerable<") || propType.StartsWith("ICollection<") || propType.EndsWith("[]"))
        {
            return verb + " the collection of " + split + ".";
        }

        return verb + " the " + split + ".";
    }

    /// <summary>
    /// Builds the deterministic summary used when no AI request is made for a member, or when the
    /// model call failed and deterministic fallback is allowed.
    /// </summary>
    public static string BuildFallbackSummary(MemberDeclarationSyntax member)
    {
        if (member is BaseTypeDeclarationSyntax type)
        {
            var typeName = type.Identifier.ValueText;
            if (type is InterfaceDeclarationSyntax)
            {
                return "Defines a contract for " + SplitIdentifier(typeName).ToLowerInvariant() + ".";
            }

            if (typeName.EndsWith("Command", StringComparison.OrdinalIgnoreCase))
            {
                var action = typeName.Substring(0, typeName.Length - "Command".Length);
                var split = SplitIdentifier(action).ToLowerInvariant();

                return "Represents a command to " + (string.IsNullOrWhiteSpace(split) ? "execute the operation" : split) + ".";
            }

            if (typeName.EndsWith("Query", StringComparison.OrdinalIgnoreCase))
            {
                var noun = typeName.Substring(0, typeName.Length - "Query".Length);
                var split = SplitIdentifier(noun).ToLowerInvariant();

                return "Represents a query to retrieve " + (string.IsNullOrWhiteSpace(split) ? "the requested data" : split) + ".";
            }

            if (typeName.EndsWith("Dto", StringComparison.OrdinalIgnoreCase) ||
                typeName.EndsWith("Response", StringComparison.OrdinalIgnoreCase) ||
                typeName.EndsWith("Request", StringComparison.OrdinalIgnoreCase))
            {
                return "Represents the data structure for " + SplitIdentifier(typeName).ToLowerInvariant() + ".";
            }

            return "Represents " + SplitIdentifier(typeName).ToLowerInvariant() + ".";
        }

        if (member is PropertyDeclarationSyntax property)
        {
            return BuildPropertySummary(property);
        }

        if (member is FieldDeclarationSyntax field)
        {
            return BuildFieldSummary(field);
        }

        if (member is IndexerDeclarationSyntax indexer)
        {
            return BuildIndexerSummary(indexer);
        }

        if (member is EventDeclarationSyntax || member is EventFieldDeclarationSyntax)
        {
            return BuildEventSummary(member);
        }

        var method = (MethodDeclarationSyntax)member;
        var methodName = method.Identifier.ValueText;
        var splitMethod = SplitIdentifier(methodName).ToLowerInvariant();

        return "Executes " + (string.IsNullOrWhiteSpace(splitMethod) ? "the method" : splitMethod) + ".";
    }

    /// <summary>
    /// Splits a camelCase or snake_case identifier into separate words.
    /// </summary>
    private static string SplitIdentifier(string identifier)
    {
        if (string.IsNullOrWhiteSpace(identifier))
        {
            return "the operation";
        }

        var text = Regex.Replace(identifier, "([a-z0-9])([A-Z])", "$1 $2");

        return text.Replace('_', ' ').Trim();
    }

    /// <summary>
    /// Returns the leading whitespace (spaces and tabs) of the line containing the specified position.
    /// </summary>
    private static string GetLineIndent(string source, int position)
    {
        var lineStart = source.LastIndexOf('\n', Math.Max(0, position - 1));
        lineStart = lineStart < 0 ? 0 : lineStart + 1;

        var i = lineStart;
        while (i < source.Length)
        {
            var c = source[i];
            if (c != ' ' && c != '\t')
            {
                break;
            }

            i++;
        }

        return source.Substring(lineStart, i - lineStart);
    }

    /// <summary>
    /// Sanitizes an AI completion by stripping thinking process, chain-of-thought blocks (&lt;think&gt;...&lt;/think&gt;, "Thinking Process:", etc.), markdown code fences, and preambles.
    /// </summary>
    public static string SanitizeAiCompletion(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return string.Empty;
        }

        var cleaned = text.Trim();

        // 1. Remove XML/HTML thinking tags: <think>...</think>, <thought>...</thought>, etc.
        cleaned = Regex.Replace(cleaned, @"<think>[\s\S]*?</think>", string.Empty, RegexOptions.IgnoreCase);
        cleaned = Regex.Replace(cleaned, @"<thought>[\s\S]*?</thought>", string.Empty, RegexOptions.IgnoreCase);
        cleaned = Regex.Replace(cleaned, @"<reasoning>[\s\S]*?</reasoning>", string.Empty, RegexOptions.IgnoreCase);

        // If an unclosed <think> tag was cut off by max_tokens, strip everything after <think>
        cleaned = Regex.Replace(cleaned, @"<think>[\s\S]*$", string.Empty, RegexOptions.IgnoreCase);

        // 2. Strip explicit "Thinking Process:" or "Thought:" blocks if present
        if (Regex.IsMatch(cleaned, @"^(?:\*{0,2})Thinking Process(?:\*{0,2})\s*:", RegexOptions.IgnoreCase))
        {
            // If the model produced drafts like "Draft 1:", "Draft 2:", or "Summary:", try to pick the last non-empty draft
            var draftMatches = Regex.Matches(cleaned, @"(?:Draft\s*\d+|Final Draft|Summary)\s*(?:\([^)]*\))?\s*:\s*\*?\*?([^\n\r*]+)", RegexOptions.IgnoreCase);
            if (draftMatches.Count > 0)
            {
                var candidate = draftMatches[draftMatches.Count - 1].Groups[1].Value.Trim();
                if (!string.IsNullOrWhiteSpace(candidate) && candidate.Length > 5)
                {
                    cleaned = candidate;
                }
                else
                {
                    // Strip the entire thinking process prefix
                    cleaned = string.Empty;
                }
            }
            else
            {
                cleaned = string.Empty;
            }
        }

        // 3. Remove markdown backticks and code fences if any
        cleaned = Regex.Replace(cleaned, @"^```[a-zA-Z]*\s*", string.Empty);
        cleaned = Regex.Replace(cleaned, @"\s*```$", string.Empty);

        // 4. Remove common introductory preambles (e.g., "Here is the summary:", "Summary:", "Description:")
        cleaned = Regex.Replace(cleaned, @"^(?:Here is (?:the|a) (?:concise )?summary(?:\s+sentence)?:\s*|Summary:\s*|Description:\s*)", string.Empty, RegexOptions.IgnoreCase);

        // 5. Remove any leading XML comment markers if the model hallucinated them
        cleaned = Regex.Replace(cleaned, @"^(?:\s*///\s*(?:<summary>)?\s*)+", string.Empty, RegexOptions.IgnoreCase);
        cleaned = Regex.Replace(cleaned, @"(?:\s*///\s*</summary>\s*)+$", string.Empty, RegexOptions.IgnoreCase);

        return cleaned.Trim();
    }

    /// <summary>
    /// Normalizes a sentence by stripping reasoning/thinking artifacts, collapsing whitespace, trimming surrounding quotes, appending a period if lacking ending punctuation, and returning the fallback "Performs the operation." when empty.
    /// </summary>
    public static string NormalizeSentence(string text)
    {
        var sanitized = SanitizeAiCompletion(text);
        var compact = Regex.Replace(sanitized ?? string.Empty, "\\s+", " ").Trim();
        if (string.IsNullOrEmpty(compact))
        {
            return "Performs the operation.";
        }

        compact = compact.Trim('"', '\'', '`', '*');
        if (!compact.EndsWith(".", StringComparison.Ordinal) &&
            !compact.EndsWith("!", StringComparison.Ordinal) &&
            !compact.EndsWith("?", StringComparison.Ordinal))
        {
            compact += ".";
        }

        return compact;
    }

    private static string XmlEscape(string text)
    {
        return (text ?? string.Empty)
            .Replace("&", "&amp;")
            .Replace("<", "&lt;")
            .Replace(">", "&gt;")
            .Replace("\"", "&quot;")
            .Replace("'", "&apos;");
    }

    private static string Truncate(string text, int maxLength)
    {
        if (string.IsNullOrEmpty(text) || text.Length <= maxLength)
        {
            return text;
        }

        return text.Substring(0, maxLength) + "...";
    }
}

/// <summary>
/// Filtering and budgeting options for an XML documentation run, mirroring
/// AiXmlDocumentationLogic.AiXmlDocumentationRunOptions minus the settings that only configured
/// the Visual Studio extension's own HTTP client and preview dialog.
/// </summary>
public sealed class XmlDocRunOptions
{
    public int MaxMethodsPerFile { get; set; }

    public int MaxInputCharsPerMethod { get; set; }

    public bool IgnoreGeneratedCode { get; set; }

    public bool IgnoreObsolete { get; set; }

    public bool IgnoreTestMethods { get; set; }

    public string IgnorePattern { get; set; }

    /// <summary>
    /// The permissive defaults used by the source repo's GenerateXmlDocumentationForSource helper.
    /// </summary>
    public static XmlDocRunOptions CreateDefault(int maxMethodsPerFile)
    {
        return new XmlDocRunOptions
        {
            MaxMethodsPerFile = maxMethodsPerFile > 0 ? maxMethodsPerFile : 25,
            MaxInputCharsPerMethod = 2500,
            IgnoreGeneratedCode = false,
            IgnoreObsolete = false,
            IgnoreTestMethods = false,
            IgnorePattern = string.Empty,
        };
    }

    /// <summary>
    /// Reads the options from the Settings shim, which the CLI populates from the JSON request.
    /// </summary>
    public static XmlDocRunOptions FromSettings()
    {
        var settings = Settings.Default;

        return new XmlDocRunOptions
        {
            MaxMethodsPerFile = settings.Cleaning_AiXmlDocumentationMaxMethodsPerFile > 0 ? settings.Cleaning_AiXmlDocumentationMaxMethodsPerFile : 25,
            MaxInputCharsPerMethod = settings.Cleaning_AiXmlDocumentationMaxInputCharsPerMethod > 0 ? settings.Cleaning_AiXmlDocumentationMaxInputCharsPerMethod : 2500,
            IgnoreGeneratedCode = settings.Cleaning_AiXmlDocumentationIgnoreGeneratedCode,
            IgnoreObsolete = settings.Cleaning_AiXmlDocumentationIgnoreObsolete,
            IgnoreTestMethods = settings.Cleaning_AiXmlDocumentationIgnoreTestMethods,
            IgnorePattern = settings.Cleaning_AiXmlDocumentationIgnorePattern,
        };
    }
}

/// <summary>
/// A single member the engine selected for documentation, handed to the VS Code extension so it
/// can run the AI request itself and send the resulting summary back by index.
/// </summary>
public sealed class XmlDocTarget
{
    public int Index { get; set; }

    public string Kind { get; set; }

    public string MemberName { get; set; }

    public int Line { get; set; }

    public bool RequiresAi { get; set; }

    public string Prompt { get; set; }

    public string FallbackSummary { get; set; }
}
