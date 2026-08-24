using Microsoft.VisualStudio.TestTools.UnitTesting;
using CodeJanitor.Logic.Transformations;

namespace CodeJanitor.UnitTests.Transformations;

/// <summary>
/// Unit tests for <see cref="EnsureFinalNewlineConverter" />.
/// </summary>

[TestClass]
public sealed class EnsureFinalNewlineConverterTests
{
    private EnsureFinalNewlineConverter _converter;

    [TestInitialize]
    public void TestInitialize()
    {
        _converter = new EnsureFinalNewlineConverter();
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void MissingFinalNewline_Added()
    {
        var input = "class C\n{\n}";
        var expected = "class C\n{\n}\n";

        Assert.AreEqual(expected, _converter.Convert(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void ExistingFinalNewline_Unchanged()
    {
        var input = "class C\n{\n}\n";

        Assert.AreEqual(input, _converter.Convert(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void CrlfFileMissingFinalNewline_GetsCrlf()
    {
        var input = "class C\r\n{\r\n}";
        var expected = "class C\r\n{\r\n}\r\n";

        Assert.AreEqual(expected, _converter.Convert(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void ExistingCrlfFinalNewline_Unchanged()
    {
        var input = "class C\r\n{\r\n}\r\n";

        Assert.AreEqual(input, _converter.Convert(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void MultipleTrailingNewlines_CollapsedToOne()
    {
        var input = "class C\n{\n}\n\n\n";
        var expected = "class C\n{\n}\n";

        Assert.AreEqual(expected, _converter.Convert(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void MultipleTrailingCrlfNewlines_CollapsedToOneCrlf()
    {
        var input = "class C\r\n{\r\n}\r\n\r\n";
        var expected = "class C\r\n{\r\n}\r\n";

        Assert.AreEqual(expected, _converter.Convert(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void EmptySource_Unchanged()
    {
        Assert.AreEqual(string.Empty, _converter.Convert(string.Empty));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void NullSource_ReturnsNull()
    {
        Assert.IsNull(_converter.Convert(null));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void ImplementsSourceTransformation()
    {
        ISourceTransformation transformation = new EnsureFinalNewlineConverter();

        Assert.AreEqual("class C\n{\n}\n", transformation.Apply("class C\n{\n}"));
        Assert.AreEqual("Ensure final newline", transformation.Name);
    }
}
