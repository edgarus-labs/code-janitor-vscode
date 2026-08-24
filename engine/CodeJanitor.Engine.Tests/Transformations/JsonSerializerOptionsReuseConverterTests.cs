using Microsoft.VisualStudio.TestTools.UnitTesting;
using CodeJanitor.Logic.Transformations;

namespace CodeJanitor.UnitTests.Transformations;

/// <summary>
/// Unit tests for <see cref="JsonSerializerOptionsReuseConverter" />.
/// </summary>

[TestClass]
public sealed class JsonSerializerOptionsReuseConverterTests
{
    private ISourceTransformation _converter;

    [TestInitialize]
    public void TestInitialize()
    {
        _converter = new JsonSerializerOptionsReuseConverter();
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void ConvertsDirectOptionsAllocationInJsonSerializerCall()
    {
        var input = "using System.Text.Json; class C { string M(object value) { return JsonSerializer.Serialize(value, new JsonSerializerOptions()); } }";
        var expected = "using System.Text.Json; class C { string M(object value) { return JsonSerializer.Serialize(value, null); } }";

        Assert.AreEqual(expected, _converter.Apply(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void ConvertsNamedOptionsArgument()
    {
        var input = "using System.Text.Json; class C { string M(object value) { return JsonSerializer.Serialize(value, options: new JsonSerializerOptions()); } }";
        var expected = "using System.Text.Json; class C { string M(object value) { return JsonSerializer.Serialize(value, options: null); } }";

        Assert.AreEqual(expected, _converter.Apply(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void ConvertsFullyQualifiedJsonSerializerCall()
    {
        var input = "class C { string M(object value) { return System.Text.Json.JsonSerializer.Serialize(value, new System.Text.Json.JsonSerializerOptions()); } }";
        var expected = "class C { string M(object value) { return System.Text.Json.JsonSerializer.Serialize(value, null); } }";

        Assert.AreEqual(expected, _converter.Apply(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void SkipsConfiguredOptionsInitializer()
    {
        var input = "using System.Text.Json; class C { string M(object value) { return JsonSerializer.Serialize(value, new JsonSerializerOptions { WriteIndented = true }); } }";

        Assert.AreEqual(input, _converter.Apply(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void SkipsOptionsConstructorWithArguments()
    {
        var input = "using System.Text.Json; class C { string M(object value) { return JsonSerializer.Serialize(value, new JsonSerializerOptions(JsonSerializerDefaults.Web)); } }";

        Assert.AreEqual(input, _converter.Apply(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void SkipsNonJsonSerializerCalls()
    {
        var input = "class C { void M(Foo f) { f.Serialize(new JsonSerializerOptions()); } }";

        Assert.AreEqual(input, _converter.Apply(input));
    }
}
