using CodeJanitor.Engine.Contracts;
using Microsoft.CodeAnalysis;

namespace CodeJanitor.Server;

/// <summary>Turns what the engine did to a solution into the protocol's <see cref="CleanupResult"/>.</summary>
internal static class ResultMapper
{
    /// <summary>
    /// Diffs <see cref="CleanupOutcome.Solution"/> against the solution of <paramref name="original"/>: the new text of the
    /// requested file, the changed texts of other existing files and the files the solution gained.
    /// </summary>
    public static async Task<CleanupResult> MapAsync(Document original, CleanupOutcome outcome, IEnumerable<string> hostIssues, IEnumerable<string> hostWarnings, CancellationToken cancellationToken)
    {
        var originalText = await original.GetTextAsync(cancellationToken).ConfigureAwait(false);
        var changedDocument = outcome.Solution.GetDocument(original.Id);
        var text = changedDocument is null
            ? TextConventions.ToProtocolText(originalText, originalText)
            : TextConventions.ToProtocolText(originalText, await changedDocument.GetTextAsync(cancellationToken).ConfigureAwait(false));

        var requestedPath = original.FilePath;
        var seen = new HashSet<string>(PathComparer.Instance);
        if (requestedPath is not null)
        {
            seen.Add(requestedPath);
        }

        var otherFiles = new List<FileText>();
        var newFiles = new List<FileText>();
        foreach (var projectChanges in outcome.Solution.GetChanges(original.Project.Solution).GetProjectChanges())
        {
            foreach (var id in projectChanges.GetChangedDocuments(onlyGetDocumentsWithTextChanges: true))
            {
                var before = projectChanges.OldProject.GetDocument(id)!;
                if (id == original.Id || before.FilePath is not { } path || !seen.Add(path))
                {
                    continue;
                }

                var after = projectChanges.NewProject.GetDocument(id)!;
                otherFiles.Add(new FileText(
                    path,
                    TextConventions.ToProtocolText(
                        await before.GetTextAsync(cancellationToken).ConfigureAwait(false),
                        await after.GetTextAsync(cancellationToken).ConfigureAwait(false))));
            }

            foreach (var id in projectChanges.GetAddedDocuments())
            {
                var added = projectChanges.NewProject.GetDocument(id)!;
                var path = added.FilePath ?? Path.Combine(Path.GetDirectoryName(requestedPath) ?? string.Empty, added.Name);
                if (!seen.Add(path))
                {
                    continue;
                }

                newFiles.Add(new FileText(path, TextConventions.ToProtocolText(originalText, await added.GetTextAsync(cancellationToken).ConfigureAwait(false))));
            }
        }

        return new CleanupResult(text, otherFiles, newFiles, outcome.Rules, outcome.Unresolved, [.. hostIssues, .. outcome.Issues], outcome.Failures, [.. hostWarnings]);
    }
}
