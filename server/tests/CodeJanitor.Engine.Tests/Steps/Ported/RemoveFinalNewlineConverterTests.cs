#nullable disable
using CodeJanitor.Engine.Steps.Transformations;
using Xunit;
using Assert = CodeJanitor.Engine.Tests.Steps.Support.MsAssert;

namespace CodeJanitor.Engine.Tests.Steps;

/// <summary>
/// Unit tests for <see cref="RemoveFinalNewlineConverter" /> (<c>insert_final_newline = false</c>).
/// </summary>
public sealed class RemoveFinalNewlineConverterTests
{
    private RemoveFinalNewlineConverter _converter;

    public RemoveFinalNewlineConverterTests() => _converter = new RemoveFinalNewlineConverter();

    [Theory]
    [InlineData("class C\r\n{\r\n}\r\n", "class C\r\n{\r\n}")]
    [InlineData("class C\n{\n}\n", "class C\n{\n}")]
    [InlineData("class C\r\n{\r\n}\r\n\r\n\n", "class C\r\n{\r\n}")]
    [InlineData("class C {}\n  \n\t\n", "class C {}")]
    [InlineData("class C {}  \n", "class C {}  ")]
    [InlineData("// comment\r\n", "// comment")]
    public void FinalLineBreaks_AreRemoved(string input, string expected) => Assert.AreEqual(expected, _converter.Convert(input));

    [Fact]
    public void NoFinalLineBreak_ReturnsTheSameInstance()
    {
        string input = "class C\r\n{\r\n}";

        Assert.AreSame(input, _converter.Convert(input));
    }

    [Fact]
    public void NullOrEmpty_ReturnsInput()
    {
        Assert.IsNull(_converter.Convert(null));
        Assert.AreEqual(string.Empty, _converter.Convert(string.Empty));
    }

    [Fact]
    public void AsSourceTransformation_HasANameAndAppliesTheConversion()
    {
        ISourceTransformation transformation = new RemoveFinalNewlineConverter();

        Assert.AreEqual("Remove final newline", transformation.Name);
        Assert.AreEqual("class C { }", transformation.Apply("class C { }\r\n"));
    }

    [Theory]
    [InlineData("\r\n\r\n", "")]
    [InlineData("a\r", "a")]
    [InlineData("var s = \"\"\"\n  x\n  \"\"\";\n", "var s = \"\"\"\n  x\n  \"\"\";")]
    [InlineData("Console.WriteLine();\n#endregion\n\n", "Console.WriteLine();\n#endregion")]
    public void EdgeFiles(string input, string expected) => Assert.AreEqual(expected, _converter.Convert(input));
}
