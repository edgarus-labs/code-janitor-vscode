#nullable disable
using System.IO;
using System.Linq;
using System.Reflection;
using CodeJanitor.Engine.Steps.Transformations;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;
using Assert = CodeJanitor.Engine.Tests.Steps.Support.MsAssert;

namespace CodeJanitor.Engine.Tests.Steps;

/// <summary>
/// Unit tests for <see cref="JsonSerializerOptionsReuseConverter" />.
/// </summary>
public sealed class JsonSerializerOptionsReuseConverterTests
{
    private ISourceTransformation _converter;

    public JsonSerializerOptionsReuseConverterTests() => _converter = new JsonSerializerOptionsReuseConverter();

    [Fact]
    public void ConvertsDirectOptionsAllocationInJsonSerializerCall()
    {
        string input = "using System.Text.Json; class C { string M(object value) { return JsonSerializer.Serialize(value, new JsonSerializerOptions()); } }";
        string expected = "using System.Text.Json; class C { string M(object value) { return JsonSerializer.Serialize(value, default(JsonSerializerOptions)); } }";

        Assert.AreEqual(expected, _converter.Apply(input));
    }

    [Fact]
    public void ConvertsNamedOptionsArgument()
    {
        string input = "using System.Text.Json; class C { string M(object value) { return JsonSerializer.Serialize(value, options: new JsonSerializerOptions()); } }";
        string expected = "using System.Text.Json; class C { string M(object value) { return JsonSerializer.Serialize(value, options: null); } }";

        Assert.AreEqual(expected, _converter.Apply(input));
    }

    [Fact]
    public void ConvertsFullyQualifiedJsonSerializerCall()
    {
        string input = "class C { string M(object value) { return System.Text.Json.JsonSerializer.Serialize(value, new System.Text.Json.JsonSerializerOptions()); } }";
        string expected = "class C { string M(object value) { return System.Text.Json.JsonSerializer.Serialize(value, default(System.Text.Json.JsonSerializerOptions)); } }";

        Assert.AreEqual(expected, _converter.Apply(input));
    }

    [Theory]
    [InlineData("using System.Text.Json; class C { T M<T>(string s) => JsonSerializer.Deserialize<T>(s, new JsonSerializerOptions()); }", "using System.Text.Json; class C { T M<T>(string s) => JsonSerializer.Deserialize<T>(s, default(JsonSerializerOptions)); }")]
    [InlineData("using System.Text.Json; class C { object M(string s) => JsonSerializer.Deserialize(s, typeof(C), new JsonSerializerOptions()); }", "using System.Text.Json; class C { object M(string s) => JsonSerializer.Deserialize(s, typeof(C), default(JsonSerializerOptions)); }")]
    [InlineData("using System.Text.Json; class C { T M<T>(object v) => JsonSerializer.Deserialize<T>(JsonSerializer.Serialize(v, new JsonSerializerOptions()), new JsonSerializerOptions()); }", "using System.Text.Json; class C { T M<T>(object v) => JsonSerializer.Deserialize<T>(JsonSerializer.Serialize(v, default(JsonSerializerOptions)), default(JsonSerializerOptions)); }")]
    public void PositionalOptions_BecomeDefault(string input, string expected) => Assert.AreEqual(expected, _converter.Apply(input));

    [Theory]
    [InlineData(
        "class C { string M(object v) => JsonSerializer.Serialize(v, new JsonSerializerOptions()); }",
        "class C { string M(object v) => JsonSerializer.Serialize(v, default(JsonSerializerOptions)); }")]
    [InlineData(
        "using System.Text.Json; static class JsonSerializer { public static string Serialize(object value, JsonSerializerOptions settings) => \"\"; } class C { string M(object v) => JsonSerializer.Serialize(v, new JsonSerializerOptions()); }",
        "using System.Text.Json; static class JsonSerializer { public static string Serialize(object value, JsonSerializerOptions settings) => \"\"; } class C { string M(object v) => JsonSerializer.Serialize(v, default(JsonSerializerOptions)); }")]
    public void PositionalOptionsOfAnotherJsonSerializer_BecomeDefault(string input, string expected) => Assert.AreEqual(expected, _converter.Apply(input));

