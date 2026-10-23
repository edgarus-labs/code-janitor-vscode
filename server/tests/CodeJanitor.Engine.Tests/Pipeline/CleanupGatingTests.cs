using System.Text.Json.Nodes;
using CodeJanitor.Engine.Commands;
using CodeJanitor.Engine.Contracts;
using CodeJanitor.Engine.Diagnostics;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;
using Xunit;

namespace CodeJanitor.Engine.Tests.Pipeline;

/// <summary>
/// What a cleanup on save and a partial cleanup (a file outside the workspace folders) leave out: the using directives
/// with <c>skipOrganizeUsingsDuringCleanupOnSave</c> (always for a partial cleanup), and every change to another file.
/// </summary>
public sealed class CleanupGatingTests
{
    private const string UsingsInsideNamespace = "namespace N\n{\n    using System.Text;\n    using System;\n\n    class C\n    {\n        int count;\n    }\n}\n";
    private const string UsingsInsideNamespaceKept = "    using System.Text;\n    using System;\n";
    private const string UsingRulesEditorConfig = "root = true\n[*.cs]\ndotnet_diagnostic.IDE0005.severity = warning\n";
    private const string TwoClasses = "public class Sample\n{\n}\n\npublic class Other\n{\n}\n";
    private const string Sa1402 = "root = true\n[*.cs]\ndotnet_diagnostic.SA1402.severity = warning\n";
    private const string PublicFieldNaming = "root = true\n[*.cs]\ndotnet_naming_rule.fields.symbols = fields\ndotnet_naming_rule.fields.style = upper\ndotnet_naming_rule.fields.severity = warning\ndotnet_naming_symbols.fields.applicable_kinds = field\ndotnet_naming_style.upper.capitalization = pascal_case\n";

    private static readonly string Root = Path.Combine(Path.GetTempPath(), "CodeJanitor.GatingTests");

    [Fact]
    public async Task OnSave_WithSkipOrganizeUsings_LeavesTheUsingDirectivesAsTheyAre()
    {
        var document = CreateDocument(UsingsInsideNamespace, UsingRulesEditorConfig);

        var outcome = await UsingsEngine().CleanupAsync(document, UsingsRequest(skipOnSave: true, onSave: true), CancellationToken.None);

        Assert.Contains(UsingsInsideNamespaceKept, await TextAsync(outcome), StringComparison.Ordinal);
        Assert.Contains(new RuleOutcome("organizeUsings", "Remove and sort using directives", 0, Included: false), outcome.Rules);
    }

    [Fact]
    public async Task OnSave_WithoutSkipOrganizeUsings_OrganizesTheUsingDirectives()
    {
        var document = CreateDocument(UsingsInsideNamespace, UsingRulesEditorConfig);

        var outcome = await UsingsEngine().CleanupAsync(document, UsingsRequest(skipOnSave: false, onSave: true), CancellationToken.None);

        Assert.DoesNotContain("using System.Text;", await TextAsync(outcome), StringComparison.Ordinal);
    }

