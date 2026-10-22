#nullable disable

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Text.Json.Nodes;
using CodeJanitor.Engine.Settings;
using CodeJanitor.Engine.CodeStyle;
using CodeJanitor.Engine.Diagnostics;
using CodeJanitor.Engine.Tests.Diagnostics;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace CodeJanitor.Engine.Tests.CodeStyle;

/// <summary>
/// End-to-end tests of the Code Janitor code-style rules: the rules resolved for a file by
/// <see cref="EffectiveSettings" /> (.editorconfig, then .codejanitor, then the user setting) are applied by
/// <see cref="DiagnosticCleanupEngine" /> through the built-in Roslyn analyzers and code fixes, the way Visual Studio
/// cleans a file. One rule of every group is covered, as is every cleanup step applied through a Roslyn rule. The
/// expected behavior of those steps comes from the Microsoft Learn page of the rule:
/// <list type="bullet">
/// <item>IDE0007: https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0007-ide0008</item>
/// <item>IDE0018: https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0018</item>
/// <item>IDE0040: https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0040</item>
/// <item>IDE0044: https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0044</item>
/// <item>IDE0053: https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0053</item>
/// <item>IDE0065: https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0065</item>
/// <item>IDE0130: https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0130</item>
/// <item>IDE0161: https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0160-ide0161</item>
/// <item>IDE0300: https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide0300</item>
/// <item>IDE2000: https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide2000</item>
/// </list>
/// </summary>
public sealed class CodeStyleCleanupTests : IDisposable
{
    private static readonly string[] RoslynStepSettings =
    {
        "convertToCollectionExpressions",
        "convertToFileScopedNamespace",
        "convertToVarWhenApparent",
        "inlineOutVariableDeclarations",
        "insertExplicitAccessModifiersOnClasses",
        "makeFieldsReadonlyWhenSafe",
        "moveUsingsOutsideNamespace",
        "removeMultipleConsecutiveBlankLines",
        "simplifySingleStatementLambdas",
    };

    private readonly string _directoryName;
    private readonly string _directory;
    private JsonObject _user;

    public CodeStyleCleanupTests()
    {
        _user = CleanupSettingsDefaults.Create();

        // Every test enables only the Roslyn cleanup steps it covers.
        foreach (string settingName in RoslynStepSettings)
        {
            SetUser(settingName, false);
        }

        _directoryName = Guid.NewGuid().ToString("N");
        _directory = DiagnosticCleanupTestWorkspace.GetPath(_directoryName);
        Directory.CreateDirectory(_directory);
        File.WriteAllText(Path.Combine(_directory, ".codejanitor"), "{ \"cleanup\": { } }");
    }

    public void Dispose()
    {
        _user = CleanupSettingsDefaults.Create();
        Directory.Delete(_directory, true);
    }

    [Theory]
    [InlineData("csharp_preferred_modifier_order=public,private,protected,internal,static,readonly", "class Probe\n{\n    static public int Get() { return 1; }\n}\n", "public static int Get()")]
    [InlineData("csharp_prefer_braces=true", "class Probe\n{\n    int Get(bool open)\n    {\n        if (open)\n            return 1;\n        return 0;\n    }\n}\n", "if (open)\n        {\n            return 1;\n        }")]
    [InlineData("csharp_style_expression_bodied_methods=true", "class Probe\n{\n    int Get()\n    {\n        return 1;\n    }\n}\n", "int Get() => 1;")]
    [InlineData("csharp_style_prefer_not_pattern=true", "class Probe\n{\n    bool Check(object value)\n    {\n        return !(value is string);\n    }\n}\n", "return value is not string;")]
    [InlineData("dotnet_style_coalesce_expression=true", "class Probe\n{\n    string Get(string value)\n    {\n        return value != null ? value : \"\";\n    }\n}\n", "return value ?? \"\";")]
    [InlineData("csharp_style_implicit_object_creation_when_type_is_apparent=true", "class Probe\n{\n    private readonly Probe _other = new Probe();\n}\n", "private readonly Probe _other = new();")]
    [InlineData("dotnet_style_qualification_for_field=true", "class Probe\n{\n    private int count;\n\n    int Size { get; set; }\n\n    int Get()\n    {\n        return count + this.Size;\n    }\n}\n", "return this.count + this.Size;")]
    [InlineData("dotnet_style_predefined_type_for_locals_parameters_members=true", "using System;\n\nclass Probe\n{\n    Int32 Get()\n    {\n        return 1;\n    }\n}\n", "int Get()")]
    [InlineData("dotnet_style_parentheses_in_arithmetic_binary_operators=always_for_clarity", "class Probe\n{\n    int Get(int a, int b, int c)\n    {\n        return a + b * c;\n    }\n}\n", "return a + (b * c);")]
    [InlineData("csharp_prefer_static_anonymous_function=true", "using System;\n\nclass Probe\n{\n    int Use(int x)\n    {\n        Func<int, int> twice = y => y * 2;\n        return twice(x);\n    }\n}\n", "Func<int, int> twice = static y => y * 2;")]
    public async Task UserSettingRule_WithoutEditorConfig_IsAppliedThroughTheRoslynCodeFix(string rule, string input, string expectedFragment)
    {
        SetCodeStyleRules(rule);

        string output = await CleanupAsync(input, editorConfig: null);

        Assert.Contains(expectedFragment, output);
    }

