using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;

namespace CodeJanitor.Engine.Diagnostics;

/// <summary>
/// Reads and compares the Error-severity compiler diagnostics of a project. A change introduces an error when an error
/// after it matches no remaining error before it (counting duplicates). Errors match when they have the same id and
/// file path and either the same message (so code that only moves keeps its errors) or the same position once the
/// position before is mapped through the text changes of its document (so an error whose message names a renamed
/// symbol keeps matching). Removing one error while adding a different one is therefore still an introduced error.
/// </summary>
internal static class CompilerErrors
{
    /// <summary>
    /// Gets the Error-severity compiler diagnostics of the project.
    /// </summary>
    /// <param name="project">The project.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>The errors, empty when the project has no compilation.</returns>
    internal static async Task<IReadOnlyList<Diagnostic>> GetAsync(Project project, CancellationToken cancellationToken)
    {
        var compilation = await project.GetCompilationAsync(cancellationToken).ConfigureAwait(false);

        return compilation is null
            ? []
            : compilation.GetDiagnostics(cancellationToken).Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error).ToList();
    }

    /// <summary>
    /// Finds the first error of <paramref name="afterErrors" /> that matches no remaining error of
    /// <paramref name="beforeErrors" />, counting duplicates. Errors with an equal message are matched first (see
    /// <see cref="CompilerErrorMatching.MatchByMessage" />); the rest are matched by position through the text changes
    /// between the two projects.
    /// </summary>
    /// <param name="before">The project before the change.</param>
    /// <param name="beforeErrors">The errors of <paramref name="before" />.</param>
    /// <param name="after">The same project after the change.</param>
    /// <param name="afterErrors">The errors of <paramref name="after" />.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>The first new error, otherwise null.</returns>
    internal static async Task<Diagnostic?> FindFirstNewAsync(
        Project before,
        IReadOnlyList<Diagnostic> beforeErrors,
        Project after,
        IReadOnlyList<Diagnostic> afterErrors,
        CancellationToken cancellationToken)
    {
        var (unmatched, remaining) = CompilerErrorMatching.MatchByMessage(beforeErrors, afterErrors);
        if (unmatched.Count == 0)
        {
            return null;
        }

        var remainingByLocation = remaining
            .Where(error => error.Location.IsInSource)
            .GroupBy(GetLocationKey)
            .ToDictionary(group => group.Key, group => group.ToList());
        var changesByFilePath = await GetTextChangesByFilePathAsync(before, after, cancellationToken).ConfigureAwait(false);

        foreach (var error in unmatched)
        {
            if (!error.Location.IsInSource
                || !remainingByLocation.TryGetValue(GetLocationKey(error), out var candidates))
            {
                return error;
            }

            if (!changesByFilePath.TryGetValue(error.Location.SourceTree!.FilePath, out var changes))
            {
                changes = [];
            }

            var index = candidates.FindIndex(candidate => MapsTo(candidate.Location.SourceSpan, changes, error.Location.SourceSpan));
            if (index < 0)
            {
                return error;
            }

            candidates.RemoveAt(index);
        }

        return null;
    }

    /// <summary>
    /// Gets the text changes (old to new) of every document whose text differs between the two projects, keyed by the
    /// file path of its syntax tree, which is the file path of its diagnostics.
    /// </summary>
    private static async Task<Dictionary<string, IReadOnlyList<TextChange>>> GetTextChangesByFilePathAsync(Project before, Project after, CancellationToken cancellationToken)
    {
        var changesByFilePath = new Dictionary<string, IReadOnlyList<TextChange>>(StringComparer.Ordinal);

        foreach (var documentId in after.GetChanges(before).GetChangedDocuments(onlyGetDocumentsWithTextChanges: true))
        {
            var oldDocument = before.GetDocument(documentId)!;
            var newDocument = after.GetDocument(documentId)!;
            var tree = await newDocument.GetSyntaxTreeAsync(cancellationToken).ConfigureAwait(false);
            if (tree is null)
            {
                continue;
            }

            var changes = await newDocument.GetTextChangesAsync(oldDocument, cancellationToken).ConfigureAwait(false);
            changesByFilePath[tree.FilePath] = changes.ToList();
        }

        return changesByFilePath;
    }

    /// <summary>
    /// Determines whether a span of the old text maps to <paramref name="newSpan" /> in the new text: a change entirely
    /// before the span shifts it, a change entirely inside it resizes it, and a change overlapping one of its boundaries
    /// makes it unmappable. An insertion exactly at a boundary may belong inside or outside the span (text diffs trim
    /// the common prefix and suffix, so renaming <c>Get</c> to <c>GetAsync</c> or <c>count</c> to <c>_count</c> is a
    /// pure boundary insertion), so either interpretation of each boundary matches.
    /// </summary>
    private static bool MapsTo(TextSpan span, IReadOnlyList<TextChange> changes, TextSpan newSpan)
    {
        var startDelta = 0;
        var endDelta = 0;
        var optionalStartDelta = 0;
        var optionalEndDelta = 0;

        foreach (var change in changes)
        {
            var delta = (change.NewText?.Length ?? 0) - change.Span.Length;
            if (change.Span.IsEmpty && (change.Span.Start == span.Start || change.Span.Start == span.End))
            {
                if (change.Span.Start == span.Start)
                {
                    // Outside shifts the start; inside grows the span, so the end shifts either way unless the span is
                    // empty, where the insertion may also lie after it.
                    optionalStartDelta += delta;
                    if (span.IsEmpty)
                    {
                        optionalEndDelta += delta;
                    }
                    else
                    {
                        endDelta += delta;
                    }
                }
                else
                {
                    optionalEndDelta += delta;
                }
            }
            else if (change.Span.End <= span.Start)
            {
                startDelta += delta;
                endDelta += delta;
            }
            else if (change.Span.Start >= span.End)
            {
                continue;
            }
            else if (change.Span.Start >= span.Start && change.Span.End <= span.End)
            {
                endDelta += delta;
            }
            else
            {
                return false;
            }
        }

        var start = span.Start + startDelta;
        var end = span.End + endDelta;

        return (newSpan.Start == start || newSpan.Start == start + optionalStartDelta)
            && (newSpan.End == end || newSpan.End == end + optionalEndDelta);
    }

    private static (string Id, string FilePath) GetLocationKey(Diagnostic diagnostic) =>
        (diagnostic.Id, diagnostic.Location.SourceTree!.FilePath);
}
