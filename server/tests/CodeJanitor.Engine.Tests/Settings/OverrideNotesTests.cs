using System.Text.Json.Nodes;
using CodeJanitor.Engine.Settings;
using Xunit;

namespace CodeJanitor.Engine.Tests.Settings;

/// <summary>
/// The settings panel notes for <c>.editorconfig</c> and <c>.codejanitor</c> overrides, evaluated for a C# file in the
/// workspace folder.
/// </summary>
public sealed class OverrideNotesTests : IDisposable
{
    private readonly string _tempDirectory;
    private readonly string _workspace;
    private readonly JsonObject _user = CleanupSettingsDefaults.Create();

    public OverrideNotesTests()
    {
        _tempDirectory = Path.Combine(Path.GetTempPath(), "CodeJanitor.UnitTests", Guid.NewGuid().ToString("N"));
        _workspace = Path.Combine(_tempDirectory, "repo");
        Directory.CreateDirectory(_workspace);
        WriteEditorConfig(_tempDirectory, isRoot: true);
    }

    public void Dispose()
    {
        if (Directory.Exists(_tempDirectory))
        {
            Directory.Delete(_tempDirectory, true);
        }
    }

    [Theory]
    [InlineData("trim_trailing_whitespace = true", "removeEndOfLineWhitespace", "trim_trailing_whitespace")]
    [InlineData("csharp_style_var_when_type_is_apparent = false:warning", "convertToVarWhenApparent", "csharp_style_var_when_type_is_apparent")]
    [InlineData("csharp_style_inlined_variable_declaration = true:suggestion", "inlineOutVariableDeclarations", "csharp_style_inlined_variable_declaration")]
    [InlineData("dotnet_style_prefer_collection_expression = when_types_loosely_match", "convertToCollectionExpressions", "dotnet_style_prefer_collection_expression")]
    [InlineData("dotnet_style_require_accessibility_modifiers = always:warning", "insertExplicitAccessModifiersOnFields", "dotnet_style_require_accessibility_modifiers")]
    [InlineData("dotnet_style_readonly_field = true:suggestion", "makeFieldsReadonlyWhenSafe", "dotnet_style_readonly_field")]
    [InlineData("csharp_style_namespace_declarations = file_scoped:warning", "convertToFileScopedNamespace", "csharp_style_namespace_declarations")]
    [InlineData("csharp_using_directive_placement = inside_namespace", "moveUsingsOutsideNamespace", "csharp_using_directive_placement")]
    [InlineData("file_header_template = Copyright (c) Contoso", "fileHeaderCSharp", "file_header_template")]
    [InlineData("csharp_style_expression_bodied_lambdas = false:warning", "simplifySingleStatementLambdas", "csharp_style_expression_bodied_lambdas")]
    [InlineData("dotnet_diagnostic.CA1852.severity = warning", "sealClassesWhenSafe", "dotnet_diagnostic.ca1852.severity")]
    [InlineData("dotnet_diagnostic.IDE0005.severity = warning", "organizeUsings", "dotnet_diagnostic.ide0005.severity")]
    [InlineData("csharp_prefer_braces = when_multiline:warning", "csharp_prefer_braces", "csharp_prefer_braces")]
    [InlineData("dotnet_diagnostic.IDE0003.severity = error", "dotnet_style_qualification_for_event", "dotnet_diagnostic.ide0003.severity")]
    public async Task AnEnforcedEditorConfigKey_NamesTheKeyAndTheDefiningFile(string option, string settingName, string key)
    {
        var configPath = WriteEditorConfig(_workspace, isRoot: false, option);

        var notes = await NotesAsync(_workspace);

        Assert.Equal($"Overridden by .editorconfig: {key} in {configPath}", notes.GetValueOrDefault(settingName));
    }

    [Fact]
    public async Task EveryMappedKeyDefined_AnnotatesExactlyTheMappedSettings()
    {
        WriteEditorConfig(
            _workspace,
            isRoot: false,
            "trim_trailing_whitespace = true",
            "insert_final_newline = true",
            "file_header_template = Header",
            "csharp_style_var_when_type_is_apparent = true",
            "csharp_style_inlined_variable_declaration = true",
            "dotnet_style_prefer_collection_expression = true",
            "dotnet_style_readonly_field = true",
            "dotnet_style_require_accessibility_modifiers = always",
            "csharp_style_namespace_declarations = file_scoped",
            "csharp_using_directive_placement = outside_namespace",
            "indent_style = space",
            "dotnet_sort_system_directives_first = true");

        var notes = await NotesAsync(_workspace);

        string[] expected =
        [
            "convertToCollectionExpressions", "convertToFileScopedNamespace", "convertToVarWhenApparent", "fileHeaderCSharp",
            "inlineOutVariableDeclarations", "insertExplicitAccessModifiersOnClasses", "insertExplicitAccessModifiersOnDelegates",
            "insertExplicitAccessModifiersOnEnumerations", "insertExplicitAccessModifiersOnEvents", "insertExplicitAccessModifiersOnFields",
            "insertExplicitAccessModifiersOnInterfaces", "insertExplicitAccessModifiersOnMethods", "insertExplicitAccessModifiersOnProperties",
            "insertExplicitAccessModifiersOnStructs", "makeFieldsReadonlyWhenSafe", "moveUsingsOutsideNamespace", "organizeUsings",
            "removeEndOfLineWhitespace",
        ];
        Assert.Equal(expected.Order(StringComparer.Ordinal), notes.Keys.Order(StringComparer.Ordinal));
    }

