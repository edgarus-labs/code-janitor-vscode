using CodeJanitor.Engine.Diagnostics;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;
using Xunit;

namespace CodeJanitor.Engine.Tests.Diagnostics;

/// <summary>
/// A file compiled by several projects or target frameworks (linked files, multi-targeting) has one document per flavor: a
/// fix computed in one flavor is accepted only when it adds no compiler error in any of them, and then applies to all of them.
/// </summary>
public sealed class LinkedFileFlavorTests
{
    private const string Target = "namespace Company.App\n{\n    using Services;\n\n    class C { Svc s; }\n}\n";
    private const string MovedTarget = "using Company.App.Services;\n\nnamespace Company.App\n{\n    class C { Svc s; }\n}\n";
    private const string NestedServicesLibrary = "namespace Company.App.Services { public class Svc { } }\n";
    private const string GlobalServicesLibrary = "namespace Services { public class Svc { } }\n";

    private static readonly string Root = Path.Combine(Path.GetTempPath(), "CodeJanitor.FlavorTests");
    private static readonly string TargetPath = Path.Combine(Root, "Shared", "Target.cs");

    private static readonly Dictionary<string, string> MoveUsingsOutside = new()
    {
        ["csharp_using_directive_placement"] = "outside_namespace:suggestion",
        ["dotnet_diagnostic.IDE0065.severity"] = "suggestion",
    };

    [Fact]
    public async Task AFixThatBreaksAnotherProjectCompilingTheFile_IsRejected()
    {
        // In App "Services" means Company.App.Services; in Tool it is the global Services namespace (CS0234 after the move).
        var solution = CreateSolution(("App", NestedServicesLibrary), ("Tool", GlobalServicesLibrary));

        var result = await CleanupInAppAsync(solution);

        Assert.Same(solution, result.ChangedSolution);
        Assert.Equal(UnresolvedDiagnosticReason.FixRejectedIntroducesCompilerErrors, Assert.Single(result.Unresolved).Reason);
    }

    [Fact]
    public async Task AFixValidInEveryProject_IsAppliedToEveryFlavorOfTheFile()
    {
        var solution = CreateSolution(("App", NestedServicesLibrary), ("Tool", NestedServicesLibrary));

        var result = await CleanupInAppAsync(solution);

        foreach (var documentId in result.ChangedSolution.GetDocumentIdsWithFilePath(TargetPath))
        {
            Assert.Equal(MovedTarget, (await result.ChangedSolution.GetDocument(documentId)!.GetTextAsync()).ToString());
        }
    }

    [Fact]
    public async Task AFileOfASingleProject_IsValidatedInThatProjectOnly()
    {
        var solution = CreateSolution(("App", NestedServicesLibrary));

        var result = await CleanupInAppAsync(solution);

        var documentId = Assert.Single(result.ChangedSolution.GetDocumentIdsWithFilePath(TargetPath));
        Assert.Equal(MovedTarget, (await result.ChangedSolution.GetDocument(documentId)!.GetTextAsync()).ToString());
    }

    private static Task<DiagnosticCleanupResult> CleanupInAppAsync(Solution solution)
    {
        var appDocumentId = solution.GetDocumentIdsWithFilePath(TargetPath).Single(id => solution.GetProject(id.ProjectId)!.Name == "App");

        return new DiagnosticCleanupEngine().CleanupAsync(
            solution.GetDocument(appDocumentId)!,
            new DiagnosticCleanupOptions([DiagnosticCleanupCategory.CodeStyle], analyzerConfigOverrides: MoveUsingsOutside),
            CancellationToken.None);
    }

    private static Solution CreateSolution(params (string Name, string LibrarySource)[] projects)
    {
        var solution = new AdhocWorkspace(HostAnalyzers.HostServices).CurrentSolution;
        foreach (var (name, librarySource) in projects)
        {
            var projectId = ProjectId.CreateNewId(name);
            solution = solution.AddProject(ProjectInfo.Create(
                projectId,
                VersionStamp.Create(),
                name,
                name,
                LanguageNames.CSharp,
                filePath: Path.Combine(Root, name, name + ".csproj"),
                compilationOptions: new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary),
                parseOptions: new CSharpParseOptions(LanguageVersion.Latest),
                metadataReferences: [MetadataReference.CreateFromFile(typeof(object).Assembly.Location)]));

            solution = solution
                .AddDocument(DocumentInfo.Create(DocumentId.CreateNewId(projectId), "Library.cs", loader: TextLoader.From(TextAndVersion.Create(SourceText.From(librarySource), VersionStamp.Create())), filePath: Path.Combine(Root, name, "Library.cs")))
                .AddDocument(DocumentInfo.Create(DocumentId.CreateNewId(projectId), "Target.cs", loader: TextLoader.From(TextAndVersion.Create(SourceText.From(Target), VersionStamp.Create())), filePath: TargetPath));
        }

        return solution;
    }
}
