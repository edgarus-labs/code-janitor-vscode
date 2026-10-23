using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;
using Xunit;

namespace CodeJanitor.Engine.Tests.Testbed;

public sealed class TestbedScenariosTests
{
    [Fact]
    public void LoadsEveryScenarioOfTheTestbed()
    {
        Assert.True(TestbedScenarios.IsAvailable, TestbedHelp.Missing);
        Assert.True(TestbedScenarios.All.Count > 400);
        Assert.All(TestbedScenarios.All, scenario => Assert.True(File.Exists(scenario.FullPath), scenario.Id));
    }

    [Fact]
    public async Task TheTestbedProjectsCompileWithoutErrors()
    {
        foreach (var project in TestbedScenarios.Solution.Projects)
        {
            var compilation = await project.GetCompilationAsync();
            var errors = compilation!.GetDiagnostics().Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error).Take(5).ToList();

            Assert.True(errors.Count == 0, $"{project.Name}: {string.Join("\n", errors)}");
        }
    }

    [Fact]
    public void TheSealingScenariosBelongToTheirLibraryProject()
    {
        var document = TestbedScenarios.CreateDocument(TestbedScenarios.Get("SealClassesWhenSafe"));

        Assert.Equal("Scenarios.Sealing", document.Project.Name);
        Assert.Equal(OutputKind.DynamicallyLinkedLibrary, document.Project.CompilationOptions!.OutputKind);
    }

    [Fact]
    public void SettingsOfTurnsOnlyTheScenarioOptionOn()
    {
        var settings = TestbedScenarios.SettingsOf(TestbedScenarios.Get("ConvertToFileScopedNamespace"));

        Assert.True(settings["convertToFileScopedNamespace"]!.GetValue<bool>());
        Assert.False(settings["removeRegions"]!.GetValue<bool>());
        Assert.Equal(string.Empty, settings["fileHeaderCSharp"]!.GetValue<string>());
    }

    [Fact]
    public void SettingsOfWritesTheHeaderEnumsAsProtocolStrings()
    {
        var settings = TestbedScenarios.SettingsOf(TestbedScenarios.Get("FileHeaderPositionAfterUsings"));

        Assert.Equal("afterUsings", settings["fileHeaderPosition"]!.GetValue<string>());
    }

    [Fact]
    public void ADocumentOfAProjectFileHasItsEditorConfig()
    {
        var document = TestbedScenarios.CreateDocument(TestbedScenarios.Get("EditorConfigVarPreference"));

        Assert.Equal("Scenarios", document.Project.Name);
        Assert.Contains(document.Project.AnalyzerConfigDocuments, config => config.FilePath!.Replace('\\', '/').EndsWith("EditorConfigVarPreference/.editorconfig", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("""{"t":"contains","s":"b"}""", null)]
    [InlineData("""{"t":"absent","s":"b"}""", "expected the output NOT to contain \"b\"")]
    [InlineData("""{"t":"order","s":["a","c"]}""", null)]
    [InlineData("""{"t":"noBlankBetween","a":"a","b":"c"}""", "expected no blank line between \"a\" and \"c\"")]
    [InlineData("""{"t":"nope"}""", "unknown check type \"nope\"")]
    public void EvaluatesChecks(string check, string? expected)
    {
        Assert.Equal(expected, TestbedScenarios.Failure((JsonObject)JsonNode.Parse(check)!, "a\r\n\r\nb\nc", []));
    }
}