    [Fact]
    public void OptionsAllocationPassedAsTheValue_IsUnchanged()
    {
        // The first argument of a System.Text.Json serializer call is the value (or JSON, or stream), never the options.
        string input = "using System.Text.Json; class C { string M() => JsonSerializer.Serialize(new JsonSerializerOptions()); }";

        Assert.AreEqual(input, _converter.Apply(input));
    }

    [Fact]
    public void SkipsConfiguredOptionsInitializer()
    {
        string input = "using System.Text.Json; class C { string M(object value) { return JsonSerializer.Serialize(value, new JsonSerializerOptions { WriteIndented = true }); } }";

        Assert.AreEqual(input, _converter.Apply(input));
    }

    [Fact]
    public void SkipsOptionsConstructorWithArguments()
    {
        string input = "using System.Text.Json; class C { string M(object value) { return JsonSerializer.Serialize(value, new JsonSerializerOptions(JsonSerializerDefaults.Web)); } }";

        Assert.AreEqual(input, _converter.Apply(input));
    }

    [Fact]
    public void SkipsNonJsonSerializerCalls()
    {
        string input = "class C { void M(Foo f) { f.Serialize(new JsonSerializerOptions()); } }";

        Assert.AreEqual(input, _converter.Apply(input));
    }

    [Fact]
    public void NameAndNullOrEmpty_HandledCorrectly()
    {
        Assert.AreEqual("CA1869 JsonSerializerOptions Reuse", _converter.Name);
        Assert.IsNull(_converter.Apply(null));
        Assert.AreEqual(string.Empty, _converter.Apply(string.Empty));
    }

    [Theory]
    [InlineData("  \r\n\t")]
    [InlineData("class C { void M() { JsonSerializer.Serialize(); } }")]
    [InlineData("using static System.Text.Json.JsonSerializer; class C { string M(object v) => Serialize(v, options: new JsonSerializerOptions()); }")]
    [InlineData("class C { string M(object v) => Json.JsonSerializer.Serialize(v, options: new JsonSerializerOptions()); }")]
    [InlineData("class C { string M(object v) => JsonSerializer.Serialize(v, options: new()); }")]
    [InlineData("class C { string M(object v) => JsonSerializer.Serialize(v, options: new JsonSerializerOptions() { }); }")]
    [InlineData("class C { string M(object v, JsonSerializerOptions o) => JsonSerializer.Serialize(v, options: new JsonSerializerOptions(o)); }")]
    [InlineData("class C { string M(object v) => JsonSerializer.Serialize(v, options: new Json.JsonSerializerOptions()); }")]
    [InlineData("class C { object M(object v) => JsonSerializer.Serialize(v, new JsonWriterOptions()); }")]
    [InlineData("class C { string M(object v, JsonSerializerOptions o) => JsonSerializer.Serialize(v, o); }")]
    [InlineData("class C { static readonly JsonSerializerOptions O = new JsonSerializerOptions(); }")]
    [InlineData("class C\r\n{\r\n    // JsonSerializer.Serialize(v, new JsonSerializerOptions())\r\n    string S = \"JsonSerializer.Serialize(v, new JsonSerializerOptions())\";\r\n}\r\n")]
    public void CallOrArgumentThatIsNotAPlainOptionsAllocation_IsUnchanged(string input) => Assert.AreEqual(input, _converter.Apply(input));