    [Theory]
    [InlineData("csharp_prefer_static_anonymous_function = true:warning", true)]
    [InlineData("csharp_prefer_static_anonymous_function = true:silent", false)]
    [InlineData("csharp_prefer_static_anonymous_function = false:warning", false)]
    public async Task StaticAnonymousFunctions_AreMadeStaticWhenEditorConfigEnforcesTheRule(string editorConfig, bool madeStatic)
    {
        string input = "using System;\n\nclass Probe\n{\n    int Use(int x)\n    {\n        Func<int, int> twice = y => y * 2;\n        return twice(x);\n    }\n}\n";

        Assert.Equal(madeStatic, (await CleanupAsync(input, editorConfig)).Contains("Func<int, int> twice = static y => y * 2;"));
    }

    [Theory]
    [InlineData(null, true)]
    [InlineData("csharp_prefer_braces = false", false)]
    [InlineData("csharp_prefer_braces = false:none", true)]
    [InlineData("csharp_prefer_braces = false:silent", true)]
    [InlineData("csharp_prefer_braces = false:suggestion", false)]
    [InlineData("csharp_prefer_braces = false:warning", false)]
    [InlineData("csharp_prefer_braces = false:error", false)]
    public async Task EditorConfigEnforcingTheRule_WinsOverTheCodeJanitorRule(string editorConfigOption, bool bracesAdded)
    {
        SetCodeStyleRules("csharp_prefer_braces=true");
        string input = "class Probe\n{\n    int Get(bool open)\n    {\n        if (open)\n            return 1;\n        return 0;\n    }\n}\n";

        string output = await CleanupAsync(input, editorConfigOption);

        Assert.Equal(bracesAdded, output.Contains("        {\n            return 1;"));
    }

    [Theory]
    [InlineData("csharp_style_prefer_method_group_conversion=false", null)]
    [InlineData(null, "csharp_style_prefer_method_group_conversion = false:warning")]
    public async Task MethodGroupConversionFalse_KeepsTheLambda(string rule, string editorConfig)
    {
        if (rule is not null)
        {
            SetCodeStyleRules(rule);
        }

        string input = "using System;\n\nclass Probe\n{\n    int Apply(int value)\n    {\n        Func<int, int> convert = v => Double(v);\n        return convert(value);\n    }\n\n    static int Double(int value) => value * 2;\n}\n";

        Assert.Contains("Func<int, int> convert = v => Double(v);", await CleanupAsync(input, editorConfig));
    }

    [Fact]
    public async Task PolicyDisablingTheRule_WinsOverTheUserSetting()
    {
        SetCodeStyleRules("csharp_prefer_braces=true");
        File.WriteAllText(Path.Combine(_directory, ".codejanitor"), "{ \"cleanup\": { \"codeStyle\": { \"csharp_prefer_braces\": null } } }");
        string input = "class Probe\n{\n    int Get(bool open)\n    {\n        if (open)\n            return 1;\n        return 0;\n    }\n}\n";

        Assert.Equal(input, await CleanupAsync(input, editorConfig: null));
    }

    [Fact]
    public void EveryRule_ReportsDiagnosticsOfTheRoslynAnalyzers_AndProposesAValidValue()
    {
        HashSet<string> hostDiagnosticIds = new HashSet<string>(
            DiagnosticCleanupTestWorkspace.HostAnalyzers.SelectMany(analyzer => analyzer.SupportedDiagnostics.Select(descriptor => descriptor.Id)));

        foreach (CodeStyleRule rule in CodeStyleRules.All)
        {
            Assert.True(rule.IsValidValue(rule.DefaultValue), rule.Key);
            foreach (string diagnosticId in rule.DiagnosticIds)
            {
                Assert.Contains(diagnosticId, hostDiagnosticIds);
            }
        }
    }

    [Fact]
    public void Find_FindsOnlyCatalogKeys_Exactly()
    {
        CodeStyleRule rule = CodeStyleRules.Find("csharp_prefer_braces");
        Assert.Equal("csharp_prefer_braces", rule.Key);
        Assert.Equal(new[] { "IDE0011" }, rule.DiagnosticIds.ToArray());

        Assert.Null(CodeStyleRules.Find("CSHARP_PREFER_BRACES"));
        Assert.Null(CodeStyleRules.Find("csharp_style_namespace_declarations"));
    }

    [Fact]
    public void Rule_NullValue_IsInvalid_AndValuesNormalizeIgnoringCase()
    {
        CodeStyleRule enumerated = CodeStyleRules.Find("csharp_prefer_braces");
        CodeStyleRule freeText = CodeStyleRules.Find("csharp_preferred_modifier_order");

        Assert.False(enumerated.IsValidValue(null));
        Assert.False(freeText.IsValidValue(null));
        Assert.Equal("when_multiline", enumerated.Normalize("  WHEN_MULTILINE "));
        Assert.Equal("unknown", enumerated.Normalize(" unknown "));
    }

