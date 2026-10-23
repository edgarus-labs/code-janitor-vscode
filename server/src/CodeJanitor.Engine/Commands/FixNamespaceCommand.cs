using System.Text.Json;
using System.Text.Json.Nodes;
using CodeJanitor.Engine.Contracts;
using CodeJanitor.Engine.Diagnostics;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;

namespace CodeJanitor.Engine.Commands;

/// <summary>
/// The Fix Namespace command (<c>fixNamespace</c>): Roslyn's "Namespace does not match folder structure" analyzer and code fix
/// (IDE0130, <c>dotnet_style_namespace_match_folder</c>) and no other rule, so the references to the moved types are updated
/// in other files too. The expected namespace is the project's root namespace plus the folders of the file, or
/// <c>arguments.namespace</c> when given. A file IDE0130 does not report (a type declared in several files, no namespace) is
/// left as it is. Where the workspace cannot change document folders (<c>MSBuildWorkspace</c>), the same fix comes from
/// <see cref="NamespaceToMatchFolderCodeFixProvider"/>.
/// </summary>
public sealed class FixNamespaceCommand : IDocumentCommand
{
    private static readonly DiagnosticCleanupEngine Engine = new(new CodeFixProviderCatalog([new NamespaceToMatchFolderCodeFixProvider()], HostAnalyzers.References));

    /// <inheritdoc/>
    public string Name => "fixNamespace";

    /// <inheritdoc/>
    public async Task<Solution> ExecuteAsync(Document document, IEffectiveSettings settings, JsonObject? arguments, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(document);
        var original = document.Project.Solution;
        var expected = arguments?["namespace"] is JsonValue value && value.GetValueKind() == JsonValueKind.String ? value.GetValue<string>().Trim() : null;
        var working = string.IsNullOrEmpty(expected) ? document : WithExpectedNamespace(document, expected);

        var result = await Engine.CleanupAsync(working, DiagnosticCleanupOptions.NamespaceMatchFolder, cancellationToken).ConfigureAwait(false);
        if (!result.HasChanges)
        {
            return original;
        }

        var solution = original;
        foreach (var projectChanges in result.ChangedSolution.GetChanges(result.OriginalSolution).GetProjectChanges())
        {
            foreach (var documentId in projectChanges.GetChangedDocuments(onlyGetDocumentsWithTextChanges: true))
            {
                if (original.GetDocument(documentId) is not null)
                {
                    var text = await result.ChangedSolution.GetDocument(documentId)!.GetTextAsync(cancellationToken).ConfigureAwait(false);
                    solution = solution.WithDocumentText(documentId, text);
                }
            }
        }

        return solution;
    }

    /// <summary>
    /// The document in a solution whose project has a global analyzer config, above every other, making
    /// <paramref name="expectedNamespace"/> the expected namespace of the file: the root namespace (and default namespace), with the file's
    /// directory as the project directory.
    /// </summary>
    private static Document WithExpectedNamespace(Document document, string expectedNamespace)
    {
        var directory = Path.GetDirectoryName(document.FilePath) ?? throw new InvalidOperationException($"'{document.Name}' has no file path, so its namespace cannot be fixed.");
        var configPath = Path.Combine(directory, "CodeJanitor.FixNamespace.globalconfig");
        var config = $"is_global = true\nglobal_level = 1000\nbuild_property.RootNamespace = {expectedNamespace}\nbuild_property.ProjectDir = {directory}{Path.DirectorySeparatorChar}\n";
        var solution = document.Project.Solution
            .AddAnalyzerConfigDocument(DocumentId.CreateNewId(document.Project.Id), Path.GetFileName(configPath), SourceText.From(config), filePath: configPath)
            .WithProjectDefaultNamespace(document.Project.Id, expectedNamespace);

        return solution.GetDocument(document.Id)!;
    }
}
