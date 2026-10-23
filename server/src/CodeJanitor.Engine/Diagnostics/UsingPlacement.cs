using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace CodeJanitor.Engine.Diagnostics;

/// <summary>
/// What the Roslyn code fix of IDE0065 (using directive placement) does not take care of: it moves directives whose name could
/// bind to something else in another build configuration, and it merges the directive the target already has without keeping
/// the comment of one of the two or, moving inwards, without merging at all (CS0105).
/// </summary>
internal static partial class UsingPlacement
{
    /// <summary>
    /// Why the directives of the container IDE0065 reports on must stay where they are: the first name of one of them is also the
    /// name of a namespace or type that is declared only under a preprocessor condition, so the directive binds to something
    /// else in another build configuration, before or after the move.
    /// <see langword="null"/> when moving them is safe.
    /// </summary>
    internal static async Task<string?> WhyNotMovedAsync(Document document, Diagnostic diagnostic, CancellationToken cancellationToken)
    {
        var node = diagnostic.Location.SourceTree?.GetRoot(cancellationToken).FindToken(diagnostic.Location.SourceSpan.Start).Parent;
        var container = node?.AncestorsAndSelf().FirstOrDefault(ancestor => ancestor is BaseNamespaceDeclarationSyntax or CompilationUnitSyntax);
        var names = UsingsOf(container).Where(IsLocal).SelectMany(FirstNames).ToHashSet(StringComparer.Ordinal);
        if (names.Count == 0)
        {
            return null;
        }

        var conditional = await FirstConditionalNameAsync(document.Project, names, cancellationToken).ConfigureAwait(false);

        return conditional is null
            ? null
            : $"not moved: '{conditional}' is declared under a preprocessor condition, so the using directive could bind to something else in another build configuration.";
    }

