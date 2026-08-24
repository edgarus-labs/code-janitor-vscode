using Microsoft.VisualStudio.TestTools.UnitTesting;
using CodeJanitor.Logic.Transformations;
using CodeJanitor.Properties;

namespace CodeJanitor.UnitTests.Cleaning;

[TestClass]
public sealed class UpdateSingleLineMethodsConverterTests
{
    private UpdateSingleLineMethodsConverter _converter;

    [TestInitialize]
    public void TestInitialize()
    {
        _converter = new UpdateSingleLineMethodsConverter();
        Settings.Default.Cleaning_UpdateSingleLineMethods = true;
    }

    [TestCleanup]
    public void TestCleanup()
    {
        Settings.Default.Cleaning_UpdateSingleLineMethods = false;
    }

    [TestMethod]
    public void SettingDisabled_ReturnsUnchanged()
    {
        Settings.Default.Cleaning_UpdateSingleLineMethods = false;
        var source = "public class MyClass { public void MyMethod() { return; } }";
        var result = _converter.Apply(source);
        Assert.AreEqual(source, result);
    }

    [TestMethod]
    public void EmptySource_ReturnsUnchanged()
    {
        var source = "";
        var result = _converter.Apply(source);
        Assert.AreEqual(source, result);
    }

    [TestMethod]
    public void NullSource_ReturnsUnchanged()
    {
        var result = _converter.Apply(null);
        Assert.IsNull(result);
    }

    [TestMethod]
    public void MultiLineMethod_ReturnsUnchanged()
    {
        var source = "public class MyClass\r\n{\r\n    public void MyMethod()\r\n    {\r\n        return;\r\n    }\r\n}";
        var result = _converter.Apply(source);
        // Multi-line methods should not be affected
        Assert.IsTrue(result.Contains("public void MyMethod()"));
    }

    [TestMethod]
    public void NoMethods_ReturnsUnchanged()
    {
        var source = "public class MyClass { }";
        var result = _converter.Apply(source);
        Assert.IsTrue(result.Contains("public class MyClass"));
    }

    [TestMethod]
    public void AbstractMethod_ReturnsUnchanged()
    {
        var source = "public abstract class MyClass { public abstract void MyMethod(); }";
        var result = _converter.Apply(source);
        // Abstract methods should not be spread
        Assert.IsTrue(result.Contains("public abstract void MyMethod()"));
    }

    [TestMethod]
    public void InterfaceMethod_ReturnsUnchanged()
    {
        var source = "public interface IMyInterface { void MyMethod(); }";
        var result = _converter.Apply(source);
        // Interface methods should not be spread
        Assert.IsTrue(result.Contains("void MyMethod()"));
    }
}
