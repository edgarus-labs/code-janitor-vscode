using Microsoft.VisualStudio.TestTools.UnitTesting;
using CodeJanitor.Logic.Transformations;
using CodeJanitor.Properties;

namespace CodeJanitor.UnitTests.Cleaning;

[TestClass]
public sealed class BlankLinePaddingConverterTests
{
    private BlankLinePaddingConverter _converter;

    [TestInitialize]
    public void TestInitialize()
    {
        _converter = new BlankLinePaddingConverter();
        DisableAllSettings();
    }

    [TestCleanup]
    public void TestCleanup()
    {
        DisableAllSettings();
    }

    [TestMethod]
    public void DoesNotSeparateDocumentationCommentFromItsMember()
    {
        Settings.Default.Cleaning_InsertBlankLinePaddingBeforeMethods = true;

        var source = "class C\r\n{\r\n    int _x;\r\n    /// <summary>\r\n    /// Does a thing.\r\n    /// </summary>\r\n    void M() { }\r\n}\r\n";

        var result = _converter.Apply(source);

        Assert.IsFalse(result.Contains("/// </summary>\r\n\r\n    void M()"), "A blank line was inserted between the doc comment and the method.");
        StringAssert.Contains(result, "int _x;\r\n\r\n    /// <summary>");
    }

    private static void DisableAllSettings()
    {
        Settings.Default.Cleaning_InsertBlankLinePaddingBeforeClasses = false;
        Settings.Default.Cleaning_InsertBlankLinePaddingAfterClasses = false;
        Settings.Default.Cleaning_InsertBlankLinePaddingBeforeDelegates = false;
        Settings.Default.Cleaning_InsertBlankLinePaddingAfterDelegates = false;
        Settings.Default.Cleaning_InsertBlankLinePaddingBeforeEnumerations = false;
        Settings.Default.Cleaning_InsertBlankLinePaddingAfterEnumerations = false;
        Settings.Default.Cleaning_InsertBlankLinePaddingBeforeEvents = false;
        Settings.Default.Cleaning_InsertBlankLinePaddingAfterEvents = false;
        Settings.Default.Cleaning_InsertBlankLinePaddingBeforeFieldsSingleLine = false;
        Settings.Default.Cleaning_InsertBlankLinePaddingAfterFieldsSingleLine = false;
        Settings.Default.Cleaning_InsertBlankLinePaddingBeforeFieldsMultiLine = false;
        Settings.Default.Cleaning_InsertBlankLinePaddingAfterFieldsMultiLine = false;
        Settings.Default.Cleaning_InsertBlankLinePaddingBeforeInterfaces = false;
        Settings.Default.Cleaning_InsertBlankLinePaddingAfterInterfaces = false;
        Settings.Default.Cleaning_InsertBlankLinePaddingBeforeMethods = false;
        Settings.Default.Cleaning_InsertBlankLinePaddingAfterMethods = false;
        Settings.Default.Cleaning_InsertBlankLinePaddingBeforeNamespaces = false;
        Settings.Default.Cleaning_InsertBlankLinePaddingAfterNamespaces = false;
        Settings.Default.Cleaning_InsertBlankLinePaddingBeforePropertiesSingleLine = false;
        Settings.Default.Cleaning_InsertBlankLinePaddingAfterPropertiesSingleLine = false;
        Settings.Default.Cleaning_InsertBlankLinePaddingBeforePropertiesMultiLine = false;
        Settings.Default.Cleaning_InsertBlankLinePaddingAfterPropertiesMultiLine = false;
        Settings.Default.Cleaning_InsertBlankLinePaddingBeforeRegionTags = false;
        Settings.Default.Cleaning_InsertBlankLinePaddingAfterRegionTags = false;
        Settings.Default.Cleaning_InsertBlankLinePaddingBeforeEndRegionTags = false;
        Settings.Default.Cleaning_InsertBlankLinePaddingAfterEndRegionTags = false;
        Settings.Default.Cleaning_InsertBlankLinePaddingBeforeStructs = false;
        Settings.Default.Cleaning_InsertBlankLinePaddingAfterStructs = false;
        Settings.Default.Cleaning_InsertBlankLinePaddingBeforeUsingStatementBlocks = false;
        Settings.Default.Cleaning_InsertBlankLinePaddingAfterUsingStatementBlocks = false;
        Settings.Default.Cleaning_InsertBlankLinePaddingBeforeCaseStatements = false;
        Settings.Default.Cleaning_InsertBlankLinePaddingBeforeSingleLineComments = false;
    }

    [TestMethod]
    public void AllSettingsDisabled_ReturnsUnchanged()
    {
        var source = "public class Foo { public void Bar() { } }";
        var result = _converter.Apply(source);
        Assert.AreEqual(source, result);
    }

    [TestMethod]
    public void EmptySource_ReturnsUnchanged()
    {
        var result = _converter.Apply("");
        Assert.AreEqual("", result);
    }

    [TestMethod]
    public void NullSource_ReturnsUnchanged()
    {
        Assert.IsNull(_converter.Apply(null));
    }

    [TestMethod]
    public void BeforeMethod_InsertsBlankLine()
    {
        Settings.Default.Cleaning_InsertBlankLinePaddingBeforeMethods = true;
        var source = "public class Foo\r\n{\r\n    private int _x;\r\n    public void Bar() { }\r\n}\r\n";
        var result = _converter.Apply(source);
        Assert.IsTrue(result.Contains("_x;\r\n\r\n    public void Bar()"), result);
    }

