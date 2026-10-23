using System.Text.Json.Nodes;
using CodeJanitor.Engine.Contracts;
using CodeJanitor.Server;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;
using Xunit;

namespace CodeJanitor.Engine.Tests.Server;

public sealed class CheckCommandTests : IDisposable
{
    private const string Clean = "namespace Demo;\n\ninternal class Clean\n{\n    public int Total;\n}\n";

    private const string Dirty = "namespace Demo;\n\ninternal class Dirty\n{\n    public int total;\n\n    public void Add(int value)\n    {\n        if (value > 0)\n            total += value;\n    }\n}\n";

    private readonly TempTree _tree = new();
    private readonly FakeEngine _engine = new();
    private readonly StringWriter _output = new();
    private readonly StringWriter _error = new();

    public CheckCommandTests()
    {
        _tree.Write("src/Demo.csproj", ServerTestPaths.Project);
        _tree.Write("src/Clean.cs", Clean);
        _tree.Write("src/obj/Generated.cs", "internal class Generated { void M(bool b) { if (b) M(b); } }\n");
    }

    public void Dispose() => _tree.Dispose();

    [Fact]
    public async Task Passes_when_no_file_would_change_and_no_enforced_rule_is_violated()
    {
        var exitCode = await RunAsync("--root", _tree.Root, _tree.PathOf("src"));

        Assert.Equal(0, exitCode);
        Assert.Equal("Code Janitor check: 1 file(s) checked, all clean.\n", _output.ToString());
        Assert.Equal(string.Empty, _error.ToString());
        var call = Assert.Single(_engine.Calls);
        Assert.Equal("""{"removeRegions":true}""", call.Settings.ToJsonString());
        Assert.Empty(call.Request!.ExcludedRules);
        Assert.Null(call.Request.ChangedLines);
    }

    [Fact]
    public async Task Fails_and_lists_file_line_rule_for_each_change_cleanup_would_make_and_each_violation_it_cannot_fix()
    {
        _tree.Write("src/Dirty.cs", Dirty);
        _engine.Cleanup = (document, _, _) => Task.FromResult(document.Name == "Dirty.cs"
            ? new CleanupOutcome(
                Replace(document, "        if (value > 0)\n            total += value;\n", "        if (value > 0)\n        {\n            total += value;\n        }\n"),
                [new RuleOutcome("IDE0011", "Add braces", 1, true)],
                [new UnresolvedDiagnostic("IDE1006", "field 'total' should be named 'Total'", "error", 5, 16, "not renamed because it is not private and may be referenced from other files.")],
                [])
            : new CleanupOutcome(document.Project.Solution, [], [], []));
        _engine.Analyze = _ => Task.FromResult<IReadOnlyList<EngineDiagnostic>>([new EngineDiagnostic("IDE0011", "Add braces", "warning", 8, 8, 8, 10, true, null)]);

        var exitCode = await RunAsync("--root", _tree.Root, _tree.PathOf("src"));

        Assert.Equal(1, exitCode);
        Assert.Equal(
            "src/Dirty.cs:9: IDE0011 (warning): Code Janitor would change this to: {\n"
            + "src/Dirty.cs:5: IDE1006 (error): field 'total' should be named 'Total'; not renamed because it is not private and may be referenced from other files.\n"
            + "Code Janitor check: 2 file(s) checked, 1 would change, 1 violation(s) cleanup cannot fix.\n",
            _output.ToString());
    }