    [Fact]
    public void Catalog_GroupsAreContiguous_AndDescriptionsAreDistinctWithinAGroup()
    {
        List<string> groupOrder = [];
        foreach (CodeStyleRule rule in CodeStyleRules.All)
        {
            if (groupOrder.Count == 0 || groupOrder[groupOrder.Count - 1] != rule.Group)
            {
                Assert.DoesNotContain(rule.Group, groupOrder);
                groupOrder.Add(rule.Group);
            }
        }

        foreach (IGrouping<string, CodeStyleRule> group in CodeStyleRules.All.GroupBy(rule => rule.Group))
        {
            List<string> descriptions = group.Select(rule => rule.Description).ToList();
            Assert.Distinct(descriptions);
        }

        Assert.Distinct(CodeStyleRules.All.Select(rule => rule.Key).ToList());
    }

    [Fact]
    public async Task Rule_AlreadySatisfied_LeavesTheFileUnchanged()
    {
        SetCodeStyleRules("csharp_prefer_braces=true;csharp_style_expression_bodied_methods=false");
        string input =
            "using System;\n\n" +
            "namespace Demo;\n\n" +
            "/// <summary>Doc with code: if (x) return;</summary>\n" +
            "public sealed record Probe<T>(T Value) where T : class\n" +
            "{\n" +
            "#if DEBUG\n" +
            "    // if (debug) return 1;\n" +
            "#endif\n" +
            "    public int Get(bool open)\n" +
            "    {\n" +
            "        const string Text = @\"if (open) return 1;\";\n" +
            "        if (open)\n" +
            "        {\n" +
            "            return Text.Length;\n" +
            "        }\n\n" +
            "        return 0;\n" +
            "    }\n" +
            "}\n";

        Assert.Equal(input, await CleanupAsync(input, editorConfig: null));
    }

    [Fact]
    public async Task BracesRule_AddsOnlyBraces_InAFileWithCommentsConditionalsAndLiterals()
    {
        SetCodeStyleRules("csharp_prefer_braces=true");
        string input =
            "namespace Demo\n" +
            "{\n" +
            "    internal static class Probe\n" +
            "    {\n" +
            "        /// <summary>Returns 1 when open.</summary>\n" +
            "        internal static int Get(bool open)\n" +
            "        {\n" +
            "            // leading comment\n" +
            "            if (open)\n" +
            "                return \"if (open) return 1;\".Length; // trailing comment\n" +
            "#if DEBUG\n" +
            "            return -1;\n" +
            "#else\n" +
            "            return 0;\n" +
            "#endif\n" +
            "        }\n" +
            "    }\n" +
            "}\n";
        string expected =
            "namespace Demo\n" +
            "{\n" +
            "    internal static class Probe\n" +
            "    {\n" +
            "        /// <summary>Returns 1 when open.</summary>\n" +
            "        internal static int Get(bool open)\n" +
            "        {\n" +
            "            // leading comment\n" +
            "            if (open)\n" +
            "            {\n" +
            "                return \"if (open) return 1;\".Length; // trailing comment\n" +
            "            }\n" +
            "#if DEBUG\n" +
            "            return -1;\n" +
            "#else\n" +
            "            return 0;\n" +
            "#endif\n" +
            "        }\n" +
            "    }\n" +
            "}\n";

        Assert.Equal(expected, await CleanupAsync(input, editorConfig: null));
    }

    [Fact]
    public async Task Rules_InATopLevelStatementsFile_ChangeOnlyTheTargetedStatements()
    {
        SetCodeStyleRules("csharp_prefer_braces=true;csharp_style_expression_bodied_local_functions=true");
        string input =
            "using System;\n\n" +
            "// Entry point\n" +
            "var open = args.Length > 0;\n" +
            "if (open)\n" +
            "    Console.WriteLine(Get());\n\n" +
            "int Get()\n" +
            "{\n" +
            "    return 1;\n" +
            "}\n\n" +
            "record Person(string Name);\n";
        string expected =
            "using System;\n\n" +
            "// Entry point\n" +
            "var open = args.Length > 0;\n" +
            "if (open)\n" +
            "{\n" +
            "    Console.WriteLine(Get());\n" +
            "}\n\n" +
            "int Get() => 1;\n\n" +
            "record Person(string Name);\n";

        Assert.Equal(expected, await CleanupAsync(input, editorConfig: null));
    }

    /// <summary>
    /// Cleans <paramref name="input" /> as <c>Probe.cs</c> in the test directory. The .editorconfig, when given, is
    /// written to disk (read by <see cref="EffectiveSettings" />) and added to the project (read by Roslyn).
    /// </summary>
    [Theory]
    [InlineData("class Probe\n{\n    private int _x;\n\n    Probe()\n    {\n        _x = 1;\n    }\n\n    int Get() => _x;\n}\n", "class Probe\n{\n    private readonly int _x;\n\n    Probe()\n    {\n        _x = 1;\n    }\n\n    int Get() => _x;\n}\n")]
    public async Task MakeFieldsReadonly_IsAppliedThroughTheRoslynCodeFix(string input, string expected)
    {
        _user["makeFieldsReadonlyWhenSafe"] = true;

        Assert.Equal(expected, await CleanupAsync(input, editorConfig: null));
    }

