using Microsoft.VisualStudio.TestTools.UnitTesting;
using CodeJanitor.Logic.Transformations;

namespace CodeJanitor.UnitTests.Transformations;

/// <summary>
/// Unit tests for <see cref="TabToSpaceConverter" />. Verifies that indentation/whitespace tabs
/// are expanded to spaces while tabs inside string/char literals and comments are preserved
/// (headless-Roslyn cleanup block, BL-018, C#-only per scope).
/// </summary>

[TestClass]
public sealed class TabToSpaceConverterTests
{
    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void IndentationTab_ExpandedToFourSpacesByDefault()
    {
        var converter = new TabToSpaceConverter();
        var input = "class C\n{\n\tint x;\n}\n";
        var expected = "class C\n{\n    int x;\n}\n";

        Assert.AreEqual(expected, converter.Convert(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void IndentationTab_ExpandedToCustomTabSize()
    {
        var converter = new TabToSpaceConverter(2);
        var input = "class C\n{\n\tint x;\n}\n";
        var expected = "class C\n{\n  int x;\n}\n";

        Assert.AreEqual(expected, converter.Convert(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void TabInsideStringLiteral_Preserved()
    {
        var converter = new TabToSpaceConverter();
        var input = "class C\n{\n\tstring s = \"a\tb\";\n}\n";
        var expected = "class C\n{\n    string s = \"a\tb\";\n}\n";

        Assert.AreEqual(expected, converter.Convert(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void TabInsideVerbatimString_Preserved()
    {
        var converter = new TabToSpaceConverter();
        var input = "class C\n{\n\tstring s = @\"a\tb\";\n}\n";
        var expected = "class C\n{\n    string s = @\"a\tb\";\n}\n";

        Assert.AreEqual(expected, converter.Convert(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void NoTabs_Unchanged()
    {
        var converter = new TabToSpaceConverter();
        var input = "class C\n{\n    int x;\n}\n";

        Assert.AreEqual(input, converter.Convert(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void EmptySource_Unchanged()
    {
        var converter = new TabToSpaceConverter();

        Assert.AreEqual(string.Empty, converter.Convert(string.Empty));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void NullSource_ReturnsNull()
    {
        var converter = new TabToSpaceConverter();

        Assert.IsNull(converter.Convert(null));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void ImplementsSourceTransformation_ApplyMatchesConvert()
    {
        ISourceTransformation transformation = new TabToSpaceConverter();
        var input = "class C\n{\n\tint x;\n}\n";
        var expected = "class C\n{\n    int x;\n}\n";

        Assert.AreEqual(expected, transformation.Apply(input));
        Assert.AreEqual("Convert tabs to spaces", transformation.Name);
    }
}
