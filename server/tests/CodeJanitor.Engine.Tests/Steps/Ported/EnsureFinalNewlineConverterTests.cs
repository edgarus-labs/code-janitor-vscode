#nullable disable
using CodeJanitor.Engine.Steps.Transformations;
using Xunit;
using Assert = CodeJanitor.Engine.Tests.Steps.Support.MsAssert;

namespace CodeJanitor.Engine.Tests.Steps;

/// <summary>
/// Unit tests for <see cref="EnsureFinalNewlineConverter" />.
/// </summary>
public sealed class EnsureFinalNewlineConverterTests
{
    private EnsureFinalNewlineConverter _converter;

    public EnsureFinalNewlineConverterTests() => _converter = new EnsureFinalNewlineConverter();

    [Fact]
    public void MissingFinalNewline_Added()
    {
        string input = "class C\n{\n}";
        string expected = "class C\n{\n}\n";

        Assert.AreEqual(expected, _converter.Convert(input));
    }

    [Fact]
    public void ExistingFinalNewline_Unchanged()
    {
        string input = "class C\n{\n}\n";

        Assert.AreEqual(input, _converter.Convert(input));
    }

    [Fact]
    public void CrlfFileMissingFinalNewline_GetsCrlf()
    {
        string input = "class C\r\n{\r\n}";
        string expected = "class C\r\n{\r\n}\r\n";

        Assert.AreEqual(expected, _converter.Convert(input));
    }

    [Fact]
    public void ExistingCrlfFinalNewline_Unchanged()
    {
        string input = "class C\r\n{\r\n}\r\n";

        Assert.AreEqual(input, _converter.Convert(input));
    }

    [Fact]
    public void MultipleTrailingNewlines_CollapsedToOne()
    {
        string input = "class C\n{\n}\n\n\n";
        string expected = "class C\n{\n}\n";

        Assert.AreEqual(expected, _converter.Convert(input));
    }

    [Fact]
    public void MultipleTrailingCrlfNewlines_CollapsedToOneCrlf()
    {
        string input = "class C\r\n{\r\n}\r\n\r\n";
        string expected = "class C\r\n{\r\n}\r\n";

        Assert.AreEqual(expected, _converter.Convert(input));
    }

    [Fact]
    public void EmptySource_Unchanged() => Assert.AreEqual(string.Empty, _converter.Convert(string.Empty));

    [Fact]
    public void NullSource_ReturnsNull() => Assert.IsNull(_converter.Convert(null));

    [Fact]
    public void ImplementsSourceTransformation()
    {
        ISourceTransformation transformation = new EnsureFinalNewlineConverter();

        Assert.AreEqual("class C\n{\n}\n", transformation.Apply("class C\n{\n}"));
        Assert.AreEqual("Ensure final newline", transformation.Name);
    }

    [Theory]
    [InlineData("Console.WriteLine();\r\n// end", "Console.WriteLine();\r\n// end\r\n")]
    [InlineData("#region R\r\n#endregion", "#region R\r\n#endregion\r\n")]
    [InlineData("\r\n\r\n", "\r\n")]
    [InlineData("a\nb\r\n\n", "a\nb\r\n")]
    public void FinalLineBreak_IsExactlyOne(string input, string expected) => Assert.AreEqual(expected, _converter.Convert(input));

    [Theory]
    [InlineData("class C { }\r", "class C { }\r")]
    [InlineData("class C\r{ }", "class C\r{ }\r")]
    [InlineData("class C { }\r\r\r", "class C { }\r")]
    public void CarriageReturnOnlyFile_KeepsItsLineBreakStyle(string input, string expected) => Assert.AreEqual(expected, _converter.Convert(input));

    [Theory]
    [InlineData("class C\n{\n}")]
    [InlineData("class C\r\n{\r\n}\r\n\r\n\r\n")]
    [InlineData("a\nb\r\n\n")]
    [InlineData("class C { }\r\r\r")]
    [InlineData("#region R\r\n#endregion")]
    [InlineData("\r\n\r\n")]
    public void Apply_IsIdempotent(string input)
    {
        string once = _converter.Convert(input);

        Assert.AreNotEqual(input, once, "The scenario has to change the input at all.");
        Assert.AreEqual(once, _converter.Convert(once));
    }
}