    [Theory]
    [InlineData("static class Ext\n{\n    public static void Inc(ref this int value) => value++;\n}\n\nclass Probe\n{\n    private int _n;\n\n    void M() => _n.Inc();\n}\n")]
    [InlineData("struct Counter\n{\n    int n;\n\n    public int Next => n++;\n}\n\nclass Probe\n{\n    private Counter _c;\n\n    int Get() => _c.Next;\n}\n")]
    [InlineData("class Probe\n{\n    private int _x;\n\n    void Set() => _x = 1;\n\n    int Get() => _x;\n}\n")]
    public async Task MakeFieldsReadonly_LeavesFieldsThatCannotBeReadonlyUnchanged(string input)
    {
        _user["makeFieldsReadonlyWhenSafe"] = true;

        Assert.Equal(input, await CleanupAsync(input, editorConfig: null));
    }

    [Fact]
    public async Task MakeFieldsReadonly_Disabled_LeavesTheFieldUnchanged()
    {
        _user["makeFieldsReadonlyWhenSafe"] = false;
        string input = "class Probe\n{\n    private int _x;\n\n    Probe()\n    {\n        _x = 1;\n    }\n\n    int Get() => _x;\n}\n";

        Assert.Equal(input, await CleanupAsync(input, editorConfig: null));
    }

    [Theory]
    [InlineData("inlineOutVariableDeclarations", "class Probe\n{\n    bool Parse(string text)\n    {\n        int value;\n        return int.TryParse(text, out value);\n    }\n}\n", "class Probe\n{\n    bool Parse(string text)\n    {\n        return int.TryParse(text, out int value);\n    }\n}\n")]
    [InlineData("simplifySingleStatementLambdas", "using System;\n\nclass Probe\n{\n    Func<int, int> Square() => x => { return x * x; };\n}\n", "using System;\n\nclass Probe\n{\n    Func<int, int> Square() => x => x * x;\n}\n")]
    [InlineData("convertToCollectionExpressions", "class Probe\n{\n    int[] Get() { int[] i = new int[] { 1, 2, 3 }; return i; }\n}\n", "class Probe\n{\n    int[] Get() { int[] i = [1, 2, 3]; return i; }\n}\n")]
    [InlineData("convertToVarWhenApparent", "class Customer\n{\n    Customer Create()\n    {\n        Customer obj = new Customer();\n        return obj;\n    }\n}\n", "class Customer\n{\n    Customer Create()\n    {\n        var obj = new Customer();\n        return obj;\n    }\n}\n")]
    [InlineData("insertExplicitAccessModifiersOnClasses", "class MyClass\n{\n    const string thisFieldIsConst = \"constant\";\n}\n", "internal class MyClass\n{\n    private const string thisFieldIsConst = \"constant\";\n}\n")]
    [InlineData("convertToFileScopedNamespace", "using System;\n\nnamespace Convention\n{\n    class C\n    {\n    }\n}\n", "using System;\n\nnamespace Convention;\n\nclass C\n{\n}\n")]
    [InlineData("moveUsingsOutsideNamespace", "namespace Conventions\n{\n    using System;\n\n    class C\n    {\n        Action Get() => null;\n    }\n}\n", "using System;\n\nnamespace Conventions\n{\n    class C\n    {\n        Action Get() => null;\n    }\n}\n")]
    [InlineData("removeMultipleConsecutiveBlankLines", "class Probe\n{\n    void Run(bool done)\n    {\n        if (done)\n        {\n            Run(false);\n        }\n\n\n        return;\n    }\n}\n", "class Probe\n{\n    void Run(bool done)\n    {\n        if (done)\n        {\n            Run(false);\n        }\n\n        return;\n    }\n}\n")]
    public async Task RoslynStep_Enabled_IsAppliedThroughTheRoslynCodeFix(string settingName, string input, string expected)
    {
        SetUser(settingName, true);

        Assert.Equal(expected, await CleanupAsync(input, editorConfig: null));
    }

    [Fact]
    public async Task InlineOutVariable_VariableUsedOutsideTheBlockOfTheCall_IsLeftUnchanged()
    {
        _user["inlineOutVariableDeclarations"] = true;
        string input = "using System.Collections.Generic;\n\nclass Probe\n{\n    private readonly object _gate = new object();\n    private readonly Dictionary<string, string> _entries = new Dictionary<string, string>();\n\n    string Get(string key)\n    {\n        string entry;\n        lock (_gate)\n        {\n            if (!_entries.TryGetValue(key, out entry))\n            {\n                entry = string.Empty;\n            }\n        }\n\n        return entry;\n    }\n}\n";

        Assert.Equal(input, await CleanupAsync(input, editorConfig: null));
    }

    [Theory]
    [InlineData("convertToCollectionExpressions", "using System.Collections.Generic;\n\nclass Probe\n{\n    IEnumerable<int> Get() { IEnumerable<int> j = new int[] { 1, 2, 3 }; return j; }\n}\n")]
    [InlineData("convertToVarWhenApparent", "class Probe\n{\n    int Get() => 1;\n\n    int Sum()\n    {\n        int x = 5;\n        int y = Get();\n        return x + y;\n    }\n}\n")]
    [InlineData("insertExplicitAccessModifiersOnClasses", "internal interface IProbe\n{\n    void Run();\n}\n")]
    public async Task RoslynStep_Enabled_LeavesTheDocumentedCasesUnchanged(string settingName, string input)
    {
        SetUser(settingName, true);

        Assert.Equal(input, await CleanupAsync(input, editorConfig: null));
    }