    [Theory]
    [InlineData("class C { string M(object v) => global::System.Text.Json.JsonSerializer.Serialize(v, options: new global::System.Text.Json.JsonSerializerOptions()); }", "class C { string M(object v) => global::System.Text.Json.JsonSerializer.Serialize(v, options: null); }")]
    [InlineData("using System.Text.Json; class C { T M<T>(string s) => JsonSerializer.Deserialize<T>(s, options: new System.Text.Json.JsonSerializerOptions()); }", "using System.Text.Json; class C { T M<T>(string s) => JsonSerializer.Deserialize<T>(s, options: null); }")]
    [InlineData("using System.Text.Json; class C { T M<T>(object v) => JsonSerializer.Deserialize<T>(JsonSerializer.Serialize(v, options: new JsonSerializerOptions()), options: new JsonSerializerOptions()); }", "using System.Text.Json; class C { T M<T>(object v) => JsonSerializer.Deserialize<T>(JsonSerializer.Serialize(v, options: null), options: null); }")]
    [InlineData("using System.Text.Json; class C { System.Func<object, string> F = v => JsonSerializer.Serialize(v, options: new JsonSerializerOptions()); }", "using System.Text.Json; class C { System.Func<object, string> F = v => JsonSerializer.Serialize(v, options: null); }")]
    [InlineData("using System.Text.Json; class C { async System.Threading.Tasks.Task M(System.IO.Stream s, object v) => await JsonSerializer.SerializeAsync(s, v, options: new JsonSerializerOptions()); }", "using System.Text.Json; class C { async System.Threading.Tasks.Task M(System.IO.Stream s, object v) => await JsonSerializer.SerializeAsync(s, v, options: null); }")]
    public void PlainOptionsAllocationInJsonSerializerCall_BecomesNull(string input, string expected) => Assert.AreEqual(expected, _converter.Apply(input));

    [Fact]
    public void TopLevelStatementsFile_ConvertsStatementsLocalFunctionsAndTypes()
    {
        string input =
            "using System.Text.Json;\r\n" +
            "\r\n" +
            "var json = JsonSerializer.Serialize(args, options: new JsonSerializerOptions());\r\n" +
            "\r\n" +
            "static string[] Read(string text) => JsonSerializer.Deserialize<string[]>(text, options: new JsonSerializerOptions());\r\n" +
            "\r\n" +
            "class Store\r\n" +
            "{\r\n" +
            "    public string Save(object value) => JsonSerializer.Serialize(value, options: new JsonSerializerOptions());\r\n" +
            "}\r\n";
        string expected = input.Replace("options: new JsonSerializerOptions()", "options: null");

        Assert.AreEqual(expected, _converter.Apply(input));
    }

    [Theory]
    [InlineData("\r\n")]
    [InlineData("\n")]
    public void TriviaAroundTheAllocation_IsPreserved(string newLine)
    {
        string input =
            "using System.Text.Json;" + newLine +
            "class C" + newLine +
            "{" + newLine +
            "\tstring M(object value) => JsonSerializer.Serialize(" + newLine +
            "\t\tvalue," + newLine +
            "\t\toptions: /* default */ new JsonSerializerOptions() /* end */); // trailing" + newLine +
            "}" + newLine;
        string expected = input.Replace("/* default */ new JsonSerializerOptions() /* end */", "/* default */ null /* end */");

        Assert.AreEqual(expected, _converter.Apply(input));
    }

    [Fact]
    public void FileWithSyntaxErrors_ConvertsTheValidCallAndKeepsTheRestVerbatim()
    {
        string input = "using System.Text.Json; class C { string M(object v) => JsonSerializer.Serialize(v, options: new JsonSerializerOptions()); void N( { int y = ; } }";
        string expected = "using System.Text.Json; class C { string M(object v) => JsonSerializer.Serialize(v, options: null); void N( { int y = ; } }";

        Assert.AreEqual(expected, _converter.Apply(input));
    }

