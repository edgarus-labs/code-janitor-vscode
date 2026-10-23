using System.Text.Json.Nodes;
using CodeJanitor.Engine.Contracts;
using CodeJanitor.Engine.Settings;
using CodeJanitor.Engine.Tests.Steps.Support;
using Xunit;

namespace CodeJanitor.Engine.Tests.Steps;

/// <summary>
/// The shared transformation corpus (<c>shared/tests/transformations/*.json</c>): default settings plus each fixture's
/// overrides, through the whole cleanup engine (Code Janitor's own steps and the Roslyn rules).
/// </summary>
public sealed class SharedTransformationCorpusTests
{
    private static readonly string[] Groups = ["insertBlankLinePadding", "insertExplicitAccessModifiers"];

    public static TheoryData<string> Fixtures()
    {
        var data = new TheoryData<string>();
        foreach (var file in Directory.GetFiles(CorpusDirectory(), "*.json").Order(StringComparer.Ordinal))
        {
            data.Add(Path.GetFileNameWithoutExtension(file));
        }

        return data;
    }

    [Theory]
    [MemberData(nameof(Fixtures))]
    public async Task Fixture_Passes(string name)
    {
        var fixture = JsonNode.Parse(File.ReadAllText(Path.Combine(CorpusDirectory(), name + ".json")))!.AsObject();
        var overrides = fixture["settings"]!.AsObject();
        var lf = (string?)overrides["newlines"] == "lf";
        var user = CleanupSettingsDefaults.Create();
        foreach (var (key, value) in overrides)
        {
            if (Groups.Contains(key))
            {
                foreach (var member in user.Select(pair => pair.Key).Where(member => member.StartsWith(key, StringComparison.Ordinal)).ToList())
                {
                    user[member] = value?.DeepClone();
                }
            }
            else if (key != "newlines")
            {
                user[key] = value?.DeepClone();
            }
        }

        var input = (string)fixture["input"]!;
        var outcome = await new CleanupEngine().CleanupAsync(
            StepHarness.EngineDocument(lf ? input.Replace("\r\n", "\n", StringComparison.Ordinal) : input),
            new CleanupRequest(user, [], null),
            CancellationToken.None);
        var output = (await outcome.Solution.Projects.Single().Documents.Single().GetTextAsync()).ToString();

        var mustContain = fixture["mustContain"]!.AsArray().Select(node => (string)node!).ToList();
        Assert.NotEmpty(mustContain);

        foreach (var expected in mustContain)
        {
            Assert.Contains(lf ? expected.Replace("\r\n", "\n", StringComparison.Ordinal) : expected, output, StringComparison.Ordinal);
        }

        foreach (var forbidden in fixture["mustNotContain"]?.AsArray().Select(node => (string)node!) ?? [])
        {
            Assert.DoesNotContain(lf ? forbidden.Replace("\r\n", "\n", StringComparison.Ordinal) : forbidden, output, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void TheCorpusIsFound_AndEveryFixtureOfItRunsInTheTheory() =>
        Assert.Equal(
            Directory.GetFiles(CorpusDirectory(), "*.json").Select(file => Path.GetFileNameWithoutExtension(file)).Order(StringComparer.Ordinal),
            ((IEnumerable<object[]>)Fixtures()).Select(row => (string)row[0]).Order(StringComparer.Ordinal));

    private static string CorpusDirectory()
    {
        var configured = Environment.GetEnvironmentVariable("CODE_JANITOR_SHARED_CORPUS");
        if (!string.IsNullOrEmpty(configured))
        {
            return configured;
        }

        foreach (var start in new[] { AppContext.BaseDirectory, LocalTestbed.SourceDirectory() })
        {
            for (var directory = new DirectoryInfo(start); directory is not null; directory = directory.Parent)
            {
                var candidate = Path.Combine(directory.FullName, "shared", "tests", "transformations");
                if (Directory.Exists(candidate))
                {
                    return candidate;
                }
            }
        }

        throw new DirectoryNotFoundException("shared/tests/transformations not found above " + AppContext.BaseDirectory);
    }
}