    [Theory]
    [InlineData("inlineOutVariableDeclarations", "class Probe\n{\n    bool Parse(string text)\n    {\n        int value;\n        return int.TryParse(text, out value);\n    }\n}\n")]
    [InlineData("simplifySingleStatementLambdas", "using System;\n\nclass Probe\n{\n    Func<int, int> Square() => x => { return x * x; };\n}\n")]
    [InlineData("convertToCollectionExpressions", "class Probe\n{\n    int[] Get() { int[] i = new int[] { 1, 2, 3 }; return i; }\n}\n")]
    [InlineData("convertToVarWhenApparent", "class Customer\n{\n    Customer Create()\n    {\n        Customer obj = new Customer();\n        return obj;\n    }\n}\n")]
    [InlineData("insertExplicitAccessModifiersOnClasses", "class MyClass\n{\n    const string thisFieldIsConst = \"constant\";\n}\n")]
    [InlineData("convertToFileScopedNamespace", "using System;\n\nnamespace Convention\n{\n    class C\n    {\n    }\n}\n")]
    [InlineData("moveUsingsOutsideNamespace", "namespace Conventions\n{\n    using System;\n\n    class C\n    {\n        Action Get() => null;\n    }\n}\n")]
    [InlineData("removeMultipleConsecutiveBlankLines", "class Probe\n{\n    void Run()\n    {\n        Run();\n\n\n        return;\n    }\n}\n")]
    public async Task RoslynStep_Disabled_LeavesTheFileUnchanged(string settingName, string input)
    {
        SetUser(settingName, false);

        Assert.Equal(input, await CleanupAsync(input, editorConfig: null));
    }

    [Theory]
    [InlineData("convertToFileScopedNamespace", LanguageVersion.CSharp9, "using System;\n\nnamespace Convention\n{\n    class C\n    {\n    }\n}\n")]
    [InlineData("convertToCollectionExpressions", LanguageVersion.CSharp11, "class Probe\n{\n    int[] Get() { int[] i = new int[] { 1, 2, 3 }; return i; }\n}\n")]
    public async Task RoslynStep_Enabled_LeavesTheFileUnchanged_WhenTheLanguageVersionLacksTheSyntax(string settingName, LanguageVersion languageVersion, string input)
    {
        SetUser(settingName, true);

        Assert.Equal(input, await CleanupAsync(input, editorConfig: null, languageVersion));
    }

    [Theory]
    [InlineData("convertToFileScopedNamespace", "csharp_style_namespace_declarations = block_scoped:warning", "using System;\n\nnamespace Convention;\n\nclass C\n{\n}\n", "using System;\n\nnamespace Convention\n{\n    class C\n    {\n    }\n}\n")]
    [InlineData("moveUsingsOutsideNamespace", "csharp_using_directive_placement = inside_namespace:warning", "namespace Conventions\n{\n    using System;\n\n    class C\n    {\n        Action Get() => null;\n    }\n}\n", "namespace Conventions\n{\n    using System;\n\n    class C\n    {\n        Action Get() => null;\n    }\n}\n")]
    [InlineData("convertToVarWhenApparent", "csharp_style_var_for_built_in_types = true:silent", "class Probe\n{\n    int Get() => 1;\n\n    int Twice()\n    {\n        int y = Get();\n        return y + y;\n    }\n}\n", "class Probe\n{\n    int Get() => 1;\n\n    int Twice()\n    {\n        int y = Get();\n        return y + y;\n    }\n}\n")]
    [InlineData("convertToVarWhenApparent", "csharp_style_var_elsewhere = true:silent", "class Customer\n{\n    static Customer Create() => new Customer();\n\n    Customer Get()\n    {\n        Customer c = Create();\n        return c;\n    }\n}\n", "class Customer\n{\n    static Customer Create() => new Customer();\n\n    Customer Get()\n    {\n        Customer c = Create();\n        return c;\n    }\n}\n")]
    public async Task RoslynStep_EditorConfig_DecidesOverTheSetting(string settingName, string editorConfig, string input, string expected)
    {
        SetUser(settingName, true);

        Assert.Equal(expected, await CleanupAsync(input, editorConfig));
    }

