using System.Text.Json.Nodes;
using CodeJanitor.Engine.Settings;
using Xunit;

namespace CodeJanitor.Engine.Tests.Settings;

/// <summary>
/// The <c>.codejanitor</c> policy: the nearest file wins as a whole, aliases fan out, unknown keys,
/// wrong types and invalid JSON are ignored.
/// </summary>
public sealed class RepositoryPolicyTests : IDisposable
{
    private readonly string _tempDirectory = Path.Combine(Path.GetTempPath(), "CodeJanitor.UnitTests", Guid.NewGuid().ToString("N"));

    public RepositoryPolicyTests() => Directory.CreateDirectory(_tempDirectory);

    public void Dispose()
    {
        if (Directory.Exists(_tempDirectory))
        {
            Directory.Delete(_tempDirectory, true);
        }
    }

    [Fact]
    public void Parse_ReadsTheListedSettings()
    {
        var policy = RepositoryPolicy.Parse("""{ "cleanup": { "convertToVarWhenApparent": true, "removeEndOfLineWhitespace": false } }""");

        Assert.True(policy.Overrides["convertToVarWhenApparent"]!.GetValue<bool>());
        Assert.False(policy.Overrides["removeEndOfLineWhitespace"]!.GetValue<bool>());
        Assert.Equal(2, policy.Overrides.Count);
    }

    [Fact]
    public void Parse_AppliesGroupAliases_AndIndividualKeysWin()
    {
        var policy = RepositoryPolicy.Parse("""{ "cleanup": { "insertBlankLinePadding": false, "insertBlankLinePaddingBeforeClasses": true, "insertExplicitAccessModifiers": false } }""");

        Assert.False(policy.Overrides["insertBlankLinePaddingAfterMethods"]!.GetValue<bool>());
        Assert.True(policy.Overrides["insertBlankLinePaddingBeforeClasses"]!.GetValue<bool>());
        Assert.False(policy.Overrides.ContainsKey("insertBlankLinePaddingBeforeSingleLineComments"));
        Assert.False(policy.Overrides["insertExplicitAccessModifiersOnStructs"]!.GetValue<bool>());
    }

    [Theory]
    [InlineData("{ this is not json")]
    [InlineData("""{ "other": {} }""")]
    [InlineData("""{ "cleanup": [] }""")]
    [InlineData("""{ "cleanup": { "unknownKey": true, "convertToVarWhenApparent": "yes", "removeRegions": "no", "fileHeaderCSharp": 3 } }""")]
    public void Parse_IgnoresUnknownKeysWrongTypesAndInvalidJson(string text)
    {
        var policy = RepositoryPolicy.Parse(text);

        Assert.Empty(policy.Overrides);
        Assert.Empty(policy.CodeStyle);
    }

    [Theory]
    [InlineData("afterUsings", "replace", "afterUsings", "replace")]
    [InlineData("AfterUsings", "Replace", null, null)]
    [InlineData("replace", "afterUsings", null, null)]
    public void Parse_HeaderEnums_AcceptOnlyTheirExactNames(string position, string mode, string? expectedPosition, string? expectedMode)
    {
        var policy = RepositoryPolicy.Parse($$"""{ "cleanup": { "fileHeaderPosition": "{{position}}", "fileHeaderUpdateMode": "{{mode}}", "fileHeaderCSharp": "// Example" } }""");

        Assert.Equal(expectedPosition, policy.Overrides["fileHeaderPosition"]?.GetValue<string>());
        Assert.Equal(expectedMode, policy.Overrides["fileHeaderUpdateMode"]?.GetValue<string>());
        Assert.Equal("// Example", policy.Overrides["fileHeaderCSharp"]!.GetValue<string>());
    }

    [Fact]
    public void Parse_AcceptsTheAliasOfReturnAndThrowPadding()
    {
        var policy = RepositoryPolicy.Parse("""{ "cleanup": { "insertBlankLineBeforeReturnAndThrow": true } }""");

        Assert.True(policy.Overrides["insertBlankLineBeforeReturnAndThrowStatements"]!.GetValue<bool>());
    }

