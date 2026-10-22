using System.Text.Json.Nodes;
using Xunit;

namespace CodeJanitor.Engine.Tests.Testbed;

/// <summary>
/// The testbed scenarios of the Roslyn slice (categories EditorConfig, CodeStyle, Usings, Policy and Traps, and the settings
/// applied through Roslyn rules) run through <see cref="CleanupEngine"/>: the checks hold, a report-only scenario leaves the code
/// as it was, any other non-trap one changes it, a second run changes nothing, and with the option off the file is unchanged.
/// </summary>
public sealed class TestbedCleanupTests
{
    /// <summary>The settings applied through Roslyn rules, and the Code Style and organize steps of this slice.</summary>
    private static readonly HashSet<string> RoslynSettings = new(StringComparer.Ordinal)
    {
        "convertToVarWhenApparent", "inlineOutVariableDeclarations", "convertToCollectionExpressions", "simplifySingleStatementLambdas",
        "insertExplicitAccessModifiersOnClasses", "insertExplicitAccessModifiersOnDelegates", "insertExplicitAccessModifiersOnEnumerations",
        "insertExplicitAccessModifiersOnEvents", "insertExplicitAccessModifiersOnFields", "insertExplicitAccessModifiersOnInterfaces",
        "insertExplicitAccessModifiersOnMethods", "insertExplicitAccessModifiersOnProperties", "insertExplicitAccessModifiersOnStructs",
        "convertToFileScopedNamespace", "moveUsingsOutsideNamespace", "removeMultipleConsecutiveBlankLines", "makeFieldsReadonlyWhenSafe",
        "organizeUsings",
    };

    /// <summary>
    /// Scenarios whose checks differ from what the Roslyn rule or its native fix does;
    /// they must still be idempotent.
    /// </summary>
    private static readonly Dictionary<string, string> RoslynDivergences = new(StringComparer.Ordinal)
    {
        ["EditorConfigIDE0072IncompleteSwitchOverEnum"] = "not reported as IDE0072: cleanup reports it (populating would add throwing cases)",
    };

    private static readonly HashSet<string> Categories = new(StringComparer.Ordinal) { "EditorConfig", "CodeStyle", "Usings", "Policy", "Traps" };

    public static TheoryData<string> Scenarios => TestbedScenarios.Ids(IsInSlice);

    public static TheoryData<string> OffScenarios => TestbedScenarios.Ids(scenario =>
        IsInSlice(scenario) && !scenario.Everything && !scenario.EditorConfig && !scenario.AlwaysOn && !scenario.Policy);

    [Theory]
    [MemberData(nameof(Scenarios))]
    public async Task EachScenarioAloneOnItsOwnBadCode(string id)
    {
        var scenario = TestbedScenarios.Get(id);
        var run = await TestbedScenarios.CleanAsync(scenario);
        var problems = TestbedScenarios.Problems(scenario, run);

        if (RoslynDivergences.ContainsKey(id))
        {
            Assert.True(run.Again == run.Output, $"{id}: cleaning the result again must change nothing");

            return;
        }

        if (scenario.KnownDefect is not null)
        {
            Assert.True(problems.Count > 0, $"{id} now works: remove its knownDefect ({scenario.KnownDefect})");

            return;
        }

        Assert.True(problems.Count == 0, $"{id}:\n- {string.Join("\n- ", problems)}\nissues: {string.Join(" | ", run.Issues)}\nthe cleaned file is:\n{run.Output}");
    }

    [Theory]
    [MemberData(nameof(OffScenarios))]
    public async Task WithItsOptionTurnedOffTheScenarioLeavesItsCodeAlone(string id)
    {
        var scenario = TestbedScenarios.Get(id);
        var run = await TestbedScenarios.CleanAsync(scenario, TestbedScenarios.OffSettingsOf(scenario));

        Assert.Equal(run.Input, run.Output);
    }

    [Fact]
    public async Task TheFixNamespaceScenario_RunsTheCommandWithTheExpectedNamespace()
    {
        var scenario = TestbedScenarios.All.Single(candidate => candidate.Entry == "fixNamespace");
        var document = TestbedScenarios.CreateDocument(scenario);

        var solution = await new CleanupEngine().ExecuteCommandAsync(document, "fixNamespace", TestbedScenarios.SettingsOf(scenario), new JsonObject { ["namespace"] = scenario.ExpectedNamespace }, CancellationToken.None);
        var output = await TestbedScenarios.TextOfAsync(solution.GetDocument(document.Id)!);

        Assert.Empty(TestbedScenarios.Failures(scenario, output, []));
    }

    private static bool IsInSlice(TestbedScenario scenario) =>
        scenario.Entry == "cleanup"
        && (Categories.Contains(scenario.Category) || (scenario.Category == "Settings" && scenario.Settings.Any(entry => RoslynSettings.Contains(entry.Key))));
}
