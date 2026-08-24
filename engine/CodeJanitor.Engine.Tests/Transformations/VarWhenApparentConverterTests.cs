using Microsoft.VisualStudio.TestTools.UnitTesting;
using CodeJanitor.Logic.Transformations;

namespace CodeJanitor.UnitTests.Transformations;

/// <summary>
/// Unit tests for <see cref="VarWhenApparentConverter" />.
/// Policy (ADR-0007): use var only when the right-hand side explicitly indicates the type
/// (object creation, cast, array creation) and the declared type textually matches; method
/// invocations and literals keep the explicit type.
/// </summary>

[TestClass]
public sealed class VarWhenApparentConverterTests
{
    private ITypeStyleConverter _converter;

    [TestInitialize]
    public void TestInitialize()
    {
        _converter = new VarWhenApparentConverter();
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void ConvertsObjectCreationWithMatchingType()
    {
        var input = "class C { void M() { Foo x = new Foo(); } }";
        var expected = "class C { void M() { var x = new Foo(); } }";

        Assert.AreEqual(expected, _converter.UseVarWhenApparent(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void SkipsMethodInvocation()
    {
        var input = "class C { void M() { Foo x = GetFoo(); } }";

        Assert.AreEqual(input, _converter.UseVarWhenApparent(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void SkipsLiteral()
    {
        var input = "class C { void M() { int x = 5; } }";

        Assert.AreEqual(input, _converter.UseVarWhenApparent(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void SkipsWhenDeclaredTypeDiffersFromCreatedType()
    {
        var input = "class C { void M() { IFoo x = new Foo(); } }";

        Assert.AreEqual(input, _converter.UseVarWhenApparent(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void ConvertsCastWithMatchingType()
    {
        var input = "class C { void M(object o) { Foo x = (Foo)o; } }";
        var expected = "class C { void M(object o) { var x = (Foo)o; } }";

        Assert.AreEqual(expected, _converter.UseVarWhenApparent(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void ConvertsArrayCreationWithMatchingElementType()
    {
        var input = "class C { void M() { int[] a = new int[3]; } }";
        var expected = "class C { void M() { var a = new int[3]; } }";

        Assert.AreEqual(expected, _converter.UseVarWhenApparent(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void SkipsAlreadyVar()
    {
        var input = "class C { void M() { var x = new Foo(); } }";

        Assert.AreEqual(input, _converter.UseVarWhenApparent(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void SkipsFieldDeclaration()
    {
        var input = "class C { private Foo _x = new Foo(); }";

        Assert.AreEqual(input, _converter.UseVarWhenApparent(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void PreservesUnrelatedCode()
    {
        var input = "class C { void M() { Foo x = new Foo(); int y = 5; var z = GetFoo(); } }";
        var expected = "class C { void M() { var x = new Foo(); int y = 5; var z = GetFoo(); } }";

        Assert.AreEqual(expected, _converter.UseVarWhenApparent(input));
    }
}
