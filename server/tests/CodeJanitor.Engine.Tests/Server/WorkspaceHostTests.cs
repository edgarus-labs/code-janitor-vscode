using System.Diagnostics;
using CodeJanitor.Server;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;
using Xunit.Abstractions;

namespace CodeJanitor.Engine.Tests.Server;

public sealed class WorkspaceHostTests(ITestOutputHelper output)
{
    [Fact]
    public async Task Loads_the_testbed_solution_and_resolves_scenario_documents_to_their_project_without_compiler_errors()
    {
        var testbed = ServerTestPaths.Testbed();
        var first = Path.Combine(testbed, "src", "Scenarios", "CodeStyle", "CsharpPreferredModifierOrder", "CsharpPreferredModifierOrder.cs");
        var second = Path.Combine(testbed, "src", "Scenarios", "Program.cs");
        using var host = new WorkspaceHost(_ => { });
        host.Initialize([testbed]);

        var cold = Stopwatch.StartNew();
        var opened = await host.OpenAsync(first, null, null, default);
        cold.Stop();
        var warm = Stopwatch.StartNew();
        var again = await host.OpenAsync(second, null, null, default);
        warm.Stop();
        var compilation = await opened.Document.Project.GetCompilationAsync();
        output.WriteLine($"cold load {cold.ElapsedMilliseconds} ms, warm open {warm.ElapsedMilliseconds} ms");

        Assert.Empty(opened.Issues);
        Assert.Equal(Path.Combine(testbed, "src", "Scenarios", "Scenarios.csproj"), opened.Document.Project.FilePath);
        var listed = System.Text.RegularExpressions.Regex.Matches(File.ReadAllText(Path.Combine(testbed, "CodeJanitor.Testbed.slnx")), "<Project ").Count;
        Assert.Equal(listed, opened.Document.Project.Solution.ProjectIds.Count);
        Assert.Equal(opened.Document.Project.Id, again.Document.Project.Id);
        Assert.Empty(compilation!.GetDiagnostics().Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error));
    }

    [Fact]
    public async Task Prefers_a_solution_listing_the_project_over_the_project_alone()
    {
        using var tree = new TempTree();
        tree.Write("App/App.csproj", ServerTestPaths.Project);
        tree.Write("Lib/Lib.csproj", ServerTestPaths.Project);
        tree.Write("Lib/Helper.cs", "namespace Lib;\n\npublic class Helper\n{\n}\n");
        tree.Write("Both.slnx", "<Solution>\n  <Project Path=\"App/App.csproj\" />\n  <Project Path=\"Lib/Lib.csproj\" />\n</Solution>\n");
        tree.Write("Other.sln", "Microsoft Visual Studio Solution File, Format Version 12.00\n");
        var file = tree.Write("App/Program.cs", "namespace App;\n\ninternal class Program\n{\n}\n");
        using var host = new WorkspaceHost(_ => { });
        host.Initialize([tree.Root]);

        var opened = await host.OpenAsync(file, null, null, default);

        Assert.Equal(tree.PathOf("App/App.csproj"), opened.Document.Project.FilePath);
        Assert.Equal(2, opened.Document.Project.Solution.ProjectIds.Count);
        Assert.Empty(opened.Issues);
    }

    [Fact]
    public async Task Without_a_solution_the_projects_of_the_folder_that_reference_the_file_s_project_are_loaded_too()
    {
        using var tree = new TempTree();
        tree.Write("Lib/Lib.csproj", ServerTestPaths.Project);
        var file = tree.Write("Lib/Helper.cs", "namespace Lib;\n\npublic class Helper\n{\n}\n");
        tree.Write("App/App.csproj", ServerTestPaths.Project.Replace("</Project>", "  <ItemGroup>\n    <ProjectReference Include=\"../Lib/Lib.csproj\" />\n  </ItemGroup>\n</Project>"));
        tree.Write("App/Program.cs", "namespace App;\n\ninternal class Program\n{\n    private static Lib.Helper? helper;\n}\n");
        tree.Write("Tool/Tool.csproj", ServerTestPaths.Project);
        tree.Write("Tool/obj/Stale.csproj", ServerTestPaths.Project);
        using var host = new WorkspaceHost(_ => { });
        host.Initialize([tree.Root]);

        var opened = await host.OpenAsync(file, null, null, default);
        var projects = opened.Document.Project.Solution.Projects.Select(project => project.FilePath).ToList();

        Assert.Equal(tree.PathOf("Lib/Lib.csproj"), opened.Document.Project.FilePath);
        Assert.Contains(tree.PathOf("App/App.csproj"), projects);
        Assert.DoesNotContain(tree.PathOf("Tool/Tool.csproj"), projects);
        Assert.DoesNotContain(tree.PathOf("Tool/obj/Stale.csproj"), projects);
    }

    [Fact]
    public async Task Without_a_solution_the_projects_are_looked_for_without_following_directory_links()
    {
        using var tree = new TempTree();
        tree.Write("Lib/Lib.csproj", ServerTestPaths.Project);
        var file = tree.Write("Lib/Helper.cs", "namespace Lib;\n\npublic class Helper\n{\n}\n");
        tree.Write("App/App.csproj", ServerTestPaths.Project.Replace("</Project>", "  <ItemGroup>\n    <ProjectReference Include=\"../Lib/Lib.csproj\" />\n  </ItemGroup>\n</Project>"));
        var link = tree.PathOf("Mirror");
        Assert.True(ServerTestPaths.TryCreateDirectoryLink(link, tree.PathOf("App")), "The test needs a symbolic link or, on Windows, a junction.");
        try
        {
            using var host = new WorkspaceHost(_ => { });
            host.Initialize([tree.Root]);

            var opened = await host.OpenAsync(file, null, null, default);

            Assert.Equal(
                [tree.PathOf("App/App.csproj"), tree.PathOf("Lib/Lib.csproj")],
                opened.Document.Project.Solution.Projects.Select(project => project.FilePath).Order(StringComparer.Ordinal));
        }
        finally
        {
            Directory.Delete(link);
        }
    }

    [Fact]
    public async Task Overlays_the_request_text_and_unsaved_documents_for_that_request_only()
    {
        using var tree = new TempTree();
        tree.Write("App/App.csproj", ServerTestPaths.Project);
        var file = tree.Write("App/A.cs", "internal class A\n{\n}\n");
        var other = tree.Write("App/B.cs", "internal class B\n{\n}\n");
        using var host = new WorkspaceHost(_ => { });
        host.Initialize([tree.Root]);

        var overlaid = await host.OpenAsync(file, "\uFEFFinternal class A2\n{\n}\n", [new UnsavedDocument(other, "internal class B2\n{\n}\n")], default);
        var plain = await host.OpenAsync(file, null, null, default);

        Assert.Equal("internal class A2\n{\n}\n", (await overlaid.Document.GetTextAsync()).ToString());
        Assert.True(TextConventions.HasByteOrderMark(await overlaid.Document.GetTextAsync()));
        Assert.Equal("internal class B2\n{\n}\n", (await DocumentAt(overlaid.Document.Project.Solution, other).GetTextAsync()).ToString());
        Assert.Equal("internal class A\n{\n}\n", (await plain.Document.GetTextAsync()).ToString());
        Assert.Equal("internal class B\n{\n}\n", (await DocumentAt(plain.Document.Project.Solution, other).GetTextAsync()).ToString());
    }

    [Fact]
    public async Task A_changed_source_file_is_read_again_and_added_or_deleted_files_join_or_leave_the_project()
    {
        using var tree = new TempTree();
        tree.Write("App/App.csproj", ServerTestPaths.Project);
        var file = tree.Write("App/A.cs", "internal class A\n{\n}\n");
        var deleted = tree.Write("App/Old.cs", "internal class Old\n{\n}\n");
        using var host = new WorkspaceHost(_ => { });
        host.Initialize([tree.Root]);
        var before = await host.OpenAsync(file, null, null, default);
        _ = (await before.Document.GetTextAsync()).ToString();

        tree.Write("App/A.cs", "internal class Changed\n{\n}\n");
        var added = tree.Write("App/Sub/New.cs", "internal class New\n{\n}\n");
        File.Delete(deleted);
        host.FileChanged(file);
        host.FileChanged(added);
        host.FileChanged(deleted);
        var after = await host.OpenAsync(file, null, null, default);

        Assert.Equal("internal class Changed\n{\n}\n", (await after.Document.GetTextAsync()).ToString());
        var newDocument = DocumentAt(after.Document.Project.Solution, added);
        Assert.Equal(after.Document.Project.Id, newDocument.Project.Id);
        Assert.Equal(["Sub"], newDocument.Folders);
        Assert.Empty(after.Document.Project.Solution.GetDocumentIdsWithFilePath(deleted));
    }

    [Fact]
    public async Task A_changed_project_file_reloads_the_project()
    {
        using var tree = new TempTree();
        var project = tree.Write("App/App.csproj", ServerTestPaths.Project);
        var file = tree.Write("App/A.cs", "internal class A\n{\n}\n");
        using var host = new WorkspaceHost(_ => { });
        host.Initialize([tree.Root]);
        var before = await host.OpenAsync(file, null, null, default);

        tree.Write("App/App.csproj", ServerTestPaths.Project.Replace("<Nullable>enable</Nullable>", "<Nullable>enable</Nullable>\n    <LangVersion>9.0</LangVersion>"));
        host.FileChanged(project);
        var after = await host.OpenAsync(file, null, null, default);

        Assert.NotEqual(LanguageVersion.CSharp9, ((CSharpParseOptions)before.Document.Project.ParseOptions!).LanguageVersion);
        Assert.Equal(LanguageVersion.CSharp9, ((CSharpParseOptions)after.Document.Project.ParseOptions!).LanguageVersion);
    }

    [Fact]
    public async Task A_changed_editorconfig_is_read_again()
    {
        using var tree = new TempTree();
        tree.Write("App/App.csproj", ServerTestPaths.Project);
        var editorConfig = tree.Write("App/.editorconfig", "root = true\n\n[*.cs]\nindent_size = 4\n");
        var file = tree.Write("App/A.cs", "internal class A\n{\n}\n");
        using var host = new WorkspaceHost(_ => { });
        host.Initialize([tree.Root]);
        await host.OpenAsync(file, null, null, default);

        tree.Write("App/.editorconfig", "root = true\n\n[*.cs]\nindent_size = 2\n");
        host.FileChanged(editorConfig);
        var after = await host.OpenAsync(file, null, null, default);

        var options = after.Document.Project.AnalyzerOptions.AnalyzerConfigOptionsProvider.GetOptions(await after.Document.GetSyntaxTreeAsync() ?? throw new InvalidOperationException());
        Assert.True(options.TryGetValue("indent_size", out var indentSize));
        Assert.Equal("2", indentSize);
    }

    [Fact]
    public async Task A_new_editorconfig_in_a_folder_of_a_project_applies_to_the_files_under_it()
    {
        using var tree = new TempTree();
        tree.Write("App/App.csproj", ServerTestPaths.Project);
        var file = tree.Write("App/Sub/X.cs", "internal class X\n{\n}\n");
        using var host = new WorkspaceHost(_ => { });
        host.Initialize([tree.Root]);
        await host.OpenAsync(file, null, null, default);

        var editorConfig = tree.Write("App/Sub/.editorconfig", "[*.cs]\nindent_size = 2\n");
        host.FileChanged(editorConfig);
        var after = await host.OpenAsync(file, null, null, default);

        Assert.Contains(editorConfig, after.Document.Project.AnalyzerConfigDocuments.Select(document => document.FilePath));
        var options = after.Document.Project.AnalyzerOptions.AnalyzerConfigOptionsProvider.GetOptions(await after.Document.GetSyntaxTreeAsync() ?? throw new InvalidOperationException());
        Assert.True(options.TryGetValue("indent_size", out var indentSize));
        Assert.Equal("2", indentSize);
    }

    [Fact]
    public async Task A_loose_file_is_cleaned_in_a_fallback_project_with_the_runtime_references_and_its_editorconfig()
    {
        using var tree = new TempTree();
        var editorConfig = tree.Write(".editorconfig", "root = true\n\n[*.cs]\nindent_size = 2\n");
        var file = tree.Write("Loose/Loose.cs", "using System;\nusing System.Collections.Generic;\nusing System.Linq;\n\ninternal class Loose\n{\n    public string Now => DateTime.Now.ToString() + new List<int>().Count();\n}\n");
        using var host = new WorkspaceHost(_ => { });
        host.Initialize([tree.Root]);

        var first = await host.OpenAsync(file, null, null, default);
        var second = await host.OpenAsync(file, null, null, default);

        var compilation = await first.Document.Project.GetCompilationAsync();
        Assert.Empty(compilation!.GetDiagnostics().Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error));
        Assert.Equal(file, first.Document.FilePath);
        Assert.Contains(editorConfig, first.Document.Project.AnalyzerConfigDocuments.Select(document => document.FilePath));
        var issue = Assert.Single(first.Issues);
        Assert.Contains("fallback", issue, StringComparison.OrdinalIgnoreCase);
        Assert.Empty(second.Issues);
    }

    [Fact]
    public async Task Without_msbuild_every_file_uses_the_fallback_project_and_says_so_once()
    {
        using var tree = new TempTree();
        tree.Write("App/App.csproj", ServerTestPaths.Project);
        var file = tree.Write("App/A.cs", "internal class A\n{\n}\n");
        var other = tree.Write("App/B.cs", "internal class B\n{\n}\n");
        using var host = new WorkspaceHost(_ => { }, msbuildAvailable: false);
        host.Initialize([tree.Root]);

        var first = await host.OpenAsync(file, null, null, default);
        var second = await host.OpenAsync(other, null, null, default);

        Assert.Null(first.Document.Project.FilePath);
        var warning = Assert.Single(first.Warnings);
        Assert.Contains(".NET SDK", warning, StringComparison.Ordinal);
        Assert.Empty(first.Issues);
        Assert.Empty(second.Warnings);
    }

    [Fact]
    public async Task A_project_that_fails_to_load_is_reported_and_its_file_uses_the_fallback_project()
    {
        using var tree = new TempTree();
        tree.Write("App/App.csproj", "<Project Sdk=\"Microsoft.NET.Sdk\">\n  <PropertyGroup>\n");
        var file = tree.Write("App/A.cs", "internal class A\n{\n}\n");
        using var host = new WorkspaceHost(_ => { });
        host.Initialize([tree.Root]);

        var opened = await host.OpenAsync(file, null, null, default);

        Assert.Equal(file, opened.Document.FilePath);
        Assert.Null(opened.Document.Project.FilePath);
        Assert.Contains(opened.Failures, failure => failure.Contains("App.csproj", StringComparison.Ordinal));
        Assert.DoesNotContain(opened.Issues, issue => issue.Contains("App.csproj", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_file_its_project_does_not_compile_is_not_looked_up_again_once_its_load_finished()
    {
        using var tree = new TempTree();
        tree.Write("App/App.csproj", ServerTestPaths.Project.Replace("</Project>", "  <ItemGroup>\n    <Compile Remove=\"Fixtures/**\" />\n  </ItemGroup>\n</Project>"));
        var file = tree.Write("App/Fixtures/F.cs", "internal class F\n{\n}\n");
        var log = new List<string>();
        using var host = new WorkspaceHost(message => { lock (log) { log.Add(message); } });
        host.Initialize([tree.Root]);
        var first = await host.OpenAsync(file, null, null, default);

        tree.Write("All.slnx", "<Solution>\n  <Project Path=\"App/App.csproj\" />\n</Solution>\n");
        var second = await host.OpenAsync(file, null, null, default);

        Assert.Null(first.Document.Project.FilePath);
        Assert.Null(second.Document.Project.FilePath);
        Assert.Equal([$"Loaded {tree.PathOf("App/App.csproj")}"], log.Where(message => message.StartsWith("Loaded ", StringComparison.Ordinal)).Select(message => message[..message.LastIndexOf(" in ", StringComparison.Ordinal)]));
    }

    [Theory]
    [InlineData("App/obj/App.csproj.nuget.g.props")]
    [InlineData("App/obj/App.csproj.nuget.g.targets")]
    [InlineData("App/bin/Debug/net8.0/Generated.props")]
    [InlineData("elsewhere/Unrelated.props")]
    public async Task A_changed_props_or_targets_file_that_cannot_affect_the_workspace_does_not_reload_it(string changed)
    {
        using var tree = new TempTree();
        tree.Write("App/App.csproj", ServerTestPaths.Project);
        var file = tree.Write("App/A.cs", "internal class A\n{\n}\n");
        var props = tree.Write(changed, "<Project />\n");
        using var host = new WorkspaceHost(_ => { });
        host.Initialize([tree.PathOf("App")]);
        var before = await host.OpenAsync(file, null, null, default);

        host.FileChanged(props);
        var after = await host.OpenAsync(file, null, null, default);

        Assert.Same(before.Document.Project.Solution, after.Document.Project.Solution);
    }

    [Theory]
    [InlineData("A/Directory.Build.props")]
    [InlineData("A/src/Shared.targets")]
    public async Task A_changed_props_or_targets_file_reloads_only_the_workspace_it_belongs_to(string changed)
    {
        using var tree = new TempTree();
        tree.Write("A/src/App.csproj", ServerTestPaths.Project);
        var fileA = tree.Write("A/src/A.cs", "internal class A\n{\n}\n");
        tree.Write("B/src/App.csproj", ServerTestPaths.Project);
        var fileB = tree.Write("B/src/B.cs", "internal class B\n{\n}\n");
        var props = tree.Write(changed, "<Project />\n");
        using var host = new WorkspaceHost(_ => { });
        host.Initialize([tree.PathOf("A"), tree.PathOf("B")]);
        var beforeA = await host.OpenAsync(fileA, null, null, default);
        var beforeB = await host.OpenAsync(fileB, null, null, default);

        host.FileChanged(props);
        var afterA = await host.OpenAsync(fileA, null, null, default);
        var afterB = await host.OpenAsync(fileB, null, null, default);

        Assert.NotSame(beforeA.Document.Project.Solution, afterA.Document.Project.Solution);
        Assert.Same(beforeB.Document.Project.Solution, afterB.Document.Project.Solution);
    }

    [Fact]
    public async Task A_file_compiled_by_several_projects_resolves_to_the_project_containing_it_then_the_first_by_path()
    {
        using var tree = new TempTree();
        tree.Write("Owner/Owner.csproj", ServerTestPaths.Project.Replace("net8.0", "net9.0").Replace("TargetFramework>", "TargetFrameworks>").Replace("net9.0", "net8.0;net9.0"));
        var shared = tree.Write("Owner/Shared.cs", "internal class Shared\n{\n}\n");
        tree.Write("Linker/Linker.csproj", ServerTestPaths.Project.Replace("</Project>", "  <ItemGroup>\n    <Compile Include=\"../Owner/Shared.cs\" />\n  </ItemGroup>\n</Project>"));
        tree.Write("All.slnx", "<Solution>\n  <Project Path=\"Linker/Linker.csproj\" />\n  <Project Path=\"Owner/Owner.csproj\" />\n</Solution>\n");
        using var host = new WorkspaceHost(_ => { });
        host.Initialize([tree.Root]);

        var opened = await host.OpenAsync(shared, null, null, default);

        Assert.Equal(3, opened.Document.Project.Solution.GetDocumentIdsWithFilePath(shared).Length);
        Assert.Equal(tree.PathOf("Owner/Owner.csproj"), opened.Document.Project.FilePath);
        Assert.Equal("Owner(net8.0)", opened.Document.Project.Name);
    }

    private static Document DocumentAt(Solution solution, string path) =>
        solution.GetDocument(Assert.Single(solution.GetDocumentIdsWithFilePath(path)))!;
}
