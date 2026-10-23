using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;
using Xunit;
using Xunit.Abstractions;

namespace CodeJanitor.Engine.Tests.Testbed;

/// <summary>
/// The compiler check ("builds ... with every option on at once"): every cleanup scenario file of the testbed is
/// cleaned with every option on (and Reorganize at the start of cleanup) in one solution, which must then compile without
/// errors, as the unfixed testbed does.
/// </summary>
public sealed class TestbedCompileTests(ITestOutputHelper output)
{
    [Fact]
    public async Task TheWholeTestbedCompilesAfterTheCleanupWithEveryOptionOn()
    {
        Assert.True(TestbedScenarios.IsAvailable, TestbedHelp.Missing);
        var settings = TestbedScenarios.EverythingOn();
        ((JsonObject)settings["reorganize"]!)["runAtStartOfCleanup"] = true;
        var engine = new CleanupEngine();
        var solution = TestbedScenarios.Solution;
        var changed = 0;

        foreach (var scenario in TestbedScenarios.All.Where(candidate => candidate.Entry == "cleanup"))
        {
            var documentId = solution.GetDocumentIdsWithFilePath(scenario.FullPath).FirstOrDefault();
            if (documentId is null)
            {
                continue;
            }

            var document = solution.GetDocument(documentId)!;
            var outcome = await engine.CleanupAsync(document, new Contracts.CleanupRequest(settings, [], null), CancellationToken.None);
            var text = await outcome.Solution.GetDocument(documentId)!.GetTextAsync();
            if (!text.ContentEquals(await document.GetTextAsync()))
            {
                changed++;
                solution = solution.WithDocumentText(documentId, text);
            }
        }

        var errors = new List<string>();
        foreach (var project in solution.Projects)
        {
            var compilation = await project.GetCompilationAsync();
            errors.AddRange(compilation!.GetDiagnostics()
                .Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error)
                .Select(diagnostic => $"{Path.GetFileName(diagnostic.Location.SourceTree?.FilePath)}: {diagnostic.Id} {diagnostic.GetMessage()}"));
        }

        output.WriteLine($"{changed} scenario files changed; {errors.Count} compiler errors.");
        Assert.True(errors.Count == 0, string.Join("\n", errors));
    }
}
