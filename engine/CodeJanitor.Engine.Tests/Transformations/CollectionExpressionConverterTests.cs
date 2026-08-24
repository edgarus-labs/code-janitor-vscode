using Microsoft.VisualStudio.TestTools.UnitTesting;
using CodeJanitor.Logic.Transformations;

namespace CodeJanitor.UnitTests.Transformations;

/// <summary>
/// Unit tests for <see cref="CollectionExpressionConverter" />.
/// </summary>

[TestClass]
public sealed class CollectionExpressionConverterTests
{
    private ISourceTransformation _converter;

    [TestInitialize]
    public void TestInitialize()
    {
        _converter = new CollectionExpressionConverter();
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void ConvertsEmptyListFieldInitialization()
    {
        var input = "class C { private readonly List<string> _items = new List<string>(); }";
        var expected = "class C { private readonly List<string> _items = []; }";

        Assert.AreEqual(expected, _converter.Apply(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void ConvertsListWithInitializerElements()
    {
        var input = "class C { void M() { List<string> items = new List<string>() { \"a\", \"b\" }; } }";
        var expected = "class C { void M() { List<string> items = [\"a\", \"b\"]; } }";

        Assert.AreEqual(expected, _converter.Apply(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void ConvertsLocalListDeclaration()
    {
        var input = "class C { void M() { List<int> x = new List<int>(); } }";
        var expected = "class C { void M() { List<int> x = []; } }";

        Assert.AreEqual(expected, _converter.Apply(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void ConvertsArrayWithInitializerElements()
    {
        var input = "class C { void M() { int[] a = new int[] { 1, 2, 3 }; } }";
        var expected = "class C { void M() { int[] a = [1, 2, 3]; } }";

        Assert.AreEqual(expected, _converter.Apply(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void ConvertsExplicitlyEmptyArray()
    {
        var input = "class C { void M() { int[] a = new int[0]; } }";
        var expected = "class C { void M() { int[] a = []; } }";

        Assert.AreEqual(expected, _converter.Apply(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void ConvertsImplicitArrayCreation()
    {
        var input = "class C { void M() { int[] a = new[] { 1, 2, 3 }; } }";
        var expected = "class C { void M() { int[] a = [1, 2, 3]; } }";

        Assert.AreEqual(expected, _converter.Apply(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void ConvertsAutoPropertyInitializer()
    {
        var input = "class C { public List<string> Items { get; } = new List<string>(); }";
        var expected = "class C { public List<string> Items { get; } = []; }";

        Assert.AreEqual(expected, _converter.Apply(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void SkipsListWithConstructorArguments()
    {
        var input = "class C { void M() { List<string> x = new List<string>(10); } }";

        Assert.AreEqual(input, _converter.Apply(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void SkipsWhenDeclaredTypeDiffersFromCreatedType()
    {
        var input = "class C { void M() { IList<string> x = new List<string>(); } }";

        Assert.AreEqual(input, _converter.Apply(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void SkipsSizedArrayWithoutInitializer()
    {
        var input = "class C { void M() { int[] a = new int[5]; } }";

        Assert.AreEqual(input, _converter.Apply(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void SkipsNonListGenericType()
    {
        var input = "class C { void M() { HashSet<string> x = new HashSet<string>(); } }";

        Assert.AreEqual(input, _converter.Apply(input));
    }
}
