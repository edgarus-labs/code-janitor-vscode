#nullable disable
using CodeJanitor.Engine.Steps.Transformations;
using Xunit;
using Assert = CodeJanitor.Engine.Tests.Steps.Support.MsAssert;

namespace CodeJanitor.Engine.Tests.Steps;

/// <summary>
/// Unit tests for <see cref="ByteOrderMarkConverter" />.
/// </summary>
public sealed class ByteOrderMarkConverterTests
{
    private ByteOrderMarkConverter _converter;

    public ByteOrderMarkConverterTests() => _converter = new ByteOrderMarkConverter();

    [Fact]
    public void Name_IsNotEmpty() => Assert.IsFalse(string.IsNullOrWhiteSpace(_converter.Name));

    [Fact]
    public void Apply_WithLeadingBom_StripsBom()
    {
        string input = "\uFEFFusing System;\r\n\r\npublic class C { }\r\n";
        string expected = "using System;\r\n\r\npublic class C { }\r\n";

        string result = _converter.Apply(input);

        Assert.AreEqual(expected, result);
    }

    [Fact]
    public void Apply_WithoutLeadingBom_ReturnsSameText()
    {
        string input = "using System;\r\n\r\npublic class C { }\r\n";

        string result = _converter.Apply(input);

        Assert.AreEqual(input, result);
    }

    [Fact]
    public void Apply_NullOrEmpty_ReturnsOriginal()
    {
        Assert.IsNull(_converter.Apply(null));
        Assert.AreEqual(string.Empty, _converter.Apply(string.Empty));
    }

    [Fact]
    public void Apply_BomOnly_ReturnsEmptyString()
    {
        string input = "\uFEFF";

        string result = _converter.Apply(input);

        Assert.AreEqual(string.Empty, result);
    }

    [Theory]
    [InlineData("class C { string s = \"\uFEFF\"; }", "class C { string s = \"\uFEFF\"; }")]
    [InlineData("\uFEFF\uFEFFclass C { }", "\uFEFFclass C { }")]
    [InlineData("\uFEFF// header\r\nConsole.WriteLine();\r\n", "// header\r\nConsole.WriteLine();\r\n")]
    public void OnlyTheLeadingByteOrderMarkIsRemoved(string input, string expected) => Assert.AreEqual(expected, _converter.Apply(input));
}
