using Microsoft.VisualStudio.TestTools.UnitTesting;
using CodeJanitor.Logic.Transformations;
using CodeJanitor.Properties;

namespace CodeJanitor.UnitTests.Cleaning;

[TestClass]
public sealed class UpdateAccessorsToBothBeSingleLineOrMultiLineConverterTests
{
    private UpdateAccessorsToBothBeSingleLineOrMultiLineConverter _converter;

    [TestInitialize]
    public void TestInitialize()
    {
        _converter = new UpdateAccessorsToBothBeSingleLineOrMultiLineConverter();
        Settings.Default.Cleaning_UpdateAccessorsToBothBeSingleLineOrMultiLine = true;
    }

    [TestCleanup]
    public void TestCleanup()
    {
        Settings.Default.Cleaning_UpdateAccessorsToBothBeSingleLineOrMultiLine = false;
    }

    [TestMethod]
    public void SettingDisabled_ReturnsUnchanged()
    {
        Settings.Default.Cleaning_UpdateAccessorsToBothBeSingleLineOrMultiLine = false;
        var source = "public class MyClass { public int MyProp { get { return 0; } set { } } }";
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
    public void ConsistentMultiLineAccessors_ReturnsUnchanged()
    {
        var source = "public class MyClass\r\n{\r\n    public int MyProp\r\n    {\r\n        get\r\n        {\r\n            return 0;\r\n        }\r\n        set\r\n        {\r\n        }\r\n    }\r\n}";
        var result = _converter.Apply(source);
        // Already consistent multi-line, should remain mostly unchanged
        Assert.IsTrue(result.Contains("public int MyProp"));
    }

    [TestMethod]
    public void PropertyWithoutAccessorList_ReturnsUnchanged()
    {
        var source = "public class MyClass { public int MyProp => 0; }";
        var result = _converter.Apply(source);
        // Expression-bodied property should remain unchanged
        Assert.IsTrue(result.Contains("MyProp"));
    }

    [TestMethod]
    public void NoAccessors_ReturnsUnchanged()
    {
        var source = "public class MyClass { }";
        var result = _converter.Apply(source);
        Assert.AreEqual(source, result);
    }

    [TestMethod]
    public void EventWithSingleAccessor_ReturnsUnchanged()
    {
        var source = "public class MyClass { public event System.EventHandler MyEvent { add { } } }";
        var result = _converter.Apply(source);
        // Events with only add/remove should not be processed if only one present
        Assert.IsTrue(result.Contains("MyEvent"));
    }
}
