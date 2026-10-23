using System.Text.RegularExpressions;
using CodeJanitor.Engine.Contracts;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Formatting;
using Microsoft.CodeAnalysis.Text;

namespace CodeJanitor.Engine.Diagnostics;

/// <summary>
/// <c>organizeUsings</c>: the Roslyn equivalent of the Visual Studio "Remove and Sort Usings" command. The using directives the
/// compiler reports as unnecessary (CS8019, which IDE0005 reports) are removed, except those of
/// <c>usingStatementsToReinsertWhenRemoved</c>, then the directives are sorted as the file's <c>.editorconfig</c> says
/// (<c>dotnet_sort_system_directives_first</c>, <c>dotnet_separate_import_directive_groups</c>). When <c>.editorconfig</c> sets
/// one of those keys the directives are sorted even with the setting off.
/// </summary>
public sealed partial class OrganizeUsingsStep : ICleanupStep
{
    private const string UnnecessaryUsingDiagnosticId = "CS8019";

    /// <inheritdoc/>
    public string Name => "Remove and sort using directives";

    /// <inheritdoc/>
    public string? RuleId => "organizeUsings";

    /// <inheritdoc/>
    public CleanupStage Stage => CleanupStage.Diagnostics;

    /// <inheritdoc/>
    public int Order => 100;

    /// <inheritdoc/>
    public bool IsEnabled(IEffectiveSettings settings) => settings.GetBool("organizeUsings") || SortsByEditorConfig(settings);

    /// <inheritdoc/>
    public async Task<Solution> ApplyAsync(Document document, IEffectiveSettings settings, CancellationToken cancellationToken)
    {
        var keep = settings.GetList("usingStatementsToReinsertWhenRemoved").Select(Normalize).ToHashSet(StringComparer.Ordinal);
        var cleaned = settings.GetBool("organizeUsings") ? await RemoveUnnecessaryUsingsAsync(document, keep, cancellationToken).ConfigureAwait(false) : document;
        var organized = await Formatter.OrganizeImportsAsync(cleaned, cancellationToken).ConfigureAwait(false);
        var text = await organized.GetTextAsync(cancellationToken).ConfigureAwait(false);

        return (await document.GetTextAsync(cancellationToken).ConfigureAwait(false)).ContentEquals(text)
            ? document.Project.Solution
            : organized.Project.Solution;
    }

    /// <summary>
    /// Whether <c>.editorconfig</c> sets the using order (<c>dotnet_sort_system_directives_first</c> or
    /// <c>dotnet_separate_import_directive_groups</c>, with no suffix or an enforcing one): the directives are then sorted in
    /// Roslyn's order even with <c>organizeUsings</c> off, without removing any.
    /// </summary>
    private static bool SortsByEditorConfig(IEffectiveSettings settings) =>
        IsSet(settings.EditorConfigValue("dotnet_sort_system_directives_first")) || IsSet(settings.EditorConfigValue("dotnet_separate_import_directive_groups"));

    private static bool IsSet(string? raw)
    {
        if (raw is null)
        {
            return false;
        }

        var parts = raw.Split(':');
        var enforced = true;

        return bool.TryParse(parts[0].Trim(), out _) && (parts.Length == 1 || (parts.Length == 2 && Settings.EffectiveSettings.TryParseSeverity(parts[1].Trim(), out enforced) && enforced));
    }

    /// <summary>
    /// Removes the using directives the compiler reports as unnecessary. A file with conditional compilation is left as it is,
    /// because a directive unused in the active configuration may be needed by another one. Only the lines of a directive are
    /// removed; a directive sharing its lines with other code or a comment is kept.
    /// </summary>
    internal static async Task<Document> RemoveUnnecessaryUsingsAsync(Document document, IReadOnlySet<string> keep, CancellationToken cancellationToken)
    {
        var root = await document.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false);
        if (root is null || root.DescendantTrivia().Any(trivia => trivia.IsKind(SyntaxKind.IfDirectiveTrivia)))
        {
            return document;
        }

        var semanticModel = await document.GetSemanticModelAsync(cancellationToken).ConfigureAwait(false);
        if (semanticModel is null)
        {
            return document;
        }

        var text = await document.GetTextAsync(cancellationToken).ConfigureAwait(false);
        var removals = new List<TextSpan>();
        foreach (var diagnostic in semanticModel.GetDiagnostics(cancellationToken: cancellationToken))
        {
            if (diagnostic.Id != UnnecessaryUsingDiagnosticId || !diagnostic.Location.IsInSource)
            {
                continue;
            }

            var usingDirective = root.FindNode(diagnostic.Location.SourceSpan).FirstAncestorOrSelf<UsingDirectiveSyntax>();
            if (usingDirective is null || keep.Contains(Normalize(usingDirective.ToString())))
            {
                continue;
            }

            if (TryGetWholeLinesSpan(text, usingDirective, out var span))
            {
                removals.Add(span);
            }
        }

        if (removals.Count == 0)
        {
            return document;
        }

        var changes = new List<TextChange>();
        foreach (var block in MergeAdjacent(removals.Distinct().OrderBy(span => span.Start)))
        {
            var end = block.End;
            if (block.Start == 0 || IsBlank(text.Lines.GetLineFromPosition(block.Start - 1)))
            {
                while (end < text.Length)
                {
                    var line = text.Lines.GetLineFromPosition(end);
                    if (!IsBlank(line) || line.EndIncludingLineBreak == line.End)
                    {
                        break;
                    }

                    end = line.EndIncludingLineBreak;
                }
            }

            changes.Add(new TextChange(TextSpan.FromBounds(block.Start, end), string.Empty));
        }

        return document.WithText(text.WithChanges(changes));
    }

    private static IEnumerable<TextSpan> MergeAdjacent(IEnumerable<TextSpan> orderedSpans)
    {
        TextSpan? current = null;
        foreach (var span in orderedSpans)
        {
            if (current is { } open && span.Start <= open.End)
            {
                current = TextSpan.FromBounds(open.Start, Math.Max(open.End, span.End));
            }
            else
            {
                if (current is { } done)
                {
                    yield return done;
                }

                current = span;
            }
        }

        if (current is { } last)
        {
            yield return last;
        }
    }

    private static bool IsBlank(TextLine line) => string.IsNullOrWhiteSpace(line.ToString());

    private static bool TryGetWholeLinesSpan(SourceText text, UsingDirectiveSyntax usingDirective, out TextSpan span)
    {
        span = default;
        var firstLine = text.Lines.GetLineFromPosition(usingDirective.Span.Start);
        var lastLine = text.Lines.GetLineFromPosition(usingDirective.Span.End);
        var before = text.ToString(TextSpan.FromBounds(firstLine.Start, usingDirective.Span.Start));
        var after = text.ToString(TextSpan.FromBounds(usingDirective.Span.End, lastLine.End));
        if (!string.IsNullOrWhiteSpace(before) || !string.IsNullOrWhiteSpace(after))
        {
            return false;
        }

        span = TextSpan.FromBounds(firstLine.Start, lastLine.EndIncludingLineBreak);

        return true;
    }

    private static string Normalize(string usingDirective) => Whitespace().Replace(usingDirective.Trim(), " ");

    [GeneratedRegex(@"\s+")]
    private static partial Regex Whitespace();
}