    [Theory]
    [InlineData("inlineOutVariableDeclarations", "csharp_style_inlined_variable_declaration = true", "class Probe\n{\n    bool Parse(string text)\n    {\n        int value;\n        return int.TryParse(text, out value);\n    }\n}\n", "class Probe\n{\n    bool Parse(string text)\n    {\n        return int.TryParse(text, out int value);\n    }\n}\n")]
    [InlineData("inlineOutVariableDeclarations", "csharp_style_inlined_variable_declaration = true:suggestion", "class Probe\n{\n    bool Parse(string text)\n    {\n        int value;\n        return int.TryParse(text, out value);\n    }\n}\n", "class Probe\n{\n    bool Parse(string text)\n    {\n        return int.TryParse(text, out int value);\n    }\n}\n")]
    [InlineData("insertExplicitAccessModifiersOnClasses", "dotnet_style_require_accessibility_modifiers = for_non_interface_members", "class MyClass\n{\n    const string thisFieldIsConst = \"constant\";\n}\n", "internal class MyClass\n{\n    private const string thisFieldIsConst = \"constant\";\n}\n")]
    [InlineData("simplifySingleStatementLambdas", "csharp_style_expression_bodied_lambdas = true", "using System;\n\nclass Probe\n{\n    Func<int, int> Square() => x => { return x * x; };\n}\n", "using System;\n\nclass Probe\n{\n    Func<int, int> Square() => x => x * x;\n}\n")]
    [InlineData("removeMultipleConsecutiveBlankLines", "dotnet_style_allow_multiple_blank_lines_experimental = false", "class Probe\n{\n    void Run(bool done)\n    {\n        if (done)\n        {\n            Run(false);\n        }\n\n\n        return;\n    }\n}\n", "class Probe\n{\n    void Run(bool done)\n    {\n        if (done)\n        {\n            Run(false);\n        }\n\n        return;\n    }\n}\n")]
    [InlineData("convertToCollectionExpressions", "dotnet_style_prefer_collection_expression = when_types_loosely_match:suggestion", "class Probe\n{\n    int[] Get() { int[] i = new int[] { 1, 2, 3 }; return i; }\n}\n", "class Probe\n{\n    int[] Get() { int[] i = [1, 2, 3]; return i; }\n}\n")]
    [InlineData("makeFieldsReadonlyWhenSafe", "dotnet_style_readonly_field = true", "class Probe\n{\n    private int _x;\n\n    Probe()\n    {\n        _x = 1;\n    }\n\n    int Get() => _x;\n}\n", "class Probe\n{\n    private readonly int _x;\n\n    Probe()\n    {\n        _x = 1;\n    }\n\n    int Get() => _x;\n}\n")]
    [InlineData("moveUsingsOutsideNamespace", "csharp_using_directive_placement = inside_namespace", "using System;\n\nnamespace Conventions\n{\n    class C\n    {\n        Action Get() => null;\n    }\n}\n", "namespace Conventions\n{\n    using System;\n\n    class C\n    {\n        Action Get() => null;\n    }\n}\n")]
    public async Task RoslynStep_EditorConfigEnablingTheRuleWithoutAnEnforcingDiagnosticSeverity_IsApplied(string settingName, string editorConfig, string input, string expected)
    {
        // The user setting is the opposite of what .editorconfig decides, so the result shows that .editorconfig wins.
        SetUser(settingName, settingName == "moveUsingsOutsideNamespace");

        Assert.Equal(expected, await CleanupAsync(input, editorConfig));
    }

    [Theory]
    [InlineData("convertToFileScopedNamespace", true, "csharp_style_namespace_declarations = Block_Scoped", "using System;\n\nnamespace Convention;\n\nclass C\n{\n}\n", "using System;\n\nnamespace Convention\n{\n    class C\n    {\n    }\n}\n")]
    [InlineData("moveUsingsOutsideNamespace", true, "csharp_using_directive_placement = Inside_Namespace", "using System;\n\nnamespace Conventions\n{\n    class C\n    {\n        Action Get() => null;\n    }\n}\n", "namespace Conventions\n{\n    using System;\n\n    class C\n    {\n        Action Get() => null;\n    }\n}\n")]
    [InlineData("convertToCollectionExpressions", false, "dotnet_style_prefer_collection_expression = true\ndotnet_diagnostic.IDE0300.severity = warning", "using System;\n\nclass Probe\n{\n    int[] Get() { int[] i = Array.Empty<int>(); return i; }\n}\n", "using System;\n\nclass Probe\n{\n    int[] Get() { int[] i = []; return i; }\n}\n")]
    [InlineData("convertToVarWhenApparent", true, "csharp_style_var_when_type_is_apparent = true:silent\ncsharp_style_var_for_built_in_types = false:silent\ncsharp_style_var_elsewhere = false:silent\ndotnet_diagnostic.IDE0008.severity = warning", "class Probe\n{\n    int Get() => 1;\n\n    int Sum()\n    {\n        var x = Get();\n        var y = 5;\n        return x + y;\n    }\n}\n", "class Probe\n{\n    int Get() => 1;\n\n    int Sum()\n    {\n        int x = Get();\n        int y = 5;\n        return x + y;\n    }\n}\n")]
    [InlineData("convertToVarWhenApparent", false, "csharp_style_var_when_type_is_apparent = true\ncsharp_style_var_elsewhere = true:silent", "class Customer\n{\n    static Customer Create() => new Customer();\n\n    Customer Get()\n    {\n        Customer created = new Customer();\n        Customer c = Create();\n        return c ?? created;\n    }\n}\n", "class Customer\n{\n    static Customer Create() => new Customer();\n\n    Customer Get()\n    {\n        var created = new Customer();\n        Customer c = Create();\n        return c ?? created;\n    }\n}\n")]
    [InlineData("insertExplicitAccessModifiersOnClasses", true, "dotnet_style_require_accessibility_modifiers = never", "internal class MyClass\n{\n    private const string thisFieldIsConst = \"constant\";\n}\n", "internal class MyClass\n{\n    private const string thisFieldIsConst = \"constant\";\n}\n")]
    public async Task RoslynStep_EditorConfigDecidingTheRule_IsAppliedAsEditorConfigSaysIt(string settingName, bool userSetting, string editorConfig, string input, string expected)
    {
        SetUser(settingName, userSetting);

        Assert.Equal(expected, await CleanupAsync(input, editorConfig));
    }

