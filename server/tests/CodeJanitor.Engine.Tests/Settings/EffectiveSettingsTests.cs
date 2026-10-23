#nullable disable

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json.Nodes;
using CodeJanitor.Engine.Settings;
using Xunit;

namespace CodeJanitor.Engine.Tests.Settings;

/// <summary>
/// Behavioral tests for <see cref="EffectiveSettings" />: .editorconfig wins for every mapped key, the
/// repository policy (.codejanitor) wins otherwise, and the user's Visual Studio settings apply last.
/// </summary>
public sealed class EffectiveSettingsTests : IDisposable
{
    private const string ExplicitAccessModifiersSetting = "insertExplicitAccessModifiersOnClasses";

    private readonly string _tempDirectory;
    private readonly string _filePath;
    private JsonObject _user;

    public EffectiveSettingsTests()
    {
        _user = CleanupSettingsDefaults.Create();
        _tempDirectory = Path.Combine(Path.GetTempPath(), "CodeJanitor.UnitTests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_tempDirectory);
        _filePath = Path.Combine(_tempDirectory, "Sample.cs");

        // Isolate every test from configuration files above the temp directory: an empty root .editorconfig and an
        // empty repository policy (the nearest policy file wins).
        WriteRootEditorConfig();
        WritePolicy(string.Empty);
    }

    public void Dispose()
    {
        if (Directory.Exists(_tempDirectory))
        {
            Directory.Delete(_tempDirectory, true);
        }
    }

    [Fact]
    public void GetBoolean_EditorConfigValue_BeatsRepositoryPolicyAndUserSetting()
    {
        _user["convertToVarWhenApparent"] = true;
        WritePolicy("\"convertToVarWhenApparent\": true");
        WriteRootEditorConfig("csharp_style_var_when_type_is_apparent = false:warning");

        Assert.False(EffectiveSettings.ForFile(_filePath, _user).GetBool("convertToVarWhenApparent"));
    }

    [Fact]
    public void GetBoolean_EditorConfigSilentOnTheKey_UsesRepositoryPolicyOverUserSetting()
    {
        _user["makeFieldsReadonlyWhenSafe"] = false;
        WritePolicy("\"makeFieldsReadonlyWhenSafe\": true");
        WriteRootEditorConfig("csharp_style_var_when_type_is_apparent = true");

        Assert.True(EffectiveSettings.ForFile(_filePath, _user).GetBool("makeFieldsReadonlyWhenSafe"));
    }

    [Fact]
    public void GetBoolean_NeitherFileDefinesTheKey_UsesUserSetting()
    {
        _user["makeFieldsReadonlyWhenSafe"] = true;
        WritePolicy("\"convertToVarWhenApparent\": false");
        WriteRootEditorConfig("csharp_style_var_when_type_is_apparent = true");

        Assert.True(EffectiveSettings.ForFile(_filePath, _user).GetBool("makeFieldsReadonlyWhenSafe"));
    }

    public static TheoryData<string> BlankOrInvalidPaths()
    {
        var paths = new TheoryData<string> { null, string.Empty, "Sample\0.cs" };
        if (OperatingSystem.IsWindows())
        {
            paths.Add(@"C:\bad<|>path\Sample.cs");
        }

        return paths;
    }

    [Theory]
    [MemberData(nameof(BlankOrInvalidPaths))]
    public void For_BlankOrInvalidPath_UsesUserSettingsOnly(string filePath)
    {
        _user["convertToVarWhenApparent"] = true;
        _user["convertToFileScopedNamespace"] = true;
        _user["moveUsingsOutsideNamespace"] = false;

        EffectiveSettings settings = EffectiveSettings.ForFile(filePath, _user);

        Assert.True(settings.GetBool("convertToVarWhenApparent"));
        Assert.Equal("file_scoped:suggestion", GetOverride(settings, "csharp_style_namespace_declarations"));
        Assert.Null(GetOverride(settings, "csharp_using_directive_placement"));
        Assert.True(settings.GetBool("removeRegions"));
        Assert.False(settings.GetBool("organizeUsings"));
    }

    [Fact]
    public void NamespaceDeclarations_FileScopedInEditorConfig_OverridesDisabledUserSetting()
    {
        _user["convertToFileScopedNamespace"] = false;
        WriteRootEditorConfig("csharp_style_namespace_declarations = file_scoped:suggestion");

        EffectiveSettings settings = EffectiveSettings.ForFile(_filePath, _user);

        Assert.Equal("file_scoped:suggestion", GetOverride(settings, "csharp_style_namespace_declarations"));
        Assert.True(settings.GetBool("convertToFileScopedNamespace"));
    }

    [Fact]
    public void NamespaceDeclarations_BlockScopedInEditorConfig_BeatsRepositoryPolicyAndUserSetting()
    {
        _user["convertToFileScopedNamespace"] = true;
        WritePolicy("\"convertToFileScopedNamespace\": true");
        WriteRootEditorConfig("csharp_style_namespace_declarations = block_scoped:warning");

        EffectiveSettings settings = EffectiveSettings.ForFile(_filePath, _user);

        Assert.Equal("block_scoped:suggestion", GetOverride(settings, "csharp_style_namespace_declarations"));
        Assert.Equal("suggestion", GetOverride(settings, "dotnet_diagnostic.IDE0160.severity"));
        Assert.False(settings.GetBool("convertToFileScopedNamespace"));
    }

    [Theory]
    [InlineData(true, false, true)]
    [InlineData(false, true, false)]
    public void NamespaceDeclarations_EditorConfigSilent_RepositoryPolicyBeatsUserSetting(bool policy, bool userSetting, bool applied)
    {
        _user["convertToFileScopedNamespace"] = userSetting;
        WritePolicy($"\"convertToFileScopedNamespace\": {(policy ? "true" : "false")}");

        Assert.Equal(applied ? "file_scoped:suggestion" : null, GetOverride(EffectiveSettings.ForFile(_filePath, _user), "csharp_style_namespace_declarations"));
    }

    [Theory]
    [InlineData("inside_namespace", true, false)]
    [InlineData("outside_namespace:suggestion", false, true)]
    public void UsingDirectivePlacement_EditorConfigValue_BeatsUserSetting(
        string option,
        bool userSetting,
        bool expectedMoveOutside)
    {
        _user["moveUsingsOutsideNamespace"] = userSetting;
        WriteRootEditorConfig($"csharp_using_directive_placement = {option}");

        EffectiveSettings settings = EffectiveSettings.ForFile(_filePath, _user);

        Assert.Equal(option.Split(':')[0] + ":suggestion", GetOverride(settings, "csharp_using_directive_placement"));
        Assert.Equal(expectedMoveOutside, settings.GetBool("moveUsingsOutsideNamespace"));
    }

    [Theory]
    [InlineData(null, true, true)]
    [InlineData(null, false, false)]
    [InlineData(false, true, false)]
    [InlineData(true, false, true)]
    public void UsingDirectivePlacement_EditorConfigSilent_RepositoryPolicyBeatsUserSetting(bool? policy, bool userSetting, bool applied)
    {
        _user["moveUsingsOutsideNamespace"] = userSetting;
        if (policy.HasValue)
        {
            WritePolicy($"\"moveUsingsOutsideNamespace\": {(policy.Value ? "true" : "false")}");
        }

        Assert.Equal(applied ? "outside_namespace:suggestion" : null, GetOverride(EffectiveSettings.ForFile(_filePath, _user), "csharp_using_directive_placement"));
    }

    [Theory]
    [InlineData("false", true, false)]
    [InlineData("true", false, true)]
    public void TrimTrailingWhitespace_EditorConfigValue_BeatsUserSetting(string option, bool userSetting, bool expected)
    {
        _user["removeEndOfLineWhitespace"] = userSetting;
        WriteRootEditorConfig($"trim_trailing_whitespace = {option}");

        Assert.Equal(expected, EffectiveSettings.ForFile(_filePath, _user).GetBool("removeEndOfLineWhitespace"));
    }

    [Theory]
    [InlineData("true", "false", null, true)]
    [InlineData("true", null, false, true)]
    [InlineData("true", "true", true, false)]
    [InlineData("false", null, true, false)]
    [InlineData("true:none", "true:none", true, true)]
    [InlineData(null, "false", true, true)]
    [InlineData(null, null, true, true)]
    [InlineData(null, null, null, false)]
    [InlineData("true:none", null, null, false)]
    [InlineData("true:none", null, false, false)]
    public void OrganizeUsings_EditorConfigDecidesWhenItDefinesTheSortOrder(
        string sortSystemDirectivesFirst,
        string separateImportDirectiveGroups,
        bool? policy,
        bool expected)
    {
        WriteRootEditorConfig(
            sortSystemDirectivesFirst is null ? null : $"dotnet_sort_system_directives_first = {sortSystemDirectivesFirst}",
            separateImportDirectiveGroups is null ? null : $"dotnet_separate_import_directive_groups = {separateImportDirectiveGroups}");
        if (policy.HasValue)
        {
            WritePolicy($"\"organizeUsings\": {(policy.Value ? "true" : "false")}");
        }

        Assert.Equal(expected, EffectiveSettings.ForFile(_filePath, _user).GetBool("organizeUsings"));
    }

    [Theory]
    [InlineData("csharp_style_var_when_type_is_apparent = true:suggestion", "convertToVarWhenApparent", true)]
    [InlineData("csharp_style_var_when_type_is_apparent = false", "convertToVarWhenApparent", false)]
    [InlineData("csharp_style_inlined_variable_declaration = false:warning", "inlineOutVariableDeclarations", false)]
    [InlineData("csharp_style_inlined_variable_declaration = true", "inlineOutVariableDeclarations", true)]
    [InlineData("dotnet_style_readonly_field = true:warning", "makeFieldsReadonlyWhenSafe", true)]
    [InlineData("dotnet_style_readonly_field = false", "makeFieldsReadonlyWhenSafe", false)]
    [InlineData("dotnet_style_prefer_collection_expression = true", "convertToCollectionExpressions", true)]
    [InlineData("dotnet_style_prefer_collection_expression = when_types_exactly_match", "convertToCollectionExpressions", true)]
    [InlineData("dotnet_style_prefer_collection_expression = when_types_loosely_match:suggestion", "convertToCollectionExpressions", true)]
    [InlineData("dotnet_style_prefer_collection_expression = false", "convertToCollectionExpressions", false)]
    [InlineData("dotnet_style_prefer_collection_expression = never", "convertToCollectionExpressions", false)]
    public void GetBoolean_CodeStyleOption_MapsToCleanupSetting(string option, string settingName, bool expected)
    {
        SetUser(settingName, !expected);
        WritePolicy($"\"{settingName}\": {(expected ? "false" : "true")}");
        WriteRootEditorConfig(option);

        Assert.Equal(expected, EffectiveSettings.ForFile(_filePath, _user).GetBool(settingName));
    }

    [Theory]
    [InlineData("always", true)]
    [InlineData("for_non_interface_members:warning", true)]
    [InlineData("never", false)]
    [InlineData("omit_if_default:suggestion", false)]
    public void GetBoolean_RequireAccessibilityModifiers_DrivesTheExplicitAccessModifierSetting(string option, bool expected)
    {
        SetUser(ExplicitAccessModifiersSetting, !expected);
        WriteRootEditorConfig($"dotnet_style_require_accessibility_modifiers = {option}");

        Assert.Equal(expected, EffectiveSettings.ForFile(_filePath, _user).GetBool(ExplicitAccessModifiersSetting));
    }

    [Theory]
    [InlineData("dotnet_style_require_accessibility_modifiers = never", ExplicitAccessModifiersSetting, "IDE0040")]
    [InlineData("dotnet_style_require_accessibility_modifiers = omit_if_default", ExplicitAccessModifiersSetting, "IDE0040")]
    [InlineData("csharp_style_var_when_type_is_apparent = false", "convertToVarWhenApparent", "IDE0007")]
    [InlineData("csharp_style_expression_bodied_lambdas = false", "simplifySingleStatementLambdas", "IDE0053")]
    [InlineData("dotnet_style_prefer_collection_expression = never", "convertToCollectionExpressions", "IDE0300")]
    [InlineData("dotnet_style_allow_multiple_blank_lines_experimental = true", "removeMultipleConsecutiveBlankLines", "IDE2000")]
    [InlineData("csharp_style_inlined_variable_declaration = false", "inlineOutVariableDeclarations", "IDE0018")]
    [InlineData("dotnet_style_readonly_field = false", "makeFieldsReadonlyWhenSafe", "IDE0044")]
    public void RoslynStep_DisabledByAnEditorConfigValue_WithoutReverseRule_AddsNoOverride(string option, string settingName, string diagnosticId)
    {
        SetUser(settingName, true);
        WriteRootEditorConfig(option);

        EffectiveSettings settings = EffectiveSettings.ForFile(_filePath, _user);

        Assert.False(settings.GetBool(settingName));
        Assert.Null(GetOverride(settings, option.Substring(0, option.IndexOf(' '))));
        Assert.Null(GetOverride(settings, $"dotnet_diagnostic.{diagnosticId}.severity"));
    }

    [Fact]
    public void GetString_FileHeaderTemplate_BuildsCommentHeaderFromEscapesAndFileName()
    {
        _user["fileHeaderCSharp"] = "// User header";
        WritePolicy("\"fileHeaderCSharp\": \"// Policy header\"");
        WriteRootEditorConfig(@"file_header_template = Copyright: Contoso Ltd.\n\n{fileName} is licensed under MIT.");

        string header = EffectiveSettings.ForFile(_filePath, _user).GetString("fileHeaderCSharp");

        Assert.Equal(string.Join("\n", "// Copyright: Contoso Ltd.", "//", "// Sample.cs is licensed under MIT."), header);
    }

    [Fact]
    public void GetString_FileHeaderTemplateUnset_ClearsRepositoryAndUserHeader()
    {
        _user["fileHeaderCSharp"] = "// User header";
        WritePolicy("\"fileHeaderCSharp\": \"// Policy header\"");
        WriteRootEditorConfig("file_header_template = unset");

        Assert.Equal(string.Empty, EffectiveSettings.ForFile(_filePath, _user).GetString("fileHeaderCSharp"));
    }

    [Fact]
    public void NoneSeverity_IgnoresTheOption_SoThePolicyAndThenTheUserSettingsDecide()
    {
        // The policy defines some of the steps; the user settings decide the others.
        _user["convertToFileScopedNamespace"] = true;
        _user["moveUsingsOutsideNamespace"] = true;
        _user["convertToVarWhenApparent"] = true;
        WritePolicy("\"convertToFileScopedNamespace\": false, \"convertToVarWhenApparent\": false");
        WriteRootEditorConfig(
            "csharp_style_namespace_declarations = file_scoped:none",
            "csharp_using_directive_placement = inside_namespace:none",
            "csharp_style_var_when_type_is_apparent = true:none",
            "indent_style = tab:none",
            "insert_final_newline = false:none");

        EffectiveSettings settings = EffectiveSettings.ForFile(_filePath, _user);

        Assert.Null(GetOverride(settings, "csharp_style_namespace_declarations"));
        Assert.False(settings.GetBool("convertToFileScopedNamespace"), "policy");
        Assert.False(settings.GetBool("convertToVarWhenApparent"), "policy");
        Assert.Equal("outside_namespace:suggestion", GetOverride(settings, "csharp_using_directive_placement"));
        Assert.False(settings.EditorConfigKeys.ContainsKey("removeEndOfLineWhitespace"));
    }

    [Theory]
    [InlineData("")]
    [InlineData(":suggestion")]
    [InlineData(":warning")]
    [InlineData(":error")]
    [InlineData(" : Warning")]
    public void EnforcingSeverity_AppliesTheValue(string suffix)
    {
        _user["inlineOutVariableDeclarations"] = true;
        WriteRootEditorConfig($"csharp_style_inlined_variable_declaration = false{suffix}");

        Assert.False(EffectiveSettings.ForFile(_filePath, _user).GetBool("inlineOutVariableDeclarations"));
    }

    [Theory]
    [InlineData(":none")]
    [InlineData(":silent")]
    [InlineData(":refactoring")]
    [InlineData(" : Silent")]
    public void NonEnforcingSeverity_IgnoresTheValue_SoTheUserSettingDecides(string suffix)
    {
        _user["inlineOutVariableDeclarations"] = true;
        WriteRootEditorConfig($"csharp_style_inlined_variable_declaration = false{suffix}");

        EffectiveSettings settings = EffectiveSettings.ForFile(_filePath, _user);

        Assert.True(settings.GetBool("inlineOutVariableDeclarations"));
        Assert.False(settings.EditorConfigKeys.ContainsKey("inlineOutVariableDeclarations"));
    }

    [Theory]
    [InlineData("csharp_style_expression_bodied_lambdas = false:warning", "simplifySingleStatementLambdas", false, "csharp_style_expression_bodied_lambdas")]
    [InlineData("csharp_style_expression_bodied_lambdas = when_on_single_line:suggestion", "simplifySingleStatementLambdas", true, "csharp_style_expression_bodied_lambdas")]
    [InlineData("dotnet_diagnostic.IDE0053.severity = warning", "simplifySingleStatementLambdas", true, "dotnet_diagnostic.ide0053.severity")]
    [InlineData("csharp_style_prefer_null_check_over_type_check = false:warning", "convertToPatternMatchingNullChecks", false, "csharp_style_prefer_null_check_over_type_check")]
    [InlineData("dotnet_style_prefer_is_null_check_over_reference_equality_method = true:error", "convertToPatternMatchingNullChecks", true, "dotnet_style_prefer_is_null_check_over_reference_equality_method")]
    [InlineData("dotnet_diagnostic.CA1852.severity = warning", "sealClassesWhenSafe", true, "dotnet_diagnostic.ca1852.severity")]
    [InlineData("dotnet_diagnostic.CA1507.severity = suggestion", "convertToStringNameOf", true, "dotnet_diagnostic.ca1507.severity")]
    [InlineData("dotnet_diagnostic.CA1869.severity = error", "reuseJsonSerializerOptionsForCA1869", true, "dotnet_diagnostic.ca1869.severity")]
    [InlineData("dotnet_style_allow_multiple_blank_lines_experimental = false:warning", "removeMultipleConsecutiveBlankLines", true, "dotnet_style_allow_multiple_blank_lines_experimental")]
    [InlineData("dotnet_style_allow_multiple_blank_lines_experimental = true:warning", "removeMultipleConsecutiveBlankLines", false, "dotnet_style_allow_multiple_blank_lines_experimental")]
    [InlineData("dotnet_diagnostic.IDE2000.severity = warning", "removeMultipleConsecutiveBlankLines", false, "dotnet_diagnostic.ide2000.severity")]
    [InlineData("csharp_style_allow_blank_lines_between_consecutive_braces_experimental = false:warning", "removeBlankLinesAfterOpeningBrace", true, "csharp_style_allow_blank_lines_between_consecutive_braces_experimental")]
    [InlineData("csharp_style_allow_blank_lines_between_consecutive_braces_experimental = false:warning", "removeBlankLinesBeforeClosingBrace", true, "csharp_style_allow_blank_lines_between_consecutive_braces_experimental")]
    [InlineData("csharp_style_allow_blank_lines_between_consecutive_braces_experimental = true:error", "removeBlankLinesBeforeClosingBrace", false, "csharp_style_allow_blank_lines_between_consecutive_braces_experimental")]
    [InlineData("dotnet_diagnostic.IDE0005.severity = warning", "organizeUsings", true, "dotnet_diagnostic.ide0005.severity")]
    public void LinkedOption_EnforcedByEditorConfig_BeatsPolicyAndUserSetting(string option, string settingName, bool expected, string expectedKey)
    {
        SetUser(settingName, !expected);
        WritePolicy($"\"{settingName}\": {(expected ? "false" : "true")}");
        WriteRootEditorConfig(option);

        EffectiveSettings settings = EffectiveSettings.ForFile(_filePath, _user);

        Assert.Equal(expected, settings.GetBool(settingName));
        Assert.Equal(expectedKey, settings.EditorConfigKeys[settingName]);
    }

    [Theory]
    [InlineData("dotnet_diagnostic.CA1852.severity = silent")]
    [InlineData("dotnet_diagnostic.CA1852.severity = none")]
    [InlineData(null)]
    public void LinkedOption_NotEnforcedByEditorConfig_UsesThePolicy(string option)
    {
        _user["sealClassesWhenSafe"] = false;
        WritePolicy("\"sealClassesWhenSafe\": true");
        WriteRootEditorConfig(option);

        EffectiveSettings settings = EffectiveSettings.ForFile(_filePath, _user);

        Assert.True(settings.GetBool("sealClassesWhenSafe"));
        Assert.False(settings.EditorConfigKeys.ContainsKey("sealClassesWhenSafe"));
    }

    [Fact]
    public void LinkedOption_DiagnosticSeverityNone_BeatsTheOptionSuffix()
    {
        _user["simplifySingleStatementLambdas"] = true;
        WriteRootEditorConfig("csharp_style_expression_bodied_lambdas = false:warning", "dotnet_diagnostic.IDE0053.severity = none");

        Assert.True(EffectiveSettings.ForFile(_filePath, _user).GetBool("simplifySingleStatementLambdas"));
    }

    [Fact]
    public void LinkedOption_TwoKeysEnforced_ConvertsNullChecksOnlyWhenBothAllowIt()
    {
        _user["convertToPatternMatchingNullChecks"] = true;
        WriteRootEditorConfig(
            "csharp_style_prefer_null_check_over_type_check = true:warning",
            "dotnet_style_prefer_is_null_check_over_reference_equality_method = false:warning");

        EffectiveSettings settings = EffectiveSettings.ForFile(_filePath, _user);

        Assert.False(settings.GetBool("convertToPatternMatchingNullChecks"));
        Assert.Equal("dotnet_style_prefer_is_null_check_over_reference_equality_method", settings.EditorConfigKeys["convertToPatternMatchingNullChecks"]);
    }

    [Theory]
    [InlineData(null, true)]
    [InlineData("csharp_prefer_braces = false:none", true)]
    [InlineData("csharp_prefer_braces = false:silent", true)]
    [InlineData("csharp_prefer_braces = false:suggestion", false)]
    [InlineData("csharp_prefer_braces = false:warning", false)]
    [InlineData("csharp_prefer_braces = false:error", false)]
    [InlineData("csharp_prefer_braces = false", false)]
    [InlineData("dotnet_diagnostic.IDE0011.severity = warning", false)]
    [InlineData("dotnet_diagnostic.IDE0011.severity = silent", true)]
    public void CodeStyleRule_AppliesOnlyWhenEditorConfigDoesNotEnforceIt(string option, bool applied)
    {
        SetCodeStyleRules("csharp_prefer_braces=when_multiline");
        WriteRootEditorConfig(option);

        EffectiveSettings settings = EffectiveSettings.ForFile(_filePath, _user);

        Assert.Equal(applied, settings.CodeStyleValues.ContainsKey("csharp_prefer_braces"));
        Assert.Equal(!applied, settings.CodeStyleEditorConfigKeys.ContainsKey("csharp_prefer_braces"));
        Assert.Equal(applied ? "when_multiline:suggestion" : null, settings.AnalyzerConfigOverrides.TryGetValue("csharp_prefer_braces", out string value) ? value : null);
    }

    [Fact]
    public void CodeStyleRule_DiagnosticSeverityNone_BeatsAnEnforcingOptionSuffix()
    {
        SetCodeStyleRules("csharp_prefer_braces=true");
        WriteRootEditorConfig("csharp_prefer_braces = false:warning", "dotnet_diagnostic.IDE0011.severity = none");

        EffectiveSettings settings = EffectiveSettings.ForFile(_filePath, _user);

        Assert.Equal("true", settings.CodeStyleValues["csharp_prefer_braces"]);
        Assert.Equal("suggestion", settings.AnalyzerConfigOverrides["dotnet_diagnostic.IDE0011.severity"]);
    }

    [Fact]
    public void CodeStyleRule_EnforcedThroughTheDiagnosticSeverity_NamesTheSeverityKey()
    {
        SetCodeStyleRules("csharp_prefer_braces=true");
        WriteRootEditorConfig("dotnet_diagnostic.IDE0011.severity = error");

        Assert.Equal("dotnet_diagnostic.ide0011.severity", EffectiveSettings.ForFile(_filePath, _user).CodeStyleEditorConfigKeys["csharp_prefer_braces"]);
    }

    [Fact]
    public void CodeStyleRule_DiagnosticSeverityNoneOnOneId_TheOtherIdFollowsTheOptionSuffix()
    {
        SetCodeStyleRules("dotnet_style_qualification_for_field=true");
        WriteRootEditorConfig("dotnet_style_qualification_for_field = false:warning", "dotnet_diagnostic.IDE0009.severity = none");

        EffectiveSettings settings = EffectiveSettings.ForFile(_filePath, _user);

        Assert.Equal("dotnet_style_qualification_for_field", settings.CodeStyleEditorConfigKeys["dotnet_style_qualification_for_field"]);
        Assert.False(settings.CodeStyleValues.ContainsKey("dotnet_style_qualification_for_field"));
    }

    [Fact]
    public void NamespaceDeclarations_DiagnosticSeverityEnforcesASilentOption()
    {
        _user["convertToFileScopedNamespace"] = false;
        WriteRootEditorConfig("csharp_style_namespace_declarations = file_scoped:silent", "dotnet_diagnostic.IDE0161.severity = warning");

        EffectiveSettings settings = EffectiveSettings.ForFile(_filePath, _user);

        Assert.Null(GetOverride(settings, "csharp_style_namespace_declarations"));
        Assert.True(settings.GetBool("convertToFileScopedNamespace"));
        Assert.Equal("csharp_style_namespace_declarations", settings.EditorConfigKeys["convertToFileScopedNamespace"]);
    }

    [Theory]
    [InlineData("dotnet_analyzer_diagnostic.category-Style.severity = warning", "dotnet_analyzer_diagnostic.category-style.severity")]
    [InlineData("dotnet_analyzer_diagnostic.severity = suggestion", "dotnet_analyzer_diagnostic.severity")]
    public void BulkSeverity_EnforcesCodeStyleRulesAndIdeSteps_WithRoslynDefaults(string option, string expectedKey)
    {
        SetCodeStyleRules("csharp_prefer_braces=when_multiline");
        _user["organizeUsings"] = false;
        _user["makeFieldsReadonlyWhenSafe"] = false;
        _user["convertToFileScopedNamespace"] = true;
        WriteRootEditorConfig(option);

        EffectiveSettings settings = EffectiveSettings.ForFile(_filePath, _user);

        Assert.Equal(expectedKey, settings.CodeStyleEditorConfigKeys["csharp_prefer_braces"]);
        Assert.Empty(settings.CodeStyleValues);
        Assert.Empty(settings.AnalyzerConfigOverrides);
        Assert.True(settings.GetBool("organizeUsings"));
        Assert.Equal(expectedKey, settings.EditorConfigKeys["organizeUsings"]);
        Assert.True(settings.GetBool("makeFieldsReadonlyWhenSafe"), "Roslyn default of dotnet_style_readonly_field");
        Assert.Equal(expectedKey, settings.EditorConfigKeys["convertToFileScopedNamespace"]);
        Assert.False(settings.GetBool("convertToFileScopedNamespace"));
    }

    [Fact]
    public void CategorySeverity_OnlyAppliesToEnabledByDefaultDiagnosticsOfThatCategory()
    {
        _user["sealClassesWhenSafe"] = false;
        _user["reuseJsonSerializerOptionsForCA1869"] = false;
        _user["convertToStringNameOf"] = false;
        WriteRootEditorConfig("dotnet_analyzer_diagnostic.category-Performance.severity = warning");

        EffectiveSettings settings = EffectiveSettings.ForFile(_filePath, _user);

        Assert.True(settings.GetBool("reuseJsonSerializerOptionsForCA1869"), "CA1869 is an enabled Performance rule");
        Assert.False(settings.GetBool("sealClassesWhenSafe"), "CA1852 is disabled by default, so bulk severities do not enable it");
        Assert.False(settings.EditorConfigKeys.ContainsKey("sealClassesWhenSafe"));
        Assert.False(settings.GetBool("convertToStringNameOf"), "CA1507 is a Maintainability rule");
        Assert.False(settings.CodeStyleEditorConfigKeys.ContainsKey("csharp_prefer_braces"));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("csharp_prefer_braces = false:warning")]
    [InlineData("csharp_prefer_braces = false")]
    public void CategorySeverityNone_DoesNotEnforce_SoTheUserSettingDecides(string option)
    {
        SetCodeStyleRules("csharp_prefer_braces=true");
        _user["organizeUsings"] = false;
        WriteRootEditorConfig("dotnet_analyzer_diagnostic.category-Style.severity = none", option);

        EffectiveSettings settings = EffectiveSettings.ForFile(_filePath, _user);

        Assert.Equal("true", settings.CodeStyleValues["csharp_prefer_braces"]);
        Assert.False(settings.CodeStyleEditorConfigKeys.ContainsKey("csharp_prefer_braces"));
        Assert.False(settings.GetBool("organizeUsings"));
        Assert.False(settings.EditorConfigKeys.ContainsKey("organizeUsings"));
    }

    [Theory]
    [InlineData("dotnet_diagnostic.IDE0011.severity = warning")]
    [InlineData("dotnet_analyzer_diagnostic.category-Style.severity = warning")]
    public void NoneSuffix_StopsTheRule_WhateverSeverityIsConfigured(string severity)
    {
        SetCodeStyleRules("csharp_prefer_braces=when_multiline");
        WriteRootEditorConfig("csharp_prefer_braces = true:none", severity);

        Assert.Equal("when_multiline", EffectiveSettings.ForFile(_filePath, _user).CodeStyleValues["csharp_prefer_braces"]);
    }

    [Theory]
    [InlineData("csharp_style_var_when_type_is_apparent = true:silent", "dotnet_diagnostic.IDE0007.severity = warning", "convertToVarWhenApparent", true, "csharp_style_var_when_type_is_apparent")]
    [InlineData(null, "dotnet_diagnostic.IDE0008.severity = warning", "convertToVarWhenApparent", false, "dotnet_diagnostic.ide0008.severity")]
    [InlineData("csharp_style_inlined_variable_declaration = false:warning", "dotnet_diagnostic.IDE0018.severity = none", "inlineOutVariableDeclarations", true, null)]
    [InlineData(null, "dotnet_diagnostic.IDE0018.severity = warning", "inlineOutVariableDeclarations", true, "dotnet_diagnostic.ide0018.severity")]
    [InlineData(null, "dotnet_diagnostic.IDE0044.severity = error", "makeFieldsReadonlyWhenSafe", true, "dotnet_diagnostic.ide0044.severity")]
    [InlineData("dotnet_style_readonly_field = true:warning", "dotnet_diagnostic.IDE0044.severity = silent", "makeFieldsReadonlyWhenSafe", false, null)]
    [InlineData(null, "dotnet_diagnostic.IDE0040.severity = warning", ExplicitAccessModifiersSetting, true, "dotnet_diagnostic.ide0040.severity")]
    [InlineData("dotnet_style_prefer_collection_expression = never:silent", "dotnet_diagnostic.IDE0305.severity = warning", "convertToCollectionExpressions", false, "dotnet_style_prefer_collection_expression")]
    [InlineData(null, "dotnet_diagnostic.IDE0300.severity = suggestion", "convertToCollectionExpressions", true, "dotnet_diagnostic.ide0300.severity")]
    public void LegacyOption_ResolvedPerDiagnostic(string option, string severity, string settingName, bool expected, string expectedKey)
    {
        // A locked setting must beat the opposite user setting; an unlocked one must keep the user setting.
        SetUser(settingName, expectedKey is null ? expected : !expected);
        WriteRootEditorConfig(option, severity);

        EffectiveSettings settings = EffectiveSettings.ForFile(_filePath, _user);

        Assert.Equal(expected, settings.GetBool(settingName));
        Assert.Equal(expectedKey, settings.EditorConfigKeys.TryGetValue(settingName, out string key) ? key : null);
    }

    [Theory]
    [InlineData("csharp_using_directive_placement = inside_namespace:warning", "dotnet_diagnostic.IDE0065.severity = none", false, "outside_namespace:suggestion")]
    [InlineData("csharp_using_directive_placement = inside_namespace:silent", "dotnet_diagnostic.IDE0065.severity = warning", true, null)]
    [InlineData(null, "dotnet_diagnostic.IDE0065.severity = warning", true, null)]
    public void UsingDirectivePlacement_ResolvedWithTheDiagnosticSeverity(string option, string severity, bool locked, string expectedOverride)
    {
        _user["moveUsingsOutsideNamespace"] = true;
        WriteRootEditorConfig(option, severity);

        EffectiveSettings settings = EffectiveSettings.ForFile(_filePath, _user);

        Assert.Equal(expectedOverride, GetOverride(settings, "csharp_using_directive_placement"));
        Assert.Equal(locked, settings.EditorConfigKeys.ContainsKey("moveUsingsOutsideNamespace"));
    }

    [Fact]
    public void CodeStyleRule_Policy_BeatsUserSetting_AndNullDisablesTheRule()
    {
        SetCodeStyleRules("csharp_prefer_braces=true;dotnet_style_null_propagation=true;csharp_prefer_simple_using_statement=true");
        WritePolicy("\"codeStyle\": { \"csharp_prefer_braces\": \"when_multiline\", \"dotnet_style_null_propagation\": null, \"csharp_style_throw_expression\": \"false\" }");

        EffectiveSettings settings = EffectiveSettings.ForFile(_filePath, _user);

        Assert.Equivalent(new Dictionary<string, string>
        {
            ["csharp_prefer_braces"] = "when_multiline",
            ["csharp_style_throw_expression"] = "false",
            ["csharp_prefer_simple_using_statement"] = "true",
        }, settings.CodeStyleValues.ToDictionary(entry => entry.Key, entry => entry.Value), strict: true);
    }

    [Fact]
    public void AnalyzerConfigOverrides_SilenceOtherRulesOfTheSameDiagnostic_ThatCodeJanitorDoesNotApply()
    {
        SetCodeStyleRules("dotnet_style_qualification_for_field=true");
        _user["inlineOutVariableDeclarations"] = false;
        SetExplicitAccessModifiers(false);
        _user["moveUsingsOutsideNamespace"] = false;
        _user["removeMultipleConsecutiveBlankLines"] = false;
        WriteRootEditorConfig("dotnet_style_qualification_for_method = true:silent", "dotnet_style_qualification_for_event = false:warning");

        EffectiveSettings settings = EffectiveSettings.ForFile(_filePath, _user);

        Assert.Equivalent(new Dictionary<string, string>
        {
            ["dotnet_style_qualification_for_field"] = "true:suggestion",
            ["dotnet_diagnostic.IDE0003.severity"] = "suggestion",
            ["dotnet_diagnostic.IDE0009.severity"] = "suggestion",
            ["dotnet_style_qualification_for_property"] = "false:none",
            ["dotnet_style_qualification_for_method"] = "true:none",
        }, settings.AnalyzerConfigOverrides.ToDictionary(entry => entry.Key, entry => entry.Value), strict: true);
    }

    [Fact]
    public void CodeStyleRule_InvalidValues_AreIgnored()
    {
        SetCodeStyleRules("csharp_prefer_braces=sometimes;unknown_key=true;csharp_preferred_modifier_order=public,loud");
        WritePolicy("\"codeStyle\": { \"dotnet_style_null_propagation\": true }");

        Assert.Empty(EffectiveSettings.ForFile(_filePath, _user).CodeStyleValues);
    }

    [Theory]
    [InlineData("sometimes")]
    [InlineData("block_scoped:loud")]
    [InlineData("block_scoped:none:warning")]
    public void UnknownOptionValue_IsIgnored_AndFallsBackToRepositoryPolicy(string option)
    {
        _user["convertToFileScopedNamespace"] = false;
        WritePolicy("\"convertToFileScopedNamespace\": true");
        WriteRootEditorConfig($"csharp_style_namespace_declarations = {option}");

        EffectiveSettings settings = EffectiveSettings.ForFile(_filePath, _user);

        Assert.Equal("file_scoped:suggestion", GetOverride(settings, "csharp_style_namespace_declarations"));
        Assert.True(settings.GetBool("convertToFileScopedNamespace"));
    }

    [Fact]
    public void UnknownBooleanValue_IsIgnored_AndFallsBackToUserSetting()
    {
        _user["convertToVarWhenApparent"] = true;
        WriteRootEditorConfig("csharp_style_var_when_type_is_apparent = maybe:warning");

        Assert.True(EffectiveSettings.ForFile(_filePath, _user).GetBool("convertToVarWhenApparent"));
    }

    [Theory]
    [InlineData("dotnet_style_prefer_collection_expression = sometimes:warning", "convertToCollectionExpressions")]
    [InlineData("dotnet_style_require_accessibility_modifiers = whenever:warning", ExplicitAccessModifiersSetting)]
    [InlineData("csharp_style_expression_bodied_lambdas = when_possible:warning", "simplifySingleStatementLambdas")]
    [InlineData("dotnet_style_allow_multiple_blank_lines_experimental = maybe:warning", "removeMultipleConsecutiveBlankLines")]
    [InlineData("csharp_style_allow_blank_lines_between_consecutive_braces_experimental = 1:warning", "removeBlankLinesAfterOpeningBrace")]
    [InlineData("trim_trailing_whitespace = yes", "removeEndOfLineWhitespace")]
    public void UnknownValueOfAMappedOption_IsIgnored_SoThePolicyDecides(string option, string settingName)
    {
        SetUser(settingName, false);
        WritePolicy($"\"{settingName}\": true");
        WriteRootEditorConfig(option);

        EffectiveSettings settings = EffectiveSettings.ForFile(_filePath, _user);

        Assert.True(settings.GetBool(settingName));
        Assert.False(settings.EditorConfigKeys.ContainsKey(settingName));
    }

    [Theory]
    [InlineData("dotnet_style_allow_multiple_blank_lines_experimental = false:warning", "removeMultipleConsecutiveBlankLines", true)]
    [InlineData("dotnet_style_allow_multiple_blank_lines_experimental = true:warning", "removeMultipleConsecutiveBlankLines", false)]
    [InlineData("csharp_style_allow_blank_lines_between_consecutive_braces_experimental = false:error", "removeBlankLinesBeforeClosingBrace", true)]
    [InlineData("csharp_style_expression_bodied_lambdas = when_on_single_line:warning", "simplifySingleStatementLambdas", true)]
    [InlineData("csharp_style_expression_bodied_lambdas = false:warning", "simplifySingleStatementLambdas", false)]
    [InlineData("dotnet_style_prefer_collection_expression = When_Types_Loosely_Match:warning", "convertToCollectionExpressions", true)]
    [InlineData("dotnet_style_prefer_collection_expression = NEVER:warning", "convertToCollectionExpressions", false)]
    public void EnforcedOption_MapsItsValue_IgnoringCase(string option, string settingName, bool expected)
    {
        SetUser(settingName, !expected);
        WriteRootEditorConfig(option);

        EffectiveSettings settings = EffectiveSettings.ForFile(_filePath, _user);

        Assert.Equal(expected, settings.GetBool(settingName));
        Assert.Equal(option.Substring(0, option.IndexOf(' ')), settings.EditorConfigKeys[settingName]);
    }

    [Theory]
    [InlineData("inside_namespace", false)]
    [InlineData("Outside_Namespace", true)]
    public void UsingDirectivePlacement_ValidValueWinsOverTheDisabledUserSetting(string value, bool moveOutside)
    {
        _user["moveUsingsOutsideNamespace"] = false;
        WriteRootEditorConfig($"csharp_using_directive_placement = {value}");

        EffectiveSettings settings = EffectiveSettings.ForFile(_filePath, _user);

        Assert.Equal(moveOutside, settings.GetBool("moveUsingsOutsideNamespace"));
        Assert.Equal("csharp_using_directive_placement", settings.EditorConfigKeys["moveUsingsOutsideNamespace"]);
    }

    [Theory]
    [InlineData("anywhere")]
    [InlineData("inside_namespace:loud")]
    public void UsingDirectivePlacement_UnknownValueFallsBackToTheDisabledUserSetting(string value)
    {
        _user["moveUsingsOutsideNamespace"] = false;
        WriteRootEditorConfig($"csharp_using_directive_placement = {value}");

        EffectiveSettings settings = EffectiveSettings.ForFile(_filePath, _user);

        Assert.False(settings.GetBool("moveUsingsOutsideNamespace"));
        Assert.False(settings.EditorConfigKeys.ContainsKey("moveUsingsOutsideNamespace"));
    }

    [Theory]
    [InlineData("true:warning", "false:warning", false, "dotnet_style_prefer_is_null_check_over_reference_equality_method")]
    [InlineData("false:warning", "true:warning", false, "csharp_style_prefer_null_check_over_type_check")]
    [InlineData("false:warning", "false:warning", false, "csharp_style_prefer_null_check_over_type_check")]
    [InlineData("true:warning", "true:warning", true, "csharp_style_prefer_null_check_over_type_check")]
    [InlineData("true:silent", "false:warning", false, "dotnet_style_prefer_is_null_check_over_reference_equality_method")]
    [InlineData("true:warning", "false:silent", true, "csharp_style_prefer_null_check_over_type_check")]
    public void NullCheckRules_EveryEnforcedKeyMustAllowTheConversion_AndTheFirstBlockingKeyIsReported(string typeCheck, string referenceEquality, bool expected, string expectedKey)
    {
        _user["convertToPatternMatchingNullChecks"] = !expected;
        WriteRootEditorConfig(
            $"csharp_style_prefer_null_check_over_type_check = {typeCheck}",
            $"dotnet_style_prefer_is_null_check_over_reference_equality_method = {referenceEquality}");

        EffectiveSettings settings = EffectiveSettings.ForFile(_filePath, _user);

        Assert.Equal(expected, settings.GetBool("convertToPatternMatchingNullChecks"));
        Assert.Equal(expectedKey, settings.EditorConfigKeys["convertToPatternMatchingNullChecks"]);
    }

    [Theory]
    [InlineData("file_header_template =")]
    [InlineData("file_header_template =    ")]
    [InlineData("file_header_template = UNSET")]
    public void GetString_EmptyFileHeaderTemplate_ClearsRepositoryAndUserHeader(string option)
    {
        _user["fileHeaderCSharp"] = "// User header";
        WritePolicy("\"fileHeaderCSharp\": \"// Policy header\"");
        WriteRootEditorConfig(option);

        Assert.Equal(string.Empty, EffectiveSettings.ForFile(_filePath, _user).GetString("fileHeaderCSharp"));
    }

    [Fact]
    public void GetString_FileHeaderTemplateContainingAColon_IsUsedVerbatim()
    {
        WriteRootEditorConfig(@"file_header_template = Copyright (c) Contoso: all rights reserved.\n{fileName}");

        Assert.Equal(string.Join("\n", "// Copyright (c) Contoso: all rights reserved.", "// Sample.cs"), EffectiveSettings.ForFile(_filePath, _user).GetString("fileHeaderCSharp"));
    }

    [Theory]
    [InlineData(true, "// Policy header")]
    [InlineData(false, "// User header")]
    public void GetString_WithoutFileHeaderTemplate_PolicyBeatsUserSetting(bool policy, string expected)
    {
        _user["fileHeaderCSharp"] = "// User header";
        WritePolicy(policy ? "\"fileHeaderCSharp\": \"// Policy header\"" : string.Empty);
        WriteRootEditorConfig("indent_size = 4");

        Assert.Equal(expected, EffectiveSettings.ForFile(_filePath, _user).GetString("fileHeaderCSharp"));
    }

    [Theory]
    [InlineData("\"fileHeaderPosition\": \"afterUsings\", \"fileHeaderUpdateMode\": \"replace\"", "afterUsings", "replace")]
    [InlineData("\"fileHeaderPosition\": \"middle\", \"fileHeaderUpdateMode\": 1", "documentStart", "insert")]
    [InlineData("", "documentStart", "insert")]
    public void HeaderEnums_PolicyBeatsUserSetting(string policy, string expectedPosition, string expectedMode)
    {
        _user["fileHeaderPosition"] = "documentStart";
        _user["fileHeaderUpdateMode"] = "insert";
        WritePolicy(policy);

        EffectiveSettings settings = EffectiveSettings.ForFile(_filePath, _user);

        Assert.Equal(expectedPosition, settings.GetString("fileHeaderPosition"));
        Assert.Equal(expectedMode, settings.GetString("fileHeaderUpdateMode"));
    }

    [Fact]
    public void MalformedPolicy_IsIgnored_SoEditorConfigThenUserSettingsDecide()
    {
        _user["convertToVarWhenApparent"] = true;
        _user["convertToFileScopedNamespace"] = true;
        File.WriteAllText(Path.Combine(_tempDirectory, ".codejanitor"), "{ \"cleanup\": { \"convertToVarWhenApparent\": false, \"removeRegions\": false ");
        WriteRootEditorConfig("csharp_style_namespace_declarations = block_scoped:warning");

        EffectiveSettings settings = EffectiveSettings.ForFile(_filePath, _user);

        Assert.True(settings.GetBool("convertToVarWhenApparent"));
        Assert.False(settings.GetBool("convertToFileScopedNamespace"));
        Assert.Equal("csharp_style_namespace_declarations", settings.EditorConfigKeys["convertToFileScopedNamespace"]);
        Assert.True(settings.GetBool("removeRegions"));
    }

    [Fact]
    public void EditorConfigInAnotherSection_DoesNotBeatThePolicy()
    {
        _user["convertToVarWhenApparent"] = false;
        WritePolicy("\"convertToVarWhenApparent\": true");
        File.WriteAllText(Path.Combine(_tempDirectory, ".editorconfig"), string.Join("\n",
            "root = true",
            "[*.{vb,fs}]",
            "csharp_style_var_when_type_is_apparent = false:error",
            "[{Program,Startup}.cs]",
            "csharp_style_var_when_type_is_apparent = false:error",
            string.Empty));

        Assert.True(EffectiveSettings.ForFile(_filePath, _user).GetBool("convertToVarWhenApparent"));
        Assert.False(EffectiveSettings.ForFile(Path.Combine(_tempDirectory, "Program.cs"), _user).GetBool("convertToVarWhenApparent"));
    }

    [Fact]
    public void NestedEditorConfig_OverridesParentKey_AndInheritsTheOthers()
    {
        WriteRootEditorConfig(
            "trim_trailing_whitespace = true",
            "csharp_style_var_when_type_is_apparent = true");
        DirectoryInfo nested = Directory.CreateDirectory(Path.Combine(_tempDirectory, "src", "App"));
        File.WriteAllText(Path.Combine(_tempDirectory, "src", ".editorconfig"), "[*.cs]\r\ntrim_trailing_whitespace = false\r\n");

        EffectiveSettings settings = EffectiveSettings.ForFile(Path.Combine(nested.FullName, "Sample.cs"), _user);

        Assert.False(settings.GetBool("removeEndOfLineWhitespace"));
        Assert.True(settings.GetBool("convertToVarWhenApparent"));
    }

    [Fact]
    public void RootEditorConfig_HidesEditorConfigsAboveIt()
    {
        _user["convertToVarWhenApparent"] = false;
        WriteRootEditorConfig("csharp_style_var_when_type_is_apparent = true");
        DirectoryInfo nested = Directory.CreateDirectory(Path.Combine(_tempDirectory, "src"));
        File.WriteAllText(Path.Combine(nested.FullName, ".editorconfig"), "root = true\r\n\r\n[*.cs]\r\ntrim_trailing_whitespace = false\r\n");

        EffectiveSettings settings = EffectiveSettings.ForFile(Path.Combine(nested.FullName, "Sample.cs"), _user);

        Assert.False(settings.GetBool("convertToVarWhenApparent"), "The parent .editorconfig must not apply below a root .editorconfig.");
        Assert.False(settings.GetBool("removeEndOfLineWhitespace"));
    }

    [Fact]
    public void SectionGlobs_MatchPathsRelativeToTheEditorConfigDirectory()
    {
        // Pin the user fallbacks so only .editorconfig sections can make these settings true.
        _user["convertToVarWhenApparent"] = false;
        _user["makeFieldsReadonlyWhenSafe"] = false;
        File.WriteAllText(Path.Combine(_tempDirectory, ".editorconfig"), string.Join("\r\n",
            "root = true",
            "[*.cs]",
            "trim_trailing_whitespace = false",
            "[src/**.cs]",
            "csharp_style_var_when_type_is_apparent = true",
            "[*.vb]",
            "dotnet_style_readonly_field = true",
            string.Empty));
        DirectoryInfo source = Directory.CreateDirectory(Path.Combine(_tempDirectory, "src", "App"));
        DirectoryInfo tests = Directory.CreateDirectory(Path.Combine(_tempDirectory, "tests"));

        EffectiveSettings inSource = EffectiveSettings.ForFile(Path.Combine(source.FullName, "Sample.cs"), _user);
        EffectiveSettings inTests = EffectiveSettings.ForFile(Path.Combine(tests.FullName, "Sample.cs"), _user);

        Assert.False(inSource.GetBool("removeEndOfLineWhitespace"));
        Assert.True(inSource.GetBool("convertToVarWhenApparent"));
        Assert.False(inSource.GetBool("makeFieldsReadonlyWhenSafe"), "A [*.vb] section must not apply to C# files.");
        Assert.False(inTests.GetBool("removeEndOfLineWhitespace"));
        Assert.False(inTests.GetBool("convertToVarWhenApparent"), "[src/**.cs] must not match files outside src.");
    }

    [Fact]
    public void For_EditedEditorConfig_IsReadAgain()
    {
        WriteRootEditorConfig("csharp_style_var_when_type_is_apparent = true");
        Assert.True(EffectiveSettings.ForFile(_filePath, _user).GetBool("convertToVarWhenApparent"));

        WriteRootEditorConfig("csharp_style_var_when_type_is_apparent = false:warning");

        Assert.False(EffectiveSettings.ForFile(_filePath, _user).GetBool("convertToVarWhenApparent"));
    }

    /// <summary>
    /// Writes the root .editorconfig of the test directory with the given options in a [*.cs] section; null options are skipped.
    /// </summary>
    private void WriteRootEditorConfig(params string[] csharpOptions)
    {
        IEnumerable<string> lines = new[] { "root = true", string.Empty, "[*.cs]" }
            .Concat(csharpOptions.Where(option => option is not null))
            .Concat(new[] { string.Empty });

        File.WriteAllText(Path.Combine(_tempDirectory, ".editorconfig"), string.Join("\r\n", lines));
    }

    /// <summary>
    /// Writes the repository policy of the test directory with the given cleanup entries.
    /// </summary>
    private void WritePolicy(string cleanupEntries) => File.WriteAllText(Path.Combine(_tempDirectory, ".codejanitor"), "{ \"cleanup\": { " + cleanupEntries + " } }");

    private static string GetOverride(EffectiveSettings settings, string key)
        => settings.AnalyzerConfigOverrides.TryGetValue(key, out string value) ? value : null;

    /// <summary>Sets the user's Code Style rules from the Visual Studio setting format (<c>key=value;key=value</c>).</summary>
    private void SetCodeStyleRules(string setting)
    {
        JsonObject rules = new JsonObject();
        foreach (string entry in (setting ?? string.Empty).Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            int separator = entry.IndexOf('=');
            if (separator > 0)
            {
                rules[entry[..separator].Trim()] = entry[(separator + 1)..].Trim();
            }
        }

        _user["codeStyleRules"] = rules;
    }

    /// <summary>Sets a user setting; the explicit access modifier setting stands for every per-kind setting.</summary>
    private void SetUser(string settingName, bool value)
    {
        if (settingName == ExplicitAccessModifiersSetting)
        {
            SetExplicitAccessModifiers(value);
        }
        else
        {
            _user[settingName] = value;
        }
    }

    /// <summary>Sets every per-kind <c>insertExplicitAccessModifiersOn*</c> setting (the one Visual Studio checkbox).</summary>
    private void SetExplicitAccessModifiers(bool value)
    {
        foreach (string key in new[] { "Classes", "Delegates", "Enumerations", "Events", "Fields", "Interfaces", "Methods", "Properties", "Structs" })
        {
            _user["insertExplicitAccessModifiersOn" + key] = value;
        }
    }
}