    [Fact]
    public async Task Locates_the_changes_of_each_rule_when_several_rules_change_the_file_naming_code_janitor_steps_by_name()
    {
        var source = "namespace Demo;\n\nclass Holder\n{\n}\n\n#region Helpers\n#endregion\n";
        var file = _tree.Write("src/Holder.cs", source);
        var withoutRegions = "namespace Demo;\n\nclass Holder\n{\n}\n";
        var withModifier = source.Replace("class Holder", "internal class Holder", StringComparison.Ordinal);
        _engine.Cleanup = (document, _, _) => Task.FromResult(new CleanupOutcome(
            Replace(document, source, "namespace Demo;\n\ninternal class Holder\n{\n}\n"),
            [new RuleOutcome("CJ0003", "Remove region directives", 1, true), new RuleOutcome("IDE0040", "Add accessibility modifiers", 1, true), new RuleOutcome("IDE0005", "Remove unnecessary usings", 1, false)],
            [],
            []));
        _engine.FixRule = (document, ruleId, _) => Task.FromResult(new CleanupOutcome(Replace(document, source, ruleId == "CJ0003" ? withoutRegions : withModifier), [], [], []));
        _engine.Analyze = _ => Task.FromResult<IReadOnlyList<EngineDiagnostic>>([new EngineDiagnostic("IDE0040", "Add modifiers", "suggestion", 2, 6, 2, 12, true, null)]);

        var exitCode = await RunAsync("--root", _tree.Root, file);

        Assert.Equal(1, exitCode);
        Assert.Equal(
            "src/Holder.cs:7: Remove region directives: Code Janitor would remove 3 line(s)\n"
            + "src/Holder.cs:3: IDE0040 (suggestion): Code Janitor would change this to: internal class Holder\n"
            + "Code Janitor check: 1 file(s) checked, 1 would change, 0 violation(s) cleanup cannot fix.\n",
            _output.ToString());
        Assert.Equal(["cleanup", "fixRule CJ0003 ", "fixRule IDE0040 ", "analyze"], _engine.Calls.Select(call => call.Kind));
    }

    [Fact]
    public async Task Reports_a_change_that_only_inserts_blank_lines_as_an_insertion_named_once()
    {
        var source = "namespace Demo\n{\n#if DEBUG\n    internal class Padded\n    {\n    }\n#endif\n}\n";
        var file = _tree.Write("src/Padded.cs", source);
        _engine.Cleanup = (document, _, _) => Task.FromResult(new CleanupOutcome(
            Replace(document, source, "namespace Demo\n{\n#if DEBUG\n\n    internal class Padded\n    {\n    }\n\n#endif\n}\n"),
            [new RuleOutcome("insertBlankLinePadding", "Insert blank line padding", 2, true)],
            [],
            []));

        var exitCode = await RunAsync("--root", _tree.Root, file);

        Assert.Equal(1, exitCode);
        Assert.Equal(
            "src/Padded.cs:3: Insert blank line padding: Code Janitor would insert 1 blank line(s)\n"
            + "src/Padded.cs:6: Insert blank line padding: Code Janitor would insert 1 blank line(s)\n"
            + "Code Janitor check: 1 file(s) checked, 1 would change, 0 violation(s) cleanup cannot fix.\n",
            _output.ToString());
    }

    [Fact]
    public async Task Lists_the_notes_of_the_engine_without_failing_on_them()
    {
        var file = _tree.PathOf("src/Clean.cs");
        _engine.Cleanup = (document, _, _) => Task.FromResult(new CleanupOutcome(document.Project.Solution, [], [], ["Code Style rule X is not applied."]));

        var exitCode = await RunAsync("--root", _tree.Root, file);

        Assert.Equal(0, exitCode);
        Assert.Equal("src/Clean.cs: note: Code Style rule X is not applied.\nCode Janitor check: 1 file(s) checked, all clean.\n", _output.ToString());
    }

    [Fact]
    public async Task Shows_paths_relative_to_the_root_when_the_root_is_reached_through_a_symbolic_link()
    {
        var link = Path.Combine(Path.GetTempPath(), "cj-link-" + Guid.NewGuid().ToString("N")[..12]);
        Assert.True(TryCreateDirectoryLink(link, _tree.Root), "The test needs a symbolic link or, on Windows, a junction.");

        try
        {
            _engine.Cleanup = (document, _, _) => Task.FromResult(new CleanupOutcome(document.Project.Solution, [], [], ["a note"]));

            var exitCode = await RunAsync("--root", link, _tree.PathOf("src/Clean.cs"));

            Assert.Equal(0, exitCode);
            Assert.Equal("src/Clean.cs: note: a note\nCode Janitor check: 1 file(s) checked, all clean.\n", _output.ToString());
        }
        finally
        {
            Directory.Delete(link);
        }
    }