    [Fact]
    public async Task MoveUsingsOutsideNamespace_NamespaceRelativeDirective_IsQualifiedSoTheFileKeepsCompiling()
    {
        _user["moveUsingsOutsideNamespace"] = true;
        string input = "namespace Company.App\n{\n    using Services;\n\n    public class C\n    {\n        public Svc Service { get; set; }\n    }\n}\n";
        string expected = "using Company.App.Services;\n\nnamespace Company.App\n{\n    public class C\n    {\n        public Svc Service { get; set; }\n    }\n}\n";

        Assert.Equal(expected, await CleanupAsync(input, editorConfig: null, otherDocument: "namespace Company.App.Services { public class Svc { } }\n"));
    }

    [Fact]
    public async Task CodeFix_InAFileWithMixedLineEndings_LeavesTheLineEndingsAsTheFixWroteThem()
    {
        _user["moveUsingsOutsideNamespace"] = true;
        string input = "namespace Conventions\r\n{\n    using System;\n\n    class C\n    {\n        Action Get() => null;\n    }\n}\n";

        string output = await CleanupAsync(input, "end_of_line = unset");

        Assert.Equal("using System;\n\nnamespace Conventions\n{\n    class C\n    {\n        Action Get() => null;\n    }\n}\n", output.Replace("\r\n", "\n"));
        Assert.Contains("\r\n", output);
        Assert.Matches("[^\r]\n", output);
    }

    [Theory]
    [InlineData(Sorting.None, "using aa;\nusing AB;\n")]
    [InlineData(Sorting.RemoveAndSortUsings, "using aa;\nusing AB;\n")]
    public async Task MoveUsingsOutsideNamespace_SortsTheMovedDirectivesAsTheStepThatSortsTheFile(Sorting sorting, string expectedUsings)
    {
        _user["moveUsingsOutsideNamespace"] = true;
        string input = "using aa;\n\nnamespace Conventions\n{\n    using AB;\n\n    class C\n    {\n        X GetX() => null;\n\n        Y GetY() => null;\n    }\n}\n";

        string output = await CleanupAsync(input, null, otherDocument: "namespace aa\n{\n    public class X\n    {\n    }\n}\n\nnamespace AB\n{\n    public class Y\n    {\n    }\n}\n", usingDirectiveSorting: sorting);

        Assert.Equal(expectedUsings + "\nnamespace Conventions\n{\n    class C\n    {\n        X GetX() => null;\n\n        Y GetY() => null;\n    }\n}\n", output);
    }

    [Theory]
    [InlineData(Sorting.None, "using System.Text;\nusing System;\n")]
    [InlineData(Sorting.RemoveAndSortUsings, "using System;\nusing System.Text;\n")]
    public async Task MoveUsingsOutsideNamespace_SortsSystemDirectives(Sorting sorting, string expectedUsings)
    {
        _user["moveUsingsOutsideNamespace"] = true;
        string input = "using System.Text;\n\nnamespace Conventions\n{\n    using System;\n\n    class C\n    {\n        Action Get() => null;\n\n        StringBuilder Build() => null;\n    }\n}\n";

        string output = await CleanupAsync(input, null, usingDirectiveSorting: sorting);

        Assert.Equal(expectedUsings + "\nnamespace Conventions\n{\n    class C\n    {\n        Action Get() => null;\n\n        StringBuilder Build() => null;\n    }\n}\n", output);
    }

    [Theory]
    [InlineData("end_of_line = lf", "\n", "\n")]
    [InlineData("end_of_line = crlf", "\n", "\r\n")]
    [InlineData("end_of_line = unset", "\n", "\n")]
    [InlineData("end_of_line = unset", "\r\n", "\r\n")]
    public async Task CodeFixInsertingItsOwnLineBreak_KeepsTheLineEndingOfTheFile(string endOfLine, string inputLineEnding, string expectedLineEnding)
    {
        _user["moveUsingsOutsideNamespace"] = true;
        string input = "namespace Conventions\n{\n    using System;\n\n    class C\n    {\n        Action Get() => null;\n    }\n}\n".Replace("\n", inputLineEnding);
        string expected = "using System;\n\nnamespace Conventions\n{\n    class C\n    {\n        Action Get() => null;\n    }\n}\n".Replace("\n", expectedLineEnding);

        Assert.Equal(expected, await CleanupAsync(input, endOfLine));
    }