    [Fact]
    public async Task SkipOrganizeUsings_DoesNotApplyToACleanupCommand()
    {
        var document = CreateDocument(UsingsInsideNamespace, UsingRulesEditorConfig);

        var outcome = await UsingsEngine().CleanupAsync(document, UsingsRequest(skipOnSave: true, onSave: false), CancellationToken.None);

        Assert.DoesNotContain("using System.Text;", await TextAsync(outcome), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Partial_LeavesTheUsingDirectivesAsTheyAre_WhateverTheOnSaveSetting()
    {
        var document = CreateDocument(UsingsInsideNamespace, UsingRulesEditorConfig);

        var outcome = await UsingsEngine().CleanupAsync(document, UsingsRequest(skipOnSave: false, onSave: false, partial: true), CancellationToken.None);

        Assert.Contains(UsingsInsideNamespaceKept, await TextAsync(outcome), StringComparison.Ordinal);
    }

    [Fact]
    public async Task OnSave_OneTypePerFile_ReportsTheTypesItWouldMove_WithoutCreatingFiles()
    {
        var document = CreateDocument(TwoClasses, Sa1402);

        var outcome = await new CleanupEngine([new OneTypePerFileStep()]).CleanupAsync(document, Request(onSave: true), CancellationToken.None);

        Assert.Single(outcome.Solution.Projects.Single().Documents);
        Assert.Equal(TwoClasses, await TextAsync(outcome));
        Assert.Contains(outcome.Issues, issue => issue.StartsWith("SA1402 (warning) line 5: type 'Other' was not moved to its own file because cleanup on save does not create files", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Partial_OneTypePerFile_ReportsTheTypesItWouldMove_WithoutCreatingFiles()
    {
        var document = CreateDocument(TwoClasses, Sa1402);

        var outcome = await new CleanupEngine([new OneTypePerFileStep()]).CleanupAsync(document, Request(partial: true), CancellationToken.None);

        Assert.Single(outcome.Solution.Projects.Single().Documents);
        Assert.Contains(outcome.Issues, issue => issue.StartsWith("SA1402 (warning) line 5: type 'Other' was not moved to its own file because a partial cleanup of a file outside the workspace folders does not create files", StringComparison.Ordinal));
    }

    [Fact]
    public async Task ACleanupCommand_OneTypePerFile_StillMovesTheTypes()
    {
        var document = CreateDocument(TwoClasses, Sa1402);

        var outcome = await new CleanupEngine([new OneTypePerFileStep()]).CleanupAsync(document, Request(), CancellationToken.None);

        Assert.Equal(2, outcome.Solution.Projects.Single().Documents.Count());
    }

    [Fact]
    public async Task OnSave_PublicSymbolsAreNotRenamed_EvenWithRenamingAcrossTheWorkspace()
    {
        var document = CreateDocument("public class C\n{\n    public int total;\n}\n", PublicFieldNaming);

        var outcome = await new CleanupEngine([new RoslynRulesStep()]).CleanupAsync(
            document,
            Request(user => user["renamePublicSymbolsAcrossWorkspace"] = true, onSave: true),
            CancellationToken.None);

        Assert.Equal("public class C\n{\n    public int total;\n}\n", await TextAsync(outcome));
        Assert.Contains("not renamed because it is not private", Assert.Single(outcome.Unresolved).Reason, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(true, false, "cleanup on save")]
    [InlineData(false, true, "a partial cleanup of a file outside the workspace folders")]
    public async Task AStepThatWouldChangeOrCreateOtherFiles_IsNotApplied_AndReported(bool onSave, bool partial, string why)
    {
        var engine = new CleanupEngine([new AddFileStep(), new UpperStep()]);

        var outcome = await engine.CleanupAsync(CreateDocument("class c { }\n"), Request(onSave: onSave, partial: partial), CancellationToken.None);

        Assert.Single(outcome.Solution.Projects.Single().Documents);
        Assert.Equal("CLASS C { }\n", await TextAsync(outcome));
        Assert.Contains($"AddFile: not applied, {why} does not change or create other files.", outcome.Issues);
    }

    private static CleanupEngine UsingsEngine() => new([new RoslynRulesStep(), new OrganizeUsingsStep()]);

    private static CleanupRequest UsingsRequest(bool skipOnSave, bool onSave, bool partial = false) => Request(
        user =>
        {
            user["organizeUsings"] = true;
            user["moveUsingsOutsideNamespace"] = true;
            user["skipOrganizeUsingsDuringCleanupOnSave"] = skipOnSave;
        },
        onSave,
        partial);

    private static CleanupRequest Request(Action<JsonObject>? configure = null, bool onSave = false, bool partial = false)
    {
        var user = Testbed.TestbedScenarios.AllOff();
        configure?.Invoke(user);

        return new CleanupRequest(user, [], null, OnSave: onSave, Partial: partial);
    }

    private static Document CreateDocument(string text, string? editorConfig = null)
    {
        var directory = Path.Combine(Root, Guid.NewGuid().ToString("N"));
        var projectId = ProjectId.CreateNewId();
        var filePath = Path.Combine(directory, "Sample.cs");
        var solution = new AdhocWorkspace(HostAnalyzers.HostServices).CurrentSolution.AddProject(ProjectInfo.Create(
            projectId,
            VersionStamp.Create(),
            "Sample",
            "Sample",
            LanguageNames.CSharp,
            filePath: Path.Combine(directory, "Sample.csproj"),
            compilationOptions: new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary),
            metadataReferences: [MetadataReference.CreateFromFile(typeof(object).Assembly.Location), MetadataReference.CreateFromFile(Path.Combine(Path.GetDirectoryName(typeof(object).Assembly.Location)!, "System.Runtime.dll"))]));
        solution = solution.AddAnalyzerConfigDocument(DocumentId.CreateNewId(projectId), ".editorconfig", SourceText.From(editorConfig ?? "root = true\n"), filePath: Path.Combine(directory, ".editorconfig"));
        var documentId = DocumentId.CreateNewId(projectId);
        solution = solution.AddDocument(DocumentInfo.Create(documentId, "Sample.cs", loader: TextLoader.From(TextAndVersion.Create(SourceText.From(text), VersionStamp.Create(), filePath)), filePath: filePath));

        return solution.GetDocument(documentId)!;
    }

    private static async Task<string> TextAsync(CleanupOutcome outcome)
    {
        var document = outcome.Solution.Projects.Single().Documents.First(candidate => candidate.Name == "Sample.cs");

        return (await document.GetTextAsync()).ToString();
    }

    private sealed class AddFileStep : ICleanupStep
    {
        public string Name => "AddFile";

        public string? RuleId => "AddFile";

        public CleanupStage Stage => CleanupStage.Text;

        public int Order => 0;

        public bool IsEnabled(IEffectiveSettings settings) => true;

        public Task<Solution> ApplyAsync(Document document, IEffectiveSettings settings, CancellationToken cancellationToken) =>
            Task.FromResult(document.Project.AddDocument("Added.cs", SourceText.From("class Added { }\n"), filePath: Path.Combine(Path.GetDirectoryName(document.FilePath)!, "Added.cs")).Project.Solution);
    }

    private sealed class UpperStep : ICleanupStep
    {
        public string Name => "Upper";

        public string? RuleId => "Upper";

        public CleanupStage Stage => CleanupStage.Text;

        public int Order => 1;

        public bool IsEnabled(IEffectiveSettings settings) => true;

        public async Task<Solution> ApplyAsync(Document document, IEffectiveSettings settings, CancellationToken cancellationToken)
        {
            var text = await document.GetTextAsync(cancellationToken);

            return document.WithText(SourceText.From(text.ToString().ToUpperInvariant(), text.Encoding)).Project.Solution;
        }
    }
}
