using CodeJanitor.Engine.Reorganize;
using CodeJanitor.Engine.Tests.Testbed;
using Xunit;
using static CodeJanitor.Engine.Tests.Reorganize.ReorganizeHarness;

namespace CodeJanitor.Engine.Tests.Reorganize;

/// <summary>
/// The Reorganize scenarios of the public testbed: each scenario file, in the testbed solution, cleaned by the reorganize
/// step with only the scenario's settings on, satisfies its checks, and a second run changes nothing.
/// </summary>
public sealed class ReorganizeTestbedTests
{
    public static TheoryData<string> Scenarios() => TestbedScenarios.Ids(scenario => scenario.Category == "Reorganize");

    [Fact]
    public void FindsTheEighteenReorganizeScenarios()
    {
        Assert.Equal(18, TestbedScenarios.All.Count(scenario => scenario.Category == "Reorganize"));
    }

    [Theory]
    [MemberData(nameof(Scenarios))]
    public async Task SatisfiesTheChecksOfTheScenario(string id)
    {
        var scenario = TestbedScenarios.Get(id);
        var settings = EngineSettings(TestbedScenarios.SettingsOf(scenario));
        var step = new ReorganizeStep();

        Assert.True(step.IsEnabled(settings));
        var document = TestbedScenarios.CreateDocument(scenario);
        var once = await TestbedScenarios.TextOfAsync((await step.ApplyAsync(document, settings, CancellationToken.None)).GetDocument(document.Id)!);
        var again = TestbedScenarios.CreateDocument(scenario, once);
        var twice = await TestbedScenarios.TextOfAsync((await step.ApplyAsync(again, settings, CancellationToken.None)).GetDocument(again.Id)!);

        Assert.Equal(once, twice);
        var failures = TestbedScenarios.Failures(scenario, once, []);
        Assert.True(failures.Count == 0, $"{id}: {string.Join("; ", failures)}\n--- output ---\n{once}");
    }
}
