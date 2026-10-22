using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace CodeJanitor.Engine.Pipeline;

/// <summary>
/// Cleanup of only the lines changed since the last commit (<c>onlyChangedLines</c>):
/// a step's changes are kept on changed lines and dropped elsewhere; a step whose change covers both changed and unchanged
/// lines is skipped.
/// </summary>
internal static class ChangedLines
{
    /// <summary>
    /// <paramref name="after"/> restricted to the changed lines of <paramref name="before"/>, with the changed lines renumbered
    /// for it and the number of kept regions, or null when a change covers changed and unchanged lines or the changes left
    /// out cannot be left out safely: the result must parse as well and <paramref name="redo"/> of it must give
    /// <paramref name="after"/> again.
    /// </summary>
    public static async Task<(string Text, IReadOnlySet<int> Lines, int Regions)?> KeepAsync(
        Document document,
        string before,
        string after,
        IReadOnlySet<int> changed,
        Func<string, Task<string>> redo,
        CancellationToken cancellationToken)
    {
        var hunks = LineDiff.Hunks(before, after);
        var kept = new List<LineHunk>();
        foreach (var hunk in hunks)
        {
            var touched = hunk.BeforeEnd > hunk.BeforeStart
                ? Enumerable.Range(hunk.BeforeStart, hunk.BeforeEnd - hunk.BeforeStart).ToArray()
                : [hunk.BeforeStart - 1, hunk.BeforeStart];
            var onChanged = touched.Count(changed.Contains);
            if (onChanged > 0 && onChanged < touched.Length && hunk.BeforeEnd > hunk.BeforeStart)
            {
                return null;
            }

            if (onChanged > 0)
            {
                kept.Add(hunk);
            }
        }

        if (kept.Count == 0)
        {
            return (before, changed, 0);
        }

        var text = kept.Count == hunks.Count ? after : LineDiff.ApplyHunks(before, after, kept);
        if (text != after
            && (ParseErrorCount(document, text, cancellationToken) > ParseErrorCount(document, before, cancellationToken)
                || await redo(text).ConfigureAwait(false) != after))
        {
            return null;
        }

        return (text, Renumber(changed, kept), kept.Count);
    }

    /// <summary>The changed lines after applying <paramref name="kept"/>: the lines the hunks wrote are changed too.</summary>
    public static IReadOnlySet<int> Renumber(IReadOnlySet<int> changed, IReadOnlyList<LineHunk> kept)
    {
        var sorted = changed.Order().ToList();
        var next = new HashSet<int>();
        var shift = 0;
        var index = 0;
        foreach (var hunk in kept)
        {
            for (; index < sorted.Count && sorted[index] < hunk.BeforeStart; index++)
            {
                next.Add(sorted[index] + shift);
            }

            while (index < sorted.Count && sorted[index] < hunk.BeforeEnd)
            {
                index++;
            }

            for (var line = 0; line < hunk.AfterEnd - hunk.AfterStart; line++)
            {
                next.Add(hunk.BeforeStart + shift + line);
            }

            shift += hunk.AfterEnd - hunk.AfterStart - (hunk.BeforeEnd - hunk.BeforeStart);
        }

        for (; index < sorted.Count; index++)
        {
            next.Add(sorted[index] + shift);
        }

        return next;
    }

    private static int ParseErrorCount(Document document, string text, CancellationToken cancellationToken) =>
        CSharpSyntaxTree.ParseText(text, document.Project.ParseOptions as CSharpParseOptions, cancellationToken: cancellationToken)
            .GetDiagnostics(cancellationToken)
            .Count(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error);
}