    [Fact]
    public async System.Threading.Tasks.Task ConvertedCalls_CompileAgainstTheRealJsonSerializerOverloads()
    {
        string input =
            "using System.IO;\r\n" +
            "using System.Text.Json;\r\n" +
            "using System.Threading.Tasks;\r\n" +
            "class C\r\n" +
            "{\r\n" +
            "    string Serialize(object v) => JsonSerializer.Serialize(v, new JsonSerializerOptions());\r\n" +
            "    string SerializeWithType(object v) => JsonSerializer.Serialize(v, typeof(C), new JsonSerializerOptions());\r\n" +
            "    string SerializeGeneric(C v) => JsonSerializer.Serialize<C>(v, new JsonSerializerOptions());\r\n" +
            "    byte[] SerializeToBytes(object v) => JsonSerializer.SerializeToUtf8Bytes(v, new JsonSerializerOptions());\r\n" +
            "    void SerializeToWriter(Utf8JsonWriter w, object v) => JsonSerializer.Serialize(w, v, new JsonSerializerOptions());\r\n" +
            "    void SerializeToStream(Stream s, object v) => JsonSerializer.Serialize(s, v, new JsonSerializerOptions());\r\n" +
            "    Task SerializeAsync(Stream s, object v) => JsonSerializer.SerializeAsync(s, v, new JsonSerializerOptions());\r\n" +
            "    C Deserialize(string s) => JsonSerializer.Deserialize<C>(s, new JsonSerializerOptions());\r\n" +
            "    object DeserializeWithType(string s) => JsonSerializer.Deserialize(s, typeof(C), new JsonSerializerOptions());\r\n" +
            "    C DeserializeFromStream(Stream s) => JsonSerializer.Deserialize<C>(s, new JsonSerializerOptions());\r\n" +
            "    object DeserializeAsync(Stream s) => JsonSerializer.DeserializeAsync<C>(s, new JsonSerializerOptions());\r\n" +
            "    JsonElement ToElement(object v) => JsonSerializer.SerializeToElement(v, new JsonSerializerOptions());\r\n" +
            "    C Named(string s) => JsonSerializer.Deserialize<C>(s, options: new JsonSerializerOptions());\r\n" +
            "}\r\n";
        string expected = input
            .Replace(", options: new JsonSerializerOptions()", ", options: null")
            .Replace(", new JsonSerializerOptions()", ", default(JsonSerializerOptions)");
        Document document = CompilingTestProject.CreateDocument(input, LanguageVersion.Latest, GetJsonReferences());

        string result = _converter.Apply(input);

        Assert.AreEqual(expected, result);
        Assert.IsEmpty(await CompilingTestProject.GetCompileErrorsAsync(document, input), "the input must compile before the conversion");
        Assert.IsEmpty(await CompilingTestProject.GetCompileErrorsAsync(document, result));
    }

    [Theory]
    [InlineData(LanguageVersion.CSharp7_1)]
    [InlineData(LanguageVersion.Latest)]
    public async System.Threading.Tasks.Task OptionsFollowedByAPositionalArgument_ConvertedCallCompilesInEveryLanguageVersion(LanguageVersion languageVersion)
    {
        string input =
            "using System.IO;\r\n" +
            "using System.Text.Json;\r\n" +
            "using System.Threading;\r\n" +
            "using System.Threading.Tasks;\r\n" +
            "class C\r\n" +
            "{\r\n" +
            "    Task SerializeAsync(Stream s, object v, CancellationToken ct) => JsonSerializer.SerializeAsync(s, v, new JsonSerializerOptions(), ct);\r\n" +
            "    ValueTask<C> DeserializeAsync(Stream s, CancellationToken ct) => JsonSerializer.DeserializeAsync<C>(s, new System.Text.Json.JsonSerializerOptions(), ct);\r\n" +
            "}\r\n";
        Document document = CompilingTestProject.CreateDocument(input, languageVersion, GetJsonReferences());

        string result = _converter.Apply(input);

        Assert.DoesNotContain("new JsonSerializerOptions()", result, result);
        Assert.DoesNotContain("new System.Text.Json.JsonSerializerOptions()", result, result);
        Assert.IsEmpty(await CompilingTestProject.GetCompileErrorsAsync(document, input), "the input must compile before the conversion");
        Assert.IsEmpty(await CompilingTestProject.GetCompileErrorsAsync(document, result));
    }

    private static MetadataReference[] GetJsonReferences() =>
        new[] { "System.Text.Json", "System.Memory", "System.Text.Encodings.Web", "System.IO.Pipelines", "System.Runtime.InteropServices", "System.ComponentModel" }
            .Select(CompilingTestProject.RuntimeAssembly)
            .ToArray();
}