    [Fact]
    public void Parse_ReadsRegionAndUsingOrganizationPolicies()
    {
        var policy = RepositoryPolicy.Parse("""{ "cleanup": { "removeRegions": false, "organizeUsings": true } }""");

        Assert.False(policy.Overrides["removeRegions"]!.GetValue<bool>());
        Assert.True(policy.Overrides["organizeUsings"]!.GetValue<bool>());
    }

    [Fact]
    public void Parse_CodeStyleValues_IgnoreCase_AreNormalized_NullDisables_AndJsonBooleansAreIgnored()
    {
        var policy = RepositoryPolicy.Parse("""{ "cleanup": { "codeStyle": { "csharp_prefer_braces": "WHEN_MULTILINE", "dotnet_style_null_propagation": null, "csharp_style_throw_expression": true, "unknown_rule": "true", "dotnet_style_object_initializer": "sometimes" } } }""");

        Assert.Equal("when_multiline", policy.CodeStyle["csharp_prefer_braces"]);
        Assert.Null(policy.CodeStyle["dotnet_style_null_propagation"]);
        Assert.Equal(2, policy.CodeStyle.Count);
    }

    [Fact]
    public void Parse_UnusableCodeStyleSection_DefinesNoRule()
    {
        Assert.Empty(RepositoryPolicy.Parse("""{ "cleanup": { "codeStyle": "csharp_prefer_braces=true" } }""").CodeStyle);
    }

    [Fact]
    public void Parse_VisualStudioOnlyKeys_AreReportedAsIgnored()
    {
        var ignored = new List<string>();

        var policy = RepositoryPolicy.Parse("""{ "cleanup": { "applyEditorConfigNaming": false, "removeRegions": false } }""", onIgnoredKey: (key, _) => ignored.Add(key));

        Assert.Equal(["applyEditorConfigNaming"], ignored);
        Assert.Single(policy.Overrides);
    }

    [Fact]
    public void ApplyTo_ListedKeysWin_AndTheCodeStyleSectionEditsTheUserRules()
    {
        var user = CleanupSettingsDefaults.Create();
        user["removeRegions"] = true;
        user["codeStyleRules"] = new JsonObject { ["dotnet_style_null_propagation"] = "true", ["csharp_prefer_simple_using_statement"] = "true" };
        var policy = RepositoryPolicy.Parse("""{ "cleanup": { "removeRegions": false, "codeStyle": { "csharp_prefer_braces": "true", "dotnet_style_null_propagation": null } } }""");

        var settings = policy.ApplyTo(user);

        Assert.False(settings["removeRegions"]!.GetValue<bool>());
        Assert.True(user["removeRegions"]!.GetValue<bool>());
        var rules = settings["codeStyleRules"]!.AsObject();
        Assert.Equal(["csharp_prefer_simple_using_statement", "csharp_prefer_braces"], rules.Select(entry => entry.Key));
    }

    [Fact]
    public void ForDirectory_WalksUpToTheNearestPolicy_AndTheNearestWinsAsAWhole()
    {
        File.WriteAllText(Path.Combine(_tempDirectory, ".codejanitor"), """{ "cleanup": { "removeRegions": false, "organizeUsings": true } }""");
        var nested = Directory.CreateDirectory(Path.Combine(_tempDirectory, "src", "App"));
        File.WriteAllText(Path.Combine(_tempDirectory, "src", ".code-janitor.json"), """{ "cleanup": { "convertToVarWhenApparent": true } }""");

        var policy = RepositoryPolicy.ForDirectory(nested.FullName);

        Assert.Equal(Path.Combine(_tempDirectory, "src", ".code-janitor.json"), policy.ConfigPath);
        Assert.Equal(["convertToVarWhenApparent"], policy.Overrides.Select(entry => entry.Key));
    }

