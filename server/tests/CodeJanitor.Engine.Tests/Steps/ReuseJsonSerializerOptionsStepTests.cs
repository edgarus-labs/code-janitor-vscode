using System.Text.Json.Nodes;
using CodeJanitor.Engine.Tests.Steps.Support;
using Xunit;

namespace CodeJanitor.Engine.Tests.Steps;

/// <summary>
/// The CA1869 step (<c>reuseJsonSerializerOptionsForCA1869</c>, also on when <c>.editorconfig</c> enforces CA1869): a new
/// <c>JsonSerializerOptions()</c> becomes <c>default</c>, and options built from constants for one serializer call are cached
/// in a <c>private static readonly</c> field.
/// </summary>
public sealed class ReuseJsonSerializerOptionsStepTests
{
    private const string Usings = "using System.Text.Json;\nusing System.Text.Json.Serialization;\n\n";

    [Fact]
    public async Task OptionsBuiltFromConstants_AreCachedInStaticReadonlyFields()
    {
        var source = Method("object value", "var options = new JsonSerializerOptions { WriteIndented = true };", "return JsonSerializer.Serialize(value, options) + JsonSerializer.Serialize(value, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });");

        Assert.Equal(
            Usings + "class C\n{\n"
            + "    private static readonly JsonSerializerOptions JsonOptions = new JsonSerializerOptions { WriteIndented = true };\n"
            + "    private static readonly JsonSerializerOptions JsonOptions1 = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };\n\n"
            + "    object M(object value)\n    {\n        return JsonSerializer.Serialize(value, JsonOptions) + JsonSerializer.Serialize(value, JsonOptions1);\n    }\n}\n",
            await CleanAsync(source));
    }

    [Fact]
    public async Task AnEnforcedCA1869_CachesTheOptionsWithoutTheSetting()
    {
        var source = Usings + "class C\n{\n    public static string Run() => JsonSerializer.Serialize(new { A = 1 }, new JsonSerializerOptions { WriteIndented = true });\n}\n";

        Assert.Equal(
            Usings + "class C\n{\n    private static readonly JsonSerializerOptions JsonOptions = new JsonSerializerOptions { WriteIndented = true };\n\n    public static string Run() => JsonSerializer.Serialize(new { A = 1 }, JsonOptions);\n}\n",
            await StepHarness.CleanAsync(source, StepHarness.AllOff(), new Dictionary<string, string> { ["dotnet_diagnostic.ca1869.severity"] = "warning" }));
        Assert.Equal(source, await StepHarness.CleanAsync(source, StepHarness.AllOff()));
    }

    [Fact]
    public async Task ATargetTypedOptionsLocal_IsCached()
    {
        var source = Method("object value", "JsonSerializerOptions options = new(JsonSerializerDefaults.Web) { WriteIndented = true };", "return JsonSerializer.Serialize(value, options);");

        Assert.Equal(
            Usings + "class C\n{\n    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { WriteIndented = true };\n\n"
            + "    object M(object value)\n    {\n        return JsonSerializer.Serialize(value, JsonOptions);\n    }\n}\n",
            await CleanAsync(source));
    }

    [Fact]
    public async Task OptionsOfTheGenericSerializerMethodsWithStatelessConverters_AreCached()
    {
        var source = Method("string json, object o", "var a = JsonSerializer.Deserialize<int[]>(json, new JsonSerializerOptions { Converters = { new JsonStringEnumConverter() } });", "return JsonSerializer.Serialize<object>(o, new JsonSerializerOptions { WriteIndented = true });");

        Assert.Equal(
            Usings + "class C\n{\n"
            + "    private static readonly JsonSerializerOptions JsonOptions = new JsonSerializerOptions { Converters = { new JsonStringEnumConverter() } };\n"
            + "    private static readonly JsonSerializerOptions JsonOptions1 = new JsonSerializerOptions { WriteIndented = true };\n\n"
            + "    object M(string json, object o)\n    {\n        var a = JsonSerializer.Deserialize<int[]>(json, JsonOptions);\n        return JsonSerializer.Serialize<object>(o, JsonOptions1);\n    }\n}\n",
            await CleanAsync(source));
    }