    [Fact]
    public async Task NamespaceMatchFolder_FixesTheNamespaceFromTheFolder_AndNoOtherDiagnostic()
    {
        string editorConfig = "root = true\n\n[*]\nend_of_line = lf\n\n[*.cs]\ncsharp_prefer_braces = true:warning\n";
        string input = "namespace Root.BadExample\n{\n    class Example\n    {\n        int Get(bool open)\n        {\n            if (open)\n                return 1;\n            return 0;\n        }\n    }\n}\n";
        string expected = "namespace Root.Data\n{\n    class Example\n    {\n        int Get(bool open)\n        {\n            if (open)\n                return 1;\n            return 0;\n        }\n    }\n}\n";

        // As in a Visual Studio project: the project directory is the folder root and RootNamespace is the default namespace.
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace { DefaultNamespace = "Root" };
        workspace.AddEditorConfig(string.Empty, editorConfig);
        workspace.AddGlobalConfig("BuildProperties", $"build_property.RootNamespace = Root\nbuild_property.ProjectDir = {DiagnosticCleanupTestWorkspace.RootDirectory}{Path.DirectorySeparatorChar}\n");
        DocumentId documentId = workspace.AddDocument("Data/Example.cs", input);
        Solution solution = workspace.CreateSolution();

        DiagnosticCleanupResult result = await new DiagnosticCleanupEngine(new CodeFixProviderCatalog()).CleanupAsync(
            solution.GetDocument(documentId), DiagnosticCleanupOptions.NamespaceMatchFolder, CancellationToken.None);

        Assert.Equal(expected, await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
    }

    [Fact]
    public async Task NamespaceMatchFolder_UpdatesReferencesInOtherFiles_WithTheEndOfLineOfEachFile()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace { DefaultNamespace = "Root" };
        workspace.AddEditorConfig(string.Empty, "root = true\n\n[*.cs]\nend_of_line = crlf\n");
        workspace.AddGlobalConfig("BuildProperties", $"build_property.RootNamespace = Root\nbuild_property.ProjectDir = {DiagnosticCleanupTestWorkspace.RootDirectory}{Path.DirectorySeparatorChar}\n");
        DocumentId documentId = workspace.AddDocument("Data/Example.cs", "namespace Root.BadExample\n{\n    public class Example\n    {\n    }\n}\n");
        DocumentId referenceId = workspace.AddDocument("Use.cs", "using Root.BadExample;\n\nnamespace Root\n{\n    class Use\n    {\n        Example Get() => null;\n    }\n}\n");
        Solution solution = workspace.CreateSolution();

        DiagnosticCleanupResult result = await new DiagnosticCleanupEngine(new CodeFixProviderCatalog()).CleanupAsync(
            solution.GetDocument(documentId), DiagnosticCleanupOptions.NamespaceMatchFolder, CancellationToken.None);

        Assert.Equal("namespace Root.Data\r\n{\r\n    public class Example\r\n    {\r\n    }\r\n}\r\n", await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, documentId));
        Assert.Equal("using Root.Data;\r\n\r\nnamespace Root\r\n{\r\n    class Use\r\n    {\r\n        Example Get() => null;\r\n    }\r\n}\r\n", await DiagnosticCleanupTestWorkspace.GetTextAsync(result.ChangedSolution, referenceId));
    }

    /// <summary>How the using directives are sorted after the fixes.</summary>
    public enum Sorting
    {
        /// <summary>The order the fix wrote (organizeUsings off).</summary>
        None,

        /// <summary>Roslyn's Remove and Sort Usings (organizeUsings on).</summary>
        RemoveAndSortUsings,
    }

    private async Task<string> CleanupAsync(string input, string editorConfig, LanguageVersion languageVersion = LanguageVersion.Default, string otherDocument = null, Sorting usingDirectiveSorting = Sorting.None)
    {
        string text = "root = true\n\n[*]\nend_of_line = lf\n\n[*.cs]\n" + (editorConfig is null ? string.Empty : editorConfig + "\n");
        File.WriteAllText(Path.Combine(_directory, ".editorconfig"), text);

        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace { ParseOptions = new CSharpParseOptions(languageVersion) };
        workspace.AddEditorConfig(_directoryName, text);
        DocumentId documentId = workspace.AddDocument(_directoryName + "/Probe.cs", input);
        if (otherDocument is not null)
        {
            workspace.AddDocument(_directoryName + "/Other.cs", otherDocument);
        }

        Document document = workspace.CreateSolution().GetDocument(documentId);
        _user["organizeUsings"] = usingDirectiveSorting == Sorting.RemoveAndSortUsings;
        EffectiveSettings settings = await EffectiveSettings.ForDocumentAsync(document, _user, CancellationToken.None);

        Solution cleaned = await new RoslynRulesStep().ApplyAsync(document, settings, CancellationToken.None);
        if (usingDirectiveSorting == Sorting.RemoveAndSortUsings)
        {
            cleaned = await new OrganizeUsingsStep().ApplyAsync(cleaned.GetDocument(documentId), settings, CancellationToken.None);
        }

        return await DiagnosticCleanupTestWorkspace.GetTextAsync(cleaned, documentId);
    }

    private void SetUser(string settingName, bool value)
    {
        if (settingName == "insertExplicitAccessModifiersOnClasses")
        {
            SetExplicitAccessModifiers(value);
        }
        else
        {
            _user[settingName] = value;
        }
    }

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

    private void SetExplicitAccessModifiers(bool value)
    {
        foreach (string key in new[] { "Classes", "Delegates", "Enumerations", "Events", "Fields", "Interfaces", "Methods", "Properties", "Structs" })
        {
            _user["insertExplicitAccessModifiersOn" + key] = value;
        }
    }
}
