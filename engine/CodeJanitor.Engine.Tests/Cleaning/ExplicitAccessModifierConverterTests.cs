using CodeJanitor.Logic.Transformations;
using CodeJanitor.Properties;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace CodeJanitor.UnitTests.Cleaning;

[TestClass]
public sealed class ExplicitAccessModifierConverterTests
{
    private ExplicitAccessModifierConverter _converter;

    [TestInitialize]
    public void TestInitialize()
    {
        _converter = new ExplicitAccessModifierConverter();
        Settings.Default.Cleaning_InsertExplicitAccessModifiersOnClasses = true;
        Settings.Default.Cleaning_InsertExplicitAccessModifiersOnDelegates = true;
        Settings.Default.Cleaning_InsertExplicitAccessModifiersOnEnumerations = true;
        Settings.Default.Cleaning_InsertExplicitAccessModifiersOnEvents = true;
        Settings.Default.Cleaning_InsertExplicitAccessModifiersOnFields = true;
        Settings.Default.Cleaning_InsertExplicitAccessModifiersOnInterfaces = true;
        Settings.Default.Cleaning_InsertExplicitAccessModifiersOnMethods = true;
        Settings.Default.Cleaning_InsertExplicitAccessModifiersOnProperties = true;
        Settings.Default.Cleaning_InsertExplicitAccessModifiersOnStructs = true;
    }

    [TestCleanup]
    public void TestCleanup()
    {
        Settings.Default.Cleaning_InsertExplicitAccessModifiersOnClasses = false;
        Settings.Default.Cleaning_InsertExplicitAccessModifiersOnDelegates = false;
        Settings.Default.Cleaning_InsertExplicitAccessModifiersOnEnumerations = false;
        Settings.Default.Cleaning_InsertExplicitAccessModifiersOnEvents = false;
        Settings.Default.Cleaning_InsertExplicitAccessModifiersOnFields = false;
        Settings.Default.Cleaning_InsertExplicitAccessModifiersOnInterfaces = false;
        Settings.Default.Cleaning_InsertExplicitAccessModifiersOnMethods = false;
        Settings.Default.Cleaning_InsertExplicitAccessModifiersOnProperties = false;
        Settings.Default.Cleaning_InsertExplicitAccessModifiersOnStructs = false;
    }

    // ── Top-level types get 'internal' ────────────────────────────────────────

    [TestMethod]
    public void TopLevelClass_WithoutModifier_GetsInternal()
    {
        var source = "namespace N { class Foo { } }";
        var result = _converter.Apply(source);
        StringAssert.Contains(result, "internal class Foo");
    }

    [TestMethod]
    public void TopLevelInterface_WithoutModifier_GetsInternal()
    {
        var source = "namespace N { interface IFoo { } }";
        var result = _converter.Apply(source);
        StringAssert.Contains(result, "internal interface IFoo");
    }

    [TestMethod]
    public void TopLevelEnum_WithoutModifier_GetsInternal()
    {
        var source = "namespace N { enum Color { Red } }";
        var result = _converter.Apply(source);
        StringAssert.Contains(result, "internal enum Color");
    }

    [TestMethod]
    public void TopLevelStruct_WithoutModifier_GetsInternal()
    {
        var source = "namespace N { struct Point { } }";
        var result = _converter.Apply(source);
        StringAssert.Contains(result, "internal struct Point");
    }

    [TestMethod]
    public void TopLevelDelegate_WithoutModifier_GetsInternal()
    {
        var source = "namespace N { delegate void Work(); }";
        var result = _converter.Apply(source);
        StringAssert.Contains(result, "internal delegate void Work");
    }

    // ── Nested types get 'private' ─────────────────────────────────────────────

    [TestMethod]
    public void NestedClass_WithoutModifier_GetsPrivate()
    {
        var source = "class Outer { class Inner { } }";
        var result = _converter.Apply(source);
        StringAssert.Contains(result, "private class Inner");
    }

    [TestMethod]
    public void NestedEnum_WithoutModifier_GetsPrivate()
    {
        var source = "class Outer { enum State { On } }";
        var result = _converter.Apply(source);
        StringAssert.Contains(result, "private enum State");
    }

    // ── Members get 'private' ──────────────────────────────────────────────────

    [TestMethod]
    public void Field_WithoutModifier_GetsPrivate()
    {
        var source = "class Foo { int _x; }";
        var result = _converter.Apply(source);
        StringAssert.Contains(result, "private int _x");
    }

    [TestMethod]
    public void Method_WithoutModifier_GetsPrivate()
    {
        var source = "class Foo { void Bar() { } }";
        var result = _converter.Apply(source);
        StringAssert.Contains(result, "private void Bar");
    }

    [TestMethod]
    public void Property_WithoutModifier_GetsPrivate()
    {
        var source = "class Foo { int Value { get; set; } }";
        var result = _converter.Apply(source);
        StringAssert.Contains(result, "private int Value");
    }

    [TestMethod]
    public void EventField_WithoutModifier_GetsPrivate()
    {
        var source = "class Foo { event System.Action Done; }";
        var result = _converter.Apply(source);
        StringAssert.Contains(result, "private event System.Action Done");
    }