    [Theory]
    [InlineData("csharp_style_var_when_type_is_apparent = true:none")]
    [InlineData("csharp_style_var_when_type_is_apparent = true:silent")]
    [InlineData("csharp_style_var_when_type_is_apparent = maybe")]
    [InlineData("csharp_style_var_when_type_is_apparent = true:loud")]
    public async Task AKeyThatIsNotEnforced_HasNoNote(string option)
    {
        WriteEditorConfig(_workspace, isRoot: false, option);

        Assert.False((await NotesAsync(_workspace)).ContainsKey("convertToVarWhenApparent"));
    }

    [Fact]
    public async Task AKeyOnlyInTheParentConfig_NamesTheParentFile()
    {
        WriteEditorConfig(_workspace, isRoot: false, "dotnet_style_readonly_field = true");
        var parentPath = WriteEditorConfig(_tempDirectory, isRoot: true, "csharp_style_var_when_type_is_apparent = true");

        Assert.Equal($"Overridden by .editorconfig: csharp_style_var_when_type_is_apparent in {parentPath}", (await NotesAsync(_workspace))["convertToVarWhenApparent"]);
    }

    [Fact]
    public async Task AKeyInTheWorkspaceAndTheParentConfig_NamesTheNearestFile()
    {
        WriteEditorConfig(_tempDirectory, isRoot: true, "csharp_style_var_when_type_is_apparent = true");
        var nearestPath = WriteEditorConfig(_workspace, isRoot: false, "csharp_style_var_when_type_is_apparent = false");

        Assert.Equal($"Overridden by .editorconfig: csharp_style_var_when_type_is_apparent in {nearestPath}", (await NotesAsync(_workspace))["convertToVarWhenApparent"]);
    }

    [Fact]
    public async Task AKeyAboveARootConfig_HasNoNote()
    {
        var outer = Path.Combine(_tempDirectory, "outer");
        var workspace = Path.Combine(outer, "repo");
        Directory.CreateDirectory(workspace);
        WriteEditorConfig(outer, isRoot: false, "csharp_style_var_when_type_is_apparent = true");
        WriteEditorConfig(workspace, isRoot: true, "dotnet_style_readonly_field = true");

        Assert.False((await NotesAsync(workspace)).ContainsKey("convertToVarWhenApparent"));
    }

    [Fact]
    public async Task AKeyOnlyInANestedConfig_OrInANonCSharpSection_HasNoNote()
    {
        var project = Directory.CreateDirectory(Path.Combine(_workspace, "src"));
        WriteEditorConfig(project.FullName, isRoot: false, "csharp_style_var_when_type_is_apparent = true");
        File.WriteAllText(Path.Combine(_workspace, ".editorconfig"), "[*.vb]\r\ndotnet_style_readonly_field = true\r\n");

        var notes = await NotesAsync(_workspace);

        Assert.False(notes.ContainsKey("convertToVarWhenApparent"));
        Assert.False(notes.ContainsKey("makeFieldsReadonlyWhenSafe"));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public async Task WithoutAWorkspace_ThereAreNoNotes(string directory)
    {
        Assert.Empty(await NotesAsync(directory));
    }

    [Fact]
    public void AKeyMappedToManySettings_ResolvesItsDefiningFileOnce()
    {
        WriteEditorConfig(_workspace, isRoot: false, "dotnet_style_require_accessibility_modifiers = always", "trim_trailing_whitespace = true");
        List<string> lookups = [];

        OverrideNotes.For(Path.Combine(_workspace, "Probe.cs"), _user, (_, key) =>
        {
            lookups.Add(key);

            return "defining.editorconfig";
        });

        Assert.Equivalent(new[] { "dotnet_style_require_accessibility_modifiers", "trim_trailing_whitespace" }, lookups, strict: true);
    }

    [Fact]
    public void AnUnresolvedDefiningFile_NamesOnlyTheKey()
    {
        WriteEditorConfig(_workspace, isRoot: false, "csharp_style_var_when_type_is_apparent = true");

        var notes = OverrideNotes.For(Path.Combine(_workspace, "Probe.cs"), _user, (_, _) => null);

        Assert.Equal("Overridden by .editorconfig: csharp_style_var_when_type_is_apparent", notes["convertToVarWhenApparent"]);
    }

    [Fact]
    public async Task ASettingTheCodeJanitorPolicyLists_NamesThePolicy_UnlessEditorConfigDecidesIt()
    {
        var policyPath = Path.Combine(_workspace, ".codejanitor");
        File.WriteAllText(policyPath, """{ "cleanup": { "removeRegions": false, "convertToVarWhenApparent": true, "codeStyle": { "csharp_prefer_braces": "true" } } }""");
        var configPath = WriteEditorConfig(_workspace, isRoot: false, "csharp_style_var_when_type_is_apparent = false:warning");

        var notes = await NotesAsync(_workspace);

        Assert.Equal($"Overridden by .codejanitor: removeRegions in {policyPath}", notes["removeRegions"]);
        Assert.Equal($"Overridden by .codejanitor: csharp_prefer_braces in {policyPath}", notes["csharp_prefer_braces"]);
        Assert.Equal($"Overridden by .editorconfig: csharp_style_var_when_type_is_apparent in {configPath}", notes["convertToVarWhenApparent"]);
    }

    private Task<IReadOnlyDictionary<string, string>> NotesAsync(string directory) =>
        new CleanupEngine().OverrideNotesAsync(directory, _user, CancellationToken.None);

    private static string WriteEditorConfig(string directory, bool isRoot, params string[] csharpOptions)
    {
        var lines = (isRoot ? new[] { "root = true", string.Empty } : []).Concat(["[*.cs]"]).Concat(csharpOptions).Concat([string.Empty]);
        var path = Path.Combine(directory, ".editorconfig");
        File.WriteAllText(path, string.Join("\r\n", lines));

        return path;
    }
}