    [Fact]
    public void ForDirectory_PrimaryFileName_WinsOverTheAlternateInTheSameDirectory()
    {
        File.WriteAllText(Path.Combine(_tempDirectory, ".codejanitor"), """{ "cleanup": { "removeRegions": false } }""");
        File.WriteAllText(Path.Combine(_tempDirectory, ".code-janitor.json"), """{ "cleanup": { "removeRegions": true } }""");

        Assert.False(RepositoryPolicy.ForDirectory(_tempDirectory).Overrides["removeRegions"]!.GetValue<bool>());
    }

    [Fact]
    public void ForDirectory_DirectoryNamedLikeThePolicy_IsNotAPolicy()
    {
        Directory.CreateDirectory(Path.Combine(_tempDirectory, "inner", ".codejanitor"));
        File.WriteAllText(Path.Combine(_tempDirectory, ".codejanitor"), """{ "cleanup": { "removeRegions": false } }""");

        Assert.Equal(Path.Combine(_tempDirectory, ".codejanitor"), RepositoryPolicy.ForDirectory(Path.Combine(_tempDirectory, "inner")).ConfigPath);
    }

    [Fact]
    public void ForDirectory_NearestPolicyIsInvalid_DoesNotFallBackToAParentPolicy()
    {
        File.WriteAllText(Path.Combine(_tempDirectory, ".codejanitor"), """{ "cleanup": { "removeRegions": false } }""");
        var inner = Directory.CreateDirectory(Path.Combine(_tempDirectory, "inner"));
        File.WriteAllText(Path.Combine(inner.FullName, ".codejanitor"), "{ not json");

        Assert.Empty(RepositoryPolicy.ForDirectory(inner.FullName).Overrides);
    }

    [Fact]
    public void ForDirectory_InvalidJson_IsReportedAsAnIssueOncePerFile()
    {
        var path = Path.Combine(_tempDirectory, ".codejanitor");
        File.WriteAllText(path, "{ not json");

        var first = RepositoryPolicy.ForDirectory(_tempDirectory);
        var second = RepositoryPolicy.ForDirectory(_tempDirectory);

        var issue = Assert.Single(first.Issues);
        Assert.Contains(".codejanitor is not valid JSON and is ignored", issue, StringComparison.Ordinal);
        Assert.Empty(first.Overrides);
        Assert.Equal(path, first.ConfigPath);
        Assert.Empty(second.Issues);
    }

    [Theory]
    [InlineData(typeof(IOException))]
    [InlineData(typeof(UnauthorizedAccessException))]
    public void ForDirectory_UnreadableFile_IsReportedAsAnIssueOncePerFile(Type failure)
    {
        var path = Path.Combine(_tempDirectory, ".codejanitor");
        File.WriteAllText(path, """{ "cleanup": { "removeRegions": false } }""");
        string Unreadable(string file) => throw (Exception)Activator.CreateInstance(failure, "access denied")!;

        var first = RepositoryPolicy.ForDirectory(_tempDirectory, Unreadable);
        var second = RepositoryPolicy.ForDirectory(_tempDirectory, Unreadable);

        var issue = Assert.Single(first.Issues);
        Assert.Contains(".codejanitor could not be read and is ignored", issue, StringComparison.Ordinal);
        Assert.Contains("access denied", issue, StringComparison.Ordinal);
        Assert.Empty(first.Overrides);
        Assert.Empty(second.Issues);
    }

    [Fact]
    public void Parse_InvalidJson_ReportsTheErrorToTheCaller()
    {
        string? reported = null;

        var policy = RepositoryPolicy.Parse("{ not json", onInvalid: message => reported = message);

        Assert.Same(RepositoryPolicy.None, policy);
        Assert.NotNull(reported);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    public void ForDirectory_WithoutADirectory_IsNoPolicy(string? directory)
    {
        Assert.Same(RepositoryPolicy.None, RepositoryPolicy.ForDirectory(directory));
    }
}