    [TestMethod]
    public void Constructor_WithoutModifier_GetsPrivate()
    {
        var source = "class Foo { Foo() { } }";
        var result = _converter.Apply(source);
        StringAssert.Contains(result, "private Foo()");
    }

    // ── Already-specified modifiers are left alone ─────────────────────────────

    [TestMethod]
    public void PublicClass_IsNotModified()
    {
        var source = "public class Foo { }";
        var result = _converter.Apply(source);
        Assert.AreEqual(source, result);
    }

    [TestMethod]
    public void PublicField_IsNotModified()
    {
        var source = "class Foo { public int X; }";
        var result = _converter.Apply(source);
        StringAssert.Contains(result, "public int X");
        Assert.IsFalse(result.Contains("private int X"));
        Assert.IsFalse(result.Contains("internal int X"));
    }

    // ── Skipped cases ──────────────────────────────────────────────────────────

    [TestMethod]
    public void PartialClass_IsNotModified()
    {
        var source = "partial class Foo { }";
        var result = _converter.Apply(source);
        Assert.AreEqual(source, result);
    }

    [TestMethod]
    public void PartialMethod_IsNotModified()
    {
        var source = "partial class Foo { partial void Bar(); }";
        var result = _converter.Apply(source);
        // partial method should remain unmodified
        Assert.IsFalse(result.Contains("private partial void Bar"));
    }

    [TestMethod]
    public void StaticConstructor_IsNotModified()
    {
        var source = "class Foo { static Foo() { } }";
        var result = _converter.Apply(source);
        // The class itself gets 'internal'; the static ctor must remain modifier-free.
        Assert.IsFalse(result.Contains("private Foo()"));
        Assert.IsFalse(result.Contains("public Foo()"));
        Assert.IsFalse(result.Contains("internal Foo()"));
    }

    [TestMethod]
    public void Destructor_IsNotModified()
    {
        var source = "class Foo { ~Foo() { } }";
        var result = _converter.Apply(source);
        // The class itself gets 'internal'; the destructor must remain modifier-free.
        Assert.IsFalse(result.Contains("private ~Foo"));
        Assert.IsFalse(result.Contains("public ~Foo"));
        Assert.IsFalse(result.Contains("internal ~Foo"));
    }

    [TestMethod]
    public void InterfaceMember_Method_IsNotModified()
    {
        var source = "interface IFoo { void Bar(); }";
        var result = _converter.Apply(source);
        Assert.IsFalse(result.Contains("private void Bar"));
    }

    [TestMethod]
    public void InterfaceMember_Property_IsNotModified()
    {
        var source = "interface IFoo { int Value { get; } }";
        var result = _converter.Apply(source);
        Assert.IsFalse(result.Contains("private int Value"));
    }

    [TestMethod]
    public void ExplicitInterfaceImpl_Method_IsNotModified()
    {
        var source = "class Foo : IFoo { void IFoo.Bar() { } }";
        var result = _converter.Apply(source);
        Assert.IsFalse(result.Contains("private void IFoo.Bar"));
    }

    [TestMethod]
    public void ExplicitInterfaceImpl_Property_IsNotModified()
    {
        var source = "class Foo : IFoo { int IFoo.Value { get; } }";
        var result = _converter.Apply(source);
        Assert.IsFalse(result.Contains("private int IFoo.Value"));
    }

    [TestMethod]
    public void FixedField_IsNotModified()
    {
        var source = "unsafe class Foo { fixed int buf[8]; }";
        var result = _converter.Apply(source);
        Assert.IsFalse(result.Contains("private fixed int buf"));
    }

    // ── Setting disabled ──────────────────────────────────────────────────────

    [TestMethod]
    public void WhenSettingDisabled_FieldIsNotModified()
    {
        Settings.Default.Cleaning_InsertExplicitAccessModifiersOnFields = false;
        var source = "class Foo { int _x; }";
        var result = _converter.Apply(source);
        Assert.IsFalse(result.Contains("private int _x"));
        Assert.IsFalse(result.Contains("public int _x"));
        StringAssert.Contains(result, "int _x");
    }

    [TestMethod]
    public void WhenSettingDisabled_ClassIsNotModified()
    {
        Settings.Default.Cleaning_InsertExplicitAccessModifiersOnClasses = false;
        var source = "class Foo { }";
        var result = _converter.Apply(source);
        Assert.AreEqual(source, result);
    }

    // ── Indentation trivia preserved ──────────────────────────────────────────

    [TestMethod]
    public void IndentationOfClass_IsPreserved()
    {
        var source = "namespace N\r\n{\r\n    class Foo { }\r\n}";
        var result = _converter.Apply(source);
        Assert.IsTrue(result.Contains("    internal class Foo"), result);
    }

    [TestMethod]
    public void IndentationOfField_IsPreserved()
    {
        var source = "class Foo\r\n{\r\n    int _x;\r\n}";
        var result = _converter.Apply(source);
        Assert.IsTrue(result.Contains("    private int _x"), result);
    }

    // ── Record support ─────────────────────────────────────────────────────────

    [TestMethod]
    public void TopLevelRecord_WithoutModifier_GetsInternal()
    {
        var source = "namespace N { record Point(int X, int Y); }";
        var result = _converter.Apply(source);
        StringAssert.Contains(result, "internal record Point");
    }
}
