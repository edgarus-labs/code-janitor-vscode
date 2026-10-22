using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CodeActions;
using Microsoft.CodeAnalysis.CodeFixes;
using Microsoft.CodeAnalysis.Rename;

namespace CodeJanitor.Engine.Commands;

/// <summary>
/// Roslyn's "Change namespace to match folder structure" fix (IDE0130) for a workspace that cannot change the name or folders
/// of a document, such as <c>MSBuildWorkspace</c>: Roslyn's own provider registers nothing there, although the fix only changes
/// document texts. The fix is Roslyn's: <see cref="Renamer.RenameDocumentAsync(Document, DocumentRenameOptions, string, IReadOnlyList{string}?, CancellationToken)"/>
/// to the folders of the target namespace, which syncs the namespace of the document and its references.
/// </summary>
internal sealed class NamespaceToMatchFolderCodeFixProvider : CodeFixProvider
{
    private const string DiagnosticId = "IDE0130";
    private const string TargetNamespaceProperty = "TargetNamespace";
    private const string ForcedFolder = "Force-Namespace-Change";

    public override ImmutableArray<string> FixableDiagnosticIds => [DiagnosticId];

    public override FixAllProvider? GetFixAllProvider() => null;

    public override Task RegisterCodeFixesAsync(CodeFixContext context)
    {
        var document = context.Document;
        var targets = context.Diagnostics.Select(diagnostic => diagnostic.Properties.GetValueOrDefault(TargetNamespaceProperty)).Distinct(StringComparer.Ordinal).ToList();
        if (document.Project.Solution.Workspace.CanApplyChange(ApplyChangesKind.ChangeDocumentInfo) || targets is not [{ } target])
        {
            return Task.CompletedTask;
        }

        context.RegisterCodeFix(
            CodeAction.Create("Change namespace to match folder structure", cancellationToken => ChangeNamespaceAsync(document, target, cancellationToken), nameof(NamespaceToMatchFolderCodeFixProvider)),
            context.Diagnostics);

        return Task.CompletedTask;
    }

    private static async Task<Solution> ChangeNamespaceAsync(Document document, string targetNamespace, CancellationToken cancellationToken)
    {
        // A folder the target namespace cannot have makes the rename see a namespace change, as Roslyn's fix does.
        var forced = document.WithFolders(document.Folders.Append(ForcedFolder));
        var actions = await Renamer.RenameDocumentAsync(forced, new DocumentRenameOptions(), forced.Name, FoldersOf(targetNamespace, document.Project.DefaultNamespace), cancellationToken).ConfigureAwait(false);

        return await actions.UpdateSolutionAsync(forced.Project.Solution, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>The folders of a namespace under the root namespace (Roslyn's <c>PathMetadataUtilities.BuildFoldersFromNamespace</c>).</summary>
    private static string[] FoldersOf(string targetNamespace, string? rootNamespace)
    {
        if (targetNamespace == rootNamespace)
        {
            return [];
        }

        var relative = rootNamespace is not null && targetNamespace.StartsWith(rootNamespace + ".", StringComparison.OrdinalIgnoreCase)
            ? targetNamespace[(rootNamespace.Length + 1)..]
            : targetNamespace;

        return relative.Split('.', StringSplitOptions.RemoveEmptyEntries);
    }
}