    private static bool TryCreateDirectoryLink(string link, string target)
    {
        try
        {
            Directory.CreateSymbolicLink(link, target);

            return true;
        }
        catch (Exception exception) when (exception is UnauthorizedAccessException or IOException && OperatingSystem.IsWindows())
        {
            using var process = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("cmd.exe", ["/c", "mklink", "/J", link, target]) { UseShellExecute = false, CreateNoWindow = true });
            process!.WaitForExit();

            return process.ExitCode == 0;
        }
    }

    [Fact]
    public async Task Fails_with_2_and_lists_each_failure_of_the_engine_as_an_error_not_a_note()
    {
        var file = _tree.PathOf("src/Clean.cs");
        _engine.Cleanup = (document, _, _) => Task.FromResult(new CleanupOutcome(document.Project.Solution, [], [], ["a note"]) { Failures = ["Broken failed and was not applied: InvalidOperationException: boom"] });

        var exitCode = await RunAsync("--root", _tree.Root, file);

        Assert.Equal(2, exitCode);
        Assert.Equal(
            "src/Clean.cs: note: a note\n"
            + "src/Clean.cs: error: Broken failed and was not applied: InvalidOperationException: boom\n"
            + "Code Janitor check: 1 file(s) checked, 0 would change, 0 violation(s) cleanup cannot fix, 1 failure(s): the check is incomplete.\n",
            _output.ToString());
    }

    [Fact]
    public async Task Fails_with_2_when_a_project_cannot_be_loaded()
    {
        _tree.Write("broken/Broken.csproj", "<Project Sdk=\"Microsoft.NET.Sdk\">\n  <PropertyGroup>\n");
        var file = _tree.Write("broken/A.cs", "internal class A\n{\n}\n");

        var exitCode = await RunAsync("--root", _tree.Root, file);

        Assert.Equal(2, exitCode);
        Assert.Matches("broken/A\\.cs: error: .*Broken\\.csproj", _output.ToString());
        Assert.Contains("failure(s): the check is incomplete.", _output.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Skips_a_file_passed_explicitly_when_it_is_not_a_cs_file_and_defaults_to_the_current_folder()
    {
        var readme = _tree.Write("src/readme.md", "hello  \n");

        var explicitFiles = await RunAsync("--root", _tree.Root, readme, _tree.PathOf("src/Clean.cs"));
        var explicitOutput = _output.ToString();
        _output.GetStringBuilder().Clear();
        var currentFolder = await CheckCommand.RunAsync([], _output, _error, Host(), _engine, Defaults, _tree.PathOf("src"));

        Assert.Equal(0, explicitFiles);
        Assert.Equal("Code Janitor check: 1 file(s) checked, all clean.\n", explicitOutput);
        Assert.Equal(0, currentFolder);
        Assert.Equal("Code Janitor check: 1 file(s) checked, all clean.\n", _output.ToString());
    }

    [Theory]
    [InlineData("--bogus")]
    [InlineData("--root")]
    public async Task A_usage_error_exits_with_2(string argument)
    {
        var exitCode = await RunAsync(argument);

        Assert.Equal(2, exitCode);
        Assert.Equal(string.Empty, _output.ToString());
        Assert.StartsWith("Usage: ", _error.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_missing_path_or_a_failing_engine_exits_with_2()
    {
        var missing = await RunAsync(_tree.PathOf("nowhere"));
        var missingError = _error.ToString();
        _error.GetStringBuilder().Clear();
        _engine.Cleanup = (_, _, _) => throw new InvalidOperationException("engine broke");
        var failing = await RunAsync(_tree.PathOf("src/Clean.cs"));

        Assert.Equal(2, missing);
        Assert.StartsWith("Code Janitor check failed: ", missingError, StringComparison.Ordinal);
        Assert.Contains("nowhere", missingError, StringComparison.Ordinal);
        Assert.Equal(2, failing);
        Assert.Equal("Code Janitor check failed: engine broke\n", _error.ToString());
    }

    private static JsonObject Defaults() => new() { ["removeRegions"] = true };

    private static Solution Replace(Document document, string before, string after)
    {
        var text = document.GetTextAsync().GetAwaiter().GetResult();
        var replaced = text.ToString().Replace(before, after, StringComparison.Ordinal);
        Assert.NotEqual(text.ToString(), replaced);

        return document.WithText(SourceText.From(replaced, text.Encoding)).Project.Solution;
    }

    private Task<int> RunAsync(params string[] arguments) =>
        CheckCommand.RunAsync(arguments, _output, _error, Host(), _engine, Defaults, _tree.Root);

    private static WorkspaceHost Host() => new(_ => { });
}
