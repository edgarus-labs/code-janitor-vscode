using Microsoft.VisualStudio.TestTools.UnitTesting;
using CodeJanitor.Logic.Transformations;

namespace CodeJanitor.UnitTests.Transformations;

[TestClass]
public sealed class NormalizeBlankLinesConverterTests
{
    private NormalizeBlankLinesConverter _converter;

    [TestInitialize]
    public void TestInitialize()
    {
        _converter = new NormalizeBlankLinesConverter();
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void NoBlankLines_Unchanged()
    {
        var input = "class C\n{\n    void M() { }\n}";
        Assert.AreEqual(input, _converter.Normalize(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void SingleBlankLine_Unchanged()
    {
        var input = "class C\n{\n    void A() { }\n\n    void B() { }\n}";
        Assert.AreEqual(input, _converter.Normalize(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void TwoBlankLines_CollapsedToOne()
    {
        var input = "class C\n{\n    void A() { }\n\n\n    void B() { }\n}";
        var expected = "class C\n{\n    void A() { }\n\n    void B() { }\n}";
        Assert.AreEqual(expected, _converter.Normalize(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void ThreeBlankLines_CollapsedToOne()
    {
        var input = "void A() { }\n\n\n\nvoid B() { }";
        var expected = "void A() { }\n\nvoid B() { }";
        Assert.AreEqual(expected, _converter.Normalize(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void CrlfTwoBlankLines_CollapsedToOne()
    {
        var input = "void A() { }\r\n\r\n\r\nvoid B() { }";
        var expected = "void A() { }\r\n\r\nvoid B() { }";
        Assert.AreEqual(expected, _converter.Normalize(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void MultipleRunsOfBlankLines_AllCollapsed()
    {
        var input = "A\n\n\n\nB\n\n\nC\n\n\n\n\nD";
        var expected = "A\n\nB\n\nC\n\nD";
        Assert.AreEqual(expected, _converter.Normalize(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void BlankLinesWithWhitespace_CollapsedCorrectly()
    {
        // Intermediate blank lines that contain only whitespace (e.g. indented editors) are collapsed.
        var input = "A\n\n   \n\nB";
        var expected = "A\n\nB";
        Assert.AreEqual(expected, _converter.Normalize(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void EmptyString_Unchanged()
    {
        Assert.AreEqual(string.Empty, _converter.Normalize(string.Empty));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void NullString_ReturnsNull()
    {
        Assert.IsNull(_converter.Normalize(null));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void ImplementsISourceTransformation()
    {
        Assert.AreEqual("Normalize blank lines", _converter.Name);
        var input = "A\n\n\nB";
        var expected = "A\n\nB";
        Assert.AreEqual(expected, _converter.Apply(input));
    }
}
