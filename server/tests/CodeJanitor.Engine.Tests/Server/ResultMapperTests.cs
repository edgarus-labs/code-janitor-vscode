using System.Text;
using CodeJanitor.Engine.Contracts;
using CodeJanitor.Server;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;
using Xunit;

namespace CodeJanitor.Engine.Tests.Server;

public sealed class ResultMapperTests
{
    private static readonly string Root = Path.Combine(Path.GetTempPath(), "cj-mapper");

    [Fact]
    public async Task Maps_the_requested_text_and_passes_rules_unresolved_and_issues_through()
    {
        var document = CreateDocument("A.cs", "class A { }\n");
        var changed = document.WithText(SourceText.From("internal class A { }\n", new UTF8Encoding(false))).Project.Solution;
        var rules = new[] { new RuleOutcome("IDE0040", "Accessibility modifiers", 1, true) };
        var unresolved = new[] { new UnresolvedDiagnostic("IDE1006", "bad name", "error", 1, 7, "public") };

        var result = await ResultMapper.MapAsync(document, new CleanupOutcome(changed, rules, unresolved, ["engine note"]), ["host note"], [], default);

        Assert.Equal("internal class A { }\n", result.Text);
        Assert.Empty(result.OtherFiles);
        Assert.Empty(result.NewFiles);
        Assert.Equal(rules, result.Rules);
        Assert.Equal(unresolved, result.Unresolved);
        Assert.Equal(["host note", "engine note"], result.Issues);
    }

    [Fact]
    public async Task Reports_the_failures_of_the_engine_and_the_warnings_of_the_host_apart_from_the_issues()
    {
        var document = CreateDocument("A.cs", "class A { }\n");
        var outcome = new CleanupOutcome(document.Project.Solution, [], [], ["engine note"]) { Failures = ["a step failed"] };

        var result = await ResultMapper.MapAsync(document, outcome, ["host note"], ["host warning"], default);

        Assert.Equal(["host note", "engine note"], result.Issues);
        Assert.Equal(["a step failed"], result.Failures);
        Assert.Equal(["host warning"], result.Warnings);
    }

    [Fact]
    public async Task Lists_changed_other_documents_and_skips_unchanged_ones()
    {
        var document = CreateDocument("A.cs", "class A { }\n", ("B.cs", "class B { }\n"), ("C.cs", "class C { }\n"));
        var other = document.Project.Documents.Single(d => d.Name == "B.cs");
        var changed = other.WithText(SourceText.From("class Renamed { }\n")).Project.Solution;

        var result = await ResultMapper.MapAsync(document, Outcome(changed), [], [], default);

        Assert.Equal("class A { }\n", result.Text);
        var file = Assert.Single(result.OtherFiles);
        Assert.Equal(Path.Combine(Root, "B.cs"), file.Path);
        Assert.Equal("class Renamed { }\n", file.Text);
    }

    [Fact]
    public async Task Lists_added_documents_as_new_files_with_their_paths()
    {
        var document = CreateDocument("A.cs", "class A { }\r\nclass B { }\r\n");
        var withPath = document.Project.AddDocument("B.cs", SourceText.From("class B { }\n"), filePath: Path.Combine(Root, "Sub", "B.cs"));
        var withoutPath = withPath.Project.AddDocument("C.cs", SourceText.From("class C { }\n"));
        var changed = withoutPath.Project.Solution;

        var result = await ResultMapper.MapAsync(document, Outcome(changed), [], [], default);

        Assert.Equal(
            [(Path.Combine(Root, "C.cs"), "class C { }\n"), (Path.Combine(Root, "Sub", "B.cs"), "class B { }\n")],
            result.NewFiles.Select(file => (file.Path, file.Text)).OrderBy(file => file.Path, StringComparer.Ordinal));
    }

    [Fact]
    public async Task Restores_the_original_line_ending_when_a_change_mixes_in_another_one()
    {
        var document = CreateDocument("A.cs", "class A\r\n{\r\n}\r\n");
        var changed = document.WithText(SourceText.From("class A\r\n{\n    int x;\r\n}\r\n")).Project.Solution;

        var result = await ResultMapper.MapAsync(document, Outcome(changed), [], [], default);

        Assert.Equal("class A\r\n{\r\n    int x;\r\n}\r\n", result.Text);
    }