    [Fact]
    public async Task AMultiLineField_IsSeparatedFromTheFirstMemberByABlankLine()
    {
        var source = Usings + "class C\n{\n    private readonly int _count;\n\n    object M(string json)\n    {\n        return JsonSerializer.Deserialize<int[]>(json, new JsonSerializerOptions\n        {\n            WriteIndented = true\n        });\n    }\n}\n";

        Assert.Equal(
            Usings + "class C\n{\n    private static readonly JsonSerializerOptions JsonOptions = new JsonSerializerOptions\n        {\n            WriteIndented = true\n        };\n\n"
            + "    private readonly int _count;\n\n    object M(string json)\n    {\n        return JsonSerializer.Deserialize<int[]>(json, JsonOptions);\n    }\n}\n",
            await CleanAsync(source));
    }

    [Fact]
    public async Task ANameInUse_GetsANumber()
    {
        var source = Usings + "class C\n{\n    private const int JsonOptions = 1;\n\n    string M(object value) => JsonSerializer.Serialize(value, new JsonSerializerOptions { MaxDepth = 4 });\n}\n";

        Assert.Equal(
            Usings + "class C\n{\n    private static readonly JsonSerializerOptions JsonOptions1 = new JsonSerializerOptions { MaxDepth = 4 };\n    private const int JsonOptions = 1;\n\n    string M(object value) => JsonSerializer.Serialize(value, JsonOptions1);\n}\n",
            await CleanAsync(source));
    }

    [Theory]
    [InlineData("object value, bool indent", "return JsonSerializer.Serialize(value, new JsonSerializerOptions { WriteIndented = indent });")]
    [InlineData("object value", "var options = new JsonSerializerOptions { WriteIndented = true };\n        options.MaxDepth = 3;\n        return JsonSerializer.Serialize(value, options);")]
    [InlineData("object value", "var options = new JsonSerializerOptions { WriteIndented = true };\n        return JsonSerializer.Serialize(value, options) + options.MaxDepth;")]
    [InlineData("object value", "return new JsonSerializerOptions { WriteIndented = true };")]
    public async Task OptionsThatDependOnTheCallOrAreNotOnlyPassedToTheSerializer_AreKept(string parameters, string body)
    {
        var source = Method(parameters, body);

        Assert.Equal(source, await CleanAsync(source));
    }

    [Fact]
    public async Task OptionsCreatedOnceInAStaticInitializer_AreKept()
    {
        var source = Usings + "class C\n{\n    private static readonly string Text = JsonSerializer.Serialize(1, new JsonSerializerOptions { WriteIndented = true });\n\n    static C()\n    {\n        JsonSerializer.Serialize(2, new JsonSerializerOptions { WriteIndented = true });\n    }\n}\n";

        Assert.Equal(source, await CleanAsync(source));
    }

    [Fact]
    public async Task APlainOptionsCreation_StillBecomesDefault()
    {
        var source = Method("object value", "return JsonSerializer.Serialize(value, new JsonSerializerOptions());");

        Assert.Equal(Method("object value", "return JsonSerializer.Serialize(value, default(JsonSerializerOptions));"), await CleanAsync(source));
    }

    private static string Method(string parameters, params string[] body) =>
        Usings + "class C\n{\n    object M(" + parameters + ")\n    {\n" + string.Concat(body.Select(line => "        " + line + "\n")) + "    }\n}\n";

    private static Task<string> CleanAsync(string source) =>
        StepHarness.CleanAsync(source, StepHarness.AllOff(new JsonObject { ["reuseJsonSerializerOptionsForCA1869"] = true }));
}
