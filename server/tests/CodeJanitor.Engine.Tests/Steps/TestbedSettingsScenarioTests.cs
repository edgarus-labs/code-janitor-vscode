using System.Text.Json.Nodes;
using CodeJanitor.Engine.Settings;
using CodeJanitor.Engine.Tests.Steps.Support;
using CodeJanitor.Engine.Tests.Testbed;
using Xunit;

namespace CodeJanitor.Engine.Tests.Steps;

/// <summary>
/// The testbed scenarios of the Settings category whose settings belong to Code Janitor's own steps: the scenario file
/// cleaned with only its settings on passes its checks, and a second cleanup changes nothing.
/// </summary>
public sealed class TestbedSettingsScenarioTests
{
    /// <summary>The settings keys whose scenarios these steps prove; the other keys belong to the Roslyn rules.</summary>
    private static readonly HashSet<string> OwnKeys =
    [
        "removeRegions", "removeByteOrderMark", "removeEndOfLineWhitespace", "removeBlankLinesAtTop", "removeBlankLinesAtBottom",
        "removeBlankLinesAfterAttributes", "removeBlankLinesAfterOpeningBrace", "removeBlankLinesBeforeClosingBrace",
        "removeBlankLinesBetweenChainedStatements", "insertBlankLineBeforeReturnAndThrowStatements", "updateEndRegionDirectives",
        "updateSingleLineMethods", "updateAccessorsToBothBeSingleLineOrMultiLine", "formatComments", "fileHeaderCSharp",
        "fileHeaderPosition", "fileHeaderUpdateMode", "sealClassesWhenSafe", "convertToPatternMatchingNullChecks",
        "convertToStringNameOf", "reuseJsonSerializerOptionsForCA1869", "convertStringFormatToInterpolation",
    ];

    private static IEnumerable<string> OwnScenarioIds() => LocalTestbed.Scenarios()
        .Where(scenario => (string?)scenario["category"] == "Settings" && (string?)scenario["entry"] == "cleanup")
        .Where(scenario =>
        {
            var keys = scenario["settings"]!.AsObject().Select(pair => pair.Key).ToList();

            return keys.Count > 0 && keys.All(key => OwnKeys.Contains(key) || key.StartsWith("insertBlankLinePadding", StringComparison.Ordinal));
        })
        .Select(scenario => (string)scenario["id"]!);

    public static TheoryData<string> Scenarios() => Data(OwnScenarioIds());

    private static TheoryData<string> Data(IEnumerable<string> ids)
    {
        var data = new TheoryData<string>();
        foreach (var id in ids)
        {
            data.Add(id);
        }

        return data;
    }

    [Theory]
    [MemberData(nameof(Scenarios))]
    public async Task Scenario_PassesItsChecks_Idempotently(string id)
    {
        var scenario = LocalTestbed.Scenario(id);
        var path = LocalTestbed.FilePath(scenario);
        var user = StepHarness.AllOff(scenario["settings"]!.AsObject());
        var settings = EffectiveSettings.ForFile(path, user);

        var output = (await StepHarness.RunAsync(StepHarness.Document(LocalTestbed.Text(scenario), path), settings)).Text;
        var again = (await StepHarness.RunAsync(StepHarness.Document(output, path), settings)).Text;

        Assert.Equal(string.Empty, LocalTestbed.Failures(scenario, output, []));
        Assert.Equal(output, again);
    }

    /// <summary>The same scenarios through the whole engine (<see cref="CleanupEngine" />), with the shared testbed helper.</summary>
    [Theory]
    [MemberData(nameof(Scenarios))]
    public async Task Scenario_PassesThroughTheEngine(string id)
    {
        var scenario = TestbedScenarios.Get(id);

        var run = await TestbedScenarios.CleanAsync(scenario);

        Assert.Empty(TestbedScenarios.Problems(scenario, run));
    }

    [Fact]
    public void TheTestbedIsFound_AndHasScenariosForTheseSteps() => Assert.True(OwnScenarioIds().Count() >= 45, $"found {OwnScenarioIds().Count()} scenarios at {LocalTestbed.Root}");
}