    [Fact]
    public async Task Keeps_a_line_ending_change_the_engine_made_to_the_whole_file()
    {
        var document = CreateDocument("A.cs", "class A\r\n{\r\n    string s = @\"a\r\nb\";\r\n}\r\n");
        var changed = document.WithText(SourceText.From("class A\n{\n    string s = @\"a\r\nb\";\n}\n")).Project.Solution;

        var result = await ResultMapper.MapAsync(document, Outcome(changed), [], [], default);

        Assert.Equal("class A\n{\n    string s = @\"a\r\nb\";\n}\n", result.Text);
    }

    [Fact]
    public async Task New_files_take_the_line_ending_and_byte_order_mark_of_the_requested_file()
    {
        var document = CreateDocument("A.cs", TextConventions.ToSourceText("\uFEFFclass A { }\r\nclass B { }\r\n"));
        var changed = document.Project.AddDocument("B.cs", SourceText.From("namespace N;\n\r\nclass B { }\r\n"), filePath: Path.Combine(Root, "B.cs")).Project.Solution;

        var result = await ResultMapper.MapAsync(document, Outcome(changed), [], [], default);

        Assert.Equal("\uFEFFnamespace N;\r\n\r\nclass B { }\r\n", Assert.Single(result.NewFiles).Text);
    }

    [Fact]
    public async Task Keeps_the_byte_order_mark_of_a_file_when_the_changed_text_has_no_encoding()
    {
        var document = CreateDocument("A.cs", TextConventions.ToSourceText("\uFEFFclass A { }\n"));
        var changed = document.WithText(SourceText.From("internal class A { }\n")).Project.Solution;

        var result = await ResultMapper.MapAsync(document, Outcome(changed), [], [], default);

        Assert.Equal("\uFEFFinternal class A { }\n", result.Text);
    }

    [Fact]
    public async Task Follows_an_encoding_the_engine_set_on_the_changed_text()
    {
        var withBom = CreateDocument("A.cs", TextConventions.ToSourceText("\uFEFFclass A { }\n"));
        var removed = withBom.WithText(SourceText.From("class A { }\n", new UTF8Encoding(false))).Project.Solution;
        var withoutBom = CreateDocument("A.cs", TextConventions.ToSourceText("class A { }\n"));
        var added = withoutBom.WithText(SourceText.From("class A { }\n", new UTF8Encoding(true))).Project.Solution;

        Assert.Equal("class A { }\n", (await ResultMapper.MapAsync(withBom, Outcome(removed), [], [], default)).Text);
        Assert.Equal("\uFEFFclass A { }\n", (await ResultMapper.MapAsync(withoutBom, Outcome(added), [], [], default)).Text);
    }

    [Fact]
    public void Request_text_with_a_byte_order_mark_becomes_an_encoding_with_a_preamble()
    {
        var withBom = TextConventions.ToSourceText("\uFEFFclass A { }");
        var withoutBom = TextConventions.ToSourceText("class A { }");

        Assert.Equal("class A { }", withBom.ToString());
        Assert.True(TextConventions.HasByteOrderMark(withBom));
        Assert.Equal("class A { }", withoutBom.ToString());
        Assert.False(TextConventions.HasByteOrderMark(withoutBom));
    }

    private static CleanupOutcome Outcome(Solution solution) => new(solution, [], [], []);

    private static Document CreateDocument(string name, string text, params (string Name, string Text)[] others) =>
        CreateDocument(name, SourceText.From(text, new UTF8Encoding(false)), others);

    private static Document CreateDocument(string name, SourceText text, params (string Name, string Text)[] others)
    {
        var workspace = new AdhocWorkspace();
        var project = workspace.AddProject("P", LanguageNames.CSharp);
        foreach (var (otherName, otherText) in others)
        {
            project = project.AddDocument(otherName, SourceText.From(otherText), filePath: Path.Combine(Root, otherName)).Project;
        }

        return project.AddDocument(name, text, filePath: Path.Combine(Root, name));
    }
}
