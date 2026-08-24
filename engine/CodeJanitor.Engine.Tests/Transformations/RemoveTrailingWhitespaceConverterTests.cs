using Microsoft.VisualStudio.TestTools.UnitTesting;
using CodeJanitor.Logic.Transformations;

namespace CodeJanitor.UnitTests.Transformations;

/// <summary>
/// Unit tests for <see cref="RemoveTrailingWhitespaceConverter" />. Verifies trailing spaces/tabs
/// and whitespace-only lines are cleaned while indentation and whitespace inside string literals
/// are preserved (headless-Roslyn cleanup block, BL-018, C#-only per scope).
/// </summary>

[TestClass]
public sealed class RemoveTrailingWhitespaceConverterTests
{
    private RemoveTrailingWhitespaceConverter _converter;

    [TestInitialize]
    public void TestInitialize()
    {
        _converter = new RemoveTrailingWhitespaceConverter();
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void TrailingSpacesAfterCode_Removed()
    {
        var input = "class C\n{\n    int x;   \n}\n";
        var expected = "class C\n{\n    int x;\n}\n";

        Assert.AreEqual(expected, _converter.Convert(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void TrailingTabsAfterCode_Removed()
    {
        var input = "class C\n{\n    int x;\t\t\n}\n";
        var expected = "class C\n{\n    int x;\n}\n";

        Assert.AreEqual(expected, _converter.Convert(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void WhitespaceOnlyLine_Emptied()
    {
        var input = "class C\n{\n   \n}\n";
        var expected = "class C\n{\n\n}\n";

        Assert.AreEqual(expected, _converter.Convert(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void Indentation_Preserved()
    {
        var input = "class C\n{\n    int x;\n}\n";

        Assert.AreEqual(input, _converter.Convert(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void TrailingWhitespaceInsideVerbatimString_Preserved()
    {
        var input = "class C\n{\n    string s = @\"a   \nb\";\n}\n";

        Assert.AreEqual(input, _converter.Convert(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void NoTrailingWhitespace_Unchanged()
    {
        var input = "using System;\n\nclass C\n{\n}\n";

        Assert.AreEqual(input, _converter.Convert(input));
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
        ISourceTransformation transformation = new RemoveTrailingWhitespaceConverter();
        var input = "class C\n{\n    int x;   \n}\n";
        var expected = "class C\n{\n    int x;\n}\n";

        Assert.AreEqual(expected, transformation.Apply(input));
        Assert.AreEqual("Remove trailing whitespace", transformation.Name);
    }
}