    /// <summary>
    /// Merges the identical using directives a placement fix left in one container (the file already had the directive in the
    /// place the other one was moved to) and puts back the comments that went away with a directive the fix removed, on the
    /// directive that stays: after it when it has no comment of its own, otherwise on the line above it.
    /// </summary>
    internal static async Task<Solution> MergeDuplicatesAsync(Document original, Solution solution, CancellationToken cancellationToken)
    {
        var document = solution.GetDocument(original.Id)!;
        if (await original.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false) is not { } originalRoot
            || await document.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false) is not { } root)
        {
            return solution;
        }

        var text = await document.GetTextAsync(cancellationToken).ConfigureAwait(false);
        var removals = new List<TextChange>();
        var candidates = Directives(originalRoot).SelectMany(CommentsOf).ToList();
        foreach (var container in root.DescendantNodesAndSelf().Where(node => node is CompilationUnitSyntax or BaseNamespaceDeclarationSyntax))
        {
            foreach (var group in UsingsOf(container).Where(IsLocal).GroupBy(Key).Where(group => group.Count() > 1))
            {
                foreach (var duplicate in group.Skip(1))
                {
                    if (OwnLines(text, duplicate) is { } lines)
                    {
                        removals.Add(new TextChange(lines, string.Empty));
                        candidates.AddRange(CommentsOf(duplicate));
                    }
                }
            }
        }

        var merged = text.WithChanges(removals);
        var mergedText = merged.ToString();
        var lost = candidates.Where(comment => !mergedText.Contains(comment.Text, StringComparison.Ordinal)).DistinctBy(comment => (comment.Key, comment.Text)).ToList();
        if (removals.Count == 0 && lost.Count == 0)
        {
            return solution;
        }

        var survivors = new Dictionary<string, UsingDirectiveSyntax>(StringComparer.Ordinal);
        var mergedRoot = await CSharpSyntaxTree.ParseText(merged, (CSharpParseOptions)root.SyntaxTree.Options).GetRootAsync(cancellationToken).ConfigureAwait(false);
        foreach (var directive in Directives(mergedRoot))
        {
            survivors.TryAdd(Key(directive), directive);
        }

        var insertions = new SortedDictionary<int, string>();
        var withTrailing = new HashSet<string>(StringComparer.Ordinal);
        foreach (var comment in lost.Where(comment => survivors.ContainsKey(comment.Key)))
        {
            var survivor = survivors[comment.Key];
            if (comment.Trailing && CommentsOf(survivor).All(existing => !existing.Trailing) && withTrailing.Add(comment.Key))
            {
                insertions[survivor.Span.End] = insertions.GetValueOrDefault(survivor.Span.End) + " " + comment.Text;
                continue;
            }

            var line = merged.Lines.GetLineFromPosition(survivor.SpanStart);
            var lineBreak = merged.ToString(TextSpan.FromBounds(line.End, line.EndIncludingLineBreak));
            var indentation = merged.ToString(TextSpan.FromBounds(line.Start, survivor.SpanStart));
            insertions[line.Start] = insertions.GetValueOrDefault(line.Start) + indentation + comment.Text + (lineBreak.Length == 0 ? "\n" : lineBreak);
        }

        var result = merged.WithChanges(insertions.Select(insertion => new TextChange(new TextSpan(insertion.Key, 0), insertion.Value)));

        return result.ContentEquals(text) ? solution : solution.WithDocumentText(original.Id, result);
    }

    private static IEnumerable<UsingDirectiveSyntax> Directives(SyntaxNode root) => root.DescendantNodes().OfType<UsingDirectiveSyntax>().Where(IsLocal);

    private static bool IsLocal(UsingDirectiveSyntax directive) => directive.GlobalKeyword.IsKind(SyntaxKind.None);

    private static SyntaxList<UsingDirectiveSyntax> UsingsOf(SyntaxNode? container) => container switch
    {
        CompilationUnitSyntax unit => unit.Usings,
        BaseNamespaceDeclarationSyntax declaration => declaration.Usings,
        _ => default,
    };

    private static string Key(UsingDirectiveSyntax directive) => Whitespace().Replace(directive.WithoutTrivia().ToString().Trim(), " ");

    /// <summary>The comments of a directive: the comment lines directly above it and the comment after it on its line.</summary>
    private static IEnumerable<DirectiveComment> CommentsOf(UsingDirectiveSyntax directive)
    {
        var key = Key(directive);
        foreach (var comment in CommentLinesAbove(directive))
        {
            yield return new DirectiveComment(key, comment.ToString(), Trailing: false);
        }

        var trailing = directive.GetTrailingTrivia().FirstOrDefault(IsComment);
        if (IsComment(trailing))
        {
            yield return new DirectiveComment(key, trailing.ToString(), Trailing: true);
        }
    }

    /// <summary>The comments on the lines directly above a directive, without a blank line between them and the directive.</summary>
    private static List<SyntaxTrivia> CommentLinesAbove(UsingDirectiveSyntax directive)
    {
        var leading = directive.GetLeadingTrivia();
        var comments = new List<SyntaxTrivia>();
        var index = SkipWhitespaceBackwards(leading, leading.Count - 1);
        while (index >= 0 && leading[index].IsKind(SyntaxKind.EndOfLineTrivia))
        {
            var end = SkipWhitespaceBackwards(leading, index - 1);
            if (end < 0 || !IsComment(leading[end]))
            {
                break;
            }

            comments.Insert(0, leading[end]);
            index = SkipWhitespaceBackwards(leading, end - 1);
        }

        return comments;
    }

    private static int SkipWhitespaceBackwards(SyntaxTriviaList trivia, int index)
    {
        while (index >= 0 && trivia[index].IsKind(SyntaxKind.WhitespaceTrivia))
        {
            index--;
        }

        return index;
    }

    private static bool IsComment(SyntaxTrivia trivia) => trivia.IsKind(SyntaxKind.SingleLineCommentTrivia) || trivia.IsKind(SyntaxKind.MultiLineCommentTrivia);

    /// <summary>
    /// The lines of a directive with the comment lines above it, when nothing else shares them and no preprocessor directive sits
    /// in its leading trivia; <see langword="null"/> otherwise.
    /// </summary>
    private static TextSpan? OwnLines(SourceText text, UsingDirectiveSyntax directive)
    {
        if (directive.GetLeadingTrivia().Any(trivia => trivia.IsDirective))
        {
            return null;
        }

        var start = CommentLinesAbove(directive) is [var first, ..] ? first.SpanStart : directive.SpanStart;
        var startLine = text.Lines.GetLineFromPosition(start);
        var endLine = text.Lines.GetLineFromPosition(directive.Span.End);
        if (!string.IsNullOrWhiteSpace(text.ToString(TextSpan.FromBounds(startLine.Start, start))) || directive.FullSpan.End < endLine.EndIncludingLineBreak)
        {
            return null;
        }

        return TextSpan.FromBounds(startLine.Start, endLine.EndIncludingLineBreak);
    }

    /// <summary>The names a directive binds first: the leftmost name of each type it names, apart from those qualified with <c>global::</c>.</summary>
    private static IEnumerable<string> FirstNames(UsingDirectiveSyntax directive) => directive.NamespaceOrType.DescendantNodesAndSelf()
        .OfType<SimpleNameSyntax>()
        .Where(name => name.Parent is not AliasQualifiedNameSyntax && (name.Parent is not QualifiedNameSyntax qualified || qualified.Left == name))
        .Select(name => name.Identifier.ValueText);

    /// <summary>
    /// The first of <paramref name="names"/> that a document of the project declares as a namespace or type only in some build
    /// configurations: the file is parsed with the symbols of the project, with none and with every symbol its conditions
    /// mention, and the declarations that are not in all of the three are the conditional ones.
    /// </summary>
    private static async Task<string?> FirstConditionalNameAsync(Project project, HashSet<string> names, CancellationToken cancellationToken)
    {
        foreach (var document in project.Documents)
        {
            if (await document.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false) is not CompilationUnitSyntax { ContainsDirectives: true } root
                || root.SyntaxTree.Options is not CSharpParseOptions options)
            {
                continue;
            }

            var text = root.ToFullString();
            var mentioned = names.Where(name => text.Contains(name, StringComparison.Ordinal)).ToList();
            if (mentioned.Count == 0)
            {
                continue;
            }

            var parses = new[] { DeclaredNames(root), DeclaredNames(Parse(text, options.WithPreprocessorSymbols())), DeclaredNames(Parse(text, options.WithPreprocessorSymbols(AllSymbols(root, text, options)))) };
            var conditional = parses.SelectMany(declared => declared).Where(declared => !parses.All(parse => parse.Contains(declared))).Select(declared => declared[(declared.LastIndexOf('.') + 1)..]).ToHashSet(StringComparer.Ordinal);
            if (mentioned.FirstOrDefault(conditional.Contains) is { } name)
            {
                return name;
            }
        }

        return null;
    }

    /// <summary>The symbols already defined plus every one a condition of the file mentions, as many rounds as parsing with them reveals new conditions.</summary>
    private static List<string> AllSymbols(CompilationUnitSyntax root, string text, CSharpParseOptions options)
    {
        var symbols = new HashSet<string>(options.PreprocessorSymbolNames, StringComparer.Ordinal);
        var current = root;
        bool added;
        do
        {
            added = false;
            foreach (var symbol in ConditionSymbols(current).ToList())
            {
                added |= symbols.Add(symbol);
            }

            if (added)
            {
                current = Parse(text, options.WithPreprocessorSymbols(symbols));
            }
        }
        while (added);

        return [.. symbols];
    }

    private static IEnumerable<string> ConditionSymbols(SyntaxNode root) => root.DescendantNodes(descendIntoTrivia: true)
        .Where(node => node is IfDirectiveTriviaSyntax or ElifDirectiveTriviaSyntax)
        .SelectMany(directive => directive.DescendantNodes().OfType<IdentifierNameSyntax>())
        .Select(name => name.Identifier.ValueText);

    private static CompilationUnitSyntax Parse(string text, CSharpParseOptions options) => CSharpSyntaxTree.ParseText(text, options).GetCompilationUnitRoot();

    /// <summary>The full names of the namespaces and types a tree declares, with every namespace and type they are nested in.</summary>
    private static HashSet<string> DeclaredNames(SyntaxNode root)
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var node in root.DescendantNodes().Where(node => node is BaseNamespaceDeclarationSyntax or BaseTypeDeclarationSyntax or DelegateDeclarationSyntax))
        {
            var path = new List<string>();
            foreach (var declaration in node.AncestorsAndSelf().Reverse())
            {
                IReadOnlyList<string> segments = declaration switch
                {
                    BaseNamespaceDeclarationSyntax @namespace => @namespace.Name.DescendantNodesAndSelf().OfType<IdentifierNameSyntax>().Select(name => name.Identifier.ValueText).ToList(),
                    BaseTypeDeclarationSyntax type => [type.Identifier.ValueText],
                    DelegateDeclarationSyntax @delegate => [@delegate.Identifier.ValueText],
                    _ => new List<string>(),
                };
                foreach (var segment in segments)
                {
                    path.Add(segment);
                    names.Add(string.Join('.', path));
                }
            }
        }

        return names;
    }

    [GeneratedRegex(@"\s+")]
    private static partial Regex Whitespace();

    private sealed record DirectiveComment(string Key, string Text, bool Trailing);
}