    [TestMethod]
    public void BeforeMethod_AlreadyHasBlankLine_DoesNotDouble()
    {
        Settings.Default.Cleaning_InsertBlankLinePaddingBeforeMethods = true;
        var source = "public class Foo\r\n{\r\n    private int _x;\r\n\r\n    public void Bar() { }\r\n}\r\n";
        var result = _converter.Apply(source);
        // Should not add another blank line
        Assert.IsFalse(result.Contains("_x;\r\n\r\n\r\n    public void Bar()"), result);
    }

    [TestMethod]
    public void AfterMethod_InsertsBlankLine()
    {
        Settings.Default.Cleaning_InsertBlankLinePaddingAfterMethods = true;
        var source = "public class Foo\r\n{\r\n    public void Bar() { }\r\n    private int _x;\r\n}\r\n";
        var result = _converter.Apply(source);
        Assert.IsTrue(result.Contains("{ }\r\n\r\n    private int _x;"), result);
    }

    [TestMethod]
    public void BeforeClass_InsertsBlankLine()
    {
        Settings.Default.Cleaning_InsertBlankLinePaddingBeforeClasses = true;
        var source = "namespace MyNs\r\n{\r\n    public class Foo { }\r\n    public class Bar { }\r\n}\r\n";
        var result = _converter.Apply(source);
        Assert.IsTrue(result.Contains("Foo { }\r\n\r\n    public class Bar"), result);
    }

    [TestMethod]
    public void BeforeClass_AdjacentToOpenBrace_SkipsInsertion()
    {
        Settings.Default.Cleaning_InsertBlankLinePaddingBeforeClasses = true;
        // Class at start of namespace body (right after {)
        var source = "namespace MyNs\r\n{\r\n    public class Foo { }\r\n}\r\n";
        var result = _converter.Apply(source);
        // Should not insert before Foo (adjacent to opening brace of namespace)
        Assert.IsFalse(result.Contains("{\r\n\r\n    public class Foo"), result);
    }

    [TestMethod]
    public void BeforeMethod_AdjacentToOpenBrace_SkipsInsertion()
    {
        Settings.Default.Cleaning_InsertBlankLinePaddingBeforeMethods = true;
        var source = "public class Foo\r\n{\r\n    public void Bar() { }\r\n}\r\n";
        var result = _converter.Apply(source);
        // Method is first in class (after {), should not insert blank
        Assert.IsFalse(result.Contains("{\r\n\r\n    public void Bar()"), result);
    }

    [TestMethod]
    public void BeforeProperty_SingleLine_InsertsBlankLine()
    {
        Settings.Default.Cleaning_InsertBlankLinePaddingBeforePropertiesSingleLine = true;
        var source = "public class Foo\r\n{\r\n    private int _x;\r\n    public int X { get; set; }\r\n}\r\n";
        var result = _converter.Apply(source);
        Assert.IsTrue(result.Contains("_x;\r\n\r\n    public int X"), result);
    }

    [TestMethod]
    public void BeforeEnum_InsertsBlankLine()
    {
        Settings.Default.Cleaning_InsertBlankLinePaddingBeforeEnumerations = true;
        var source = "public class Foo { }\r\npublic enum Bar { A, B }\r\n";
        var result = _converter.Apply(source);
        Assert.IsTrue(result.Contains("{ }\r\n\r\npublic enum Bar"), result);
    }

    [TestMethod]
    public void BeforeStruct_InsertsBlankLine()
    {
        Settings.Default.Cleaning_InsertBlankLinePaddingBeforeStructs = true;
        var source = "public class Foo { }\r\npublic struct Bar { }\r\n";
        var result = _converter.Apply(source);
        Assert.IsTrue(result.Contains("{ }\r\n\r\npublic struct Bar"), result);
    }

    [TestMethod]
    public void BeforeInterface_InsertsBlankLine()
    {
        Settings.Default.Cleaning_InsertBlankLinePaddingBeforeInterfaces = true;
        var source = "public class Foo { }\r\npublic interface IBar { }\r\n";
        var result = _converter.Apply(source);
        Assert.IsTrue(result.Contains("{ }\r\n\r\npublic interface IBar"), result);
    }

    [TestMethod]
    public void BeforeRegionTag_InsertsBlankLine()
    {
        Settings.Default.Cleaning_InsertBlankLinePaddingBeforeRegionTags = true;
        var source = "public class Foo\r\n{\r\n    private int _x;\r\n    #region Methods\r\n    public void Bar() { }\r\n    #endregion\r\n}\r\n";
        var result = _converter.Apply(source);
        Assert.IsTrue(result.Contains("_x;\r\n\r\n    #region Methods"), result);
    }

    [TestMethod]
    public void AfterEndRegionTag_InsertsBlankLine()
    {
        Settings.Default.Cleaning_InsertBlankLinePaddingAfterEndRegionTags = true;
        var source = "public class Foo\r\n{\r\n    #region Fields\r\n    private int _x;\r\n    #endregion\r\n    public void Bar() { }\r\n}\r\n";
        var result = _converter.Apply(source);
        Assert.IsTrue(result.Contains("#endregion\r\n\r\n    public void Bar()"), result);
    }

    [TestMethod]
    public void PreservesNewlineStyle_Unix()
    {
        Settings.Default.Cleaning_InsertBlankLinePaddingBeforeMethods = true;
        var source = "public class Foo\n{\n    private int _x;\n    public void Bar() { }\n}\n";
        var result = _converter.Apply(source);
        Assert.IsTrue(result.Contains("_x;\n\n    public void Bar()"), result);
    }
}
