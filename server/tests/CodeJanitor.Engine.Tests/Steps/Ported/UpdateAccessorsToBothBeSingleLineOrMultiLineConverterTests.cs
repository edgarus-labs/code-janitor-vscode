#nullable disable
using System.Text.RegularExpressions;
using CodeJanitor.Engine.Commands;
using CodeJanitor.Engine.Steps.Transformations;
using Xunit;
using Assert = CodeJanitor.Engine.Tests.Steps.Support.MsAssert;
using VsSettings = CodeJanitor.Engine.Tests.Steps.Support.VsSettings;

namespace CodeJanitor.Engine.Tests.Steps;

public sealed class UpdateAccessorsToBothBeSingleLineOrMultiLineConverterTests
{
    private UpdateAccessorsToBothBeSingleLineOrMultiLineConverter _converter;

    public UpdateAccessorsToBothBeSingleLineOrMultiLineConverterTests()
    {
        _converter = new UpdateAccessorsToBothBeSingleLineOrMultiLineConverter(VsSettings.Default.IsEnabled);
        VsSettings.Default.Cleaning_UpdateAccessorsToBothBeSingleLineOrMultiLine = true;
    }


    [Fact]
    public void SettingDisabled_ReturnsUnchanged()
    {
        VsSettings.Default.Cleaning_UpdateAccessorsToBothBeSingleLineOrMultiLine = false;
        string source = "public class MyClass { public int MyProp { get { return 0; } set { } } }";
        string result = _converter.Apply(source);
        Assert.AreEqual(source, result);
    }

    [Fact]
    public void EmptySource_ReturnsUnchanged()
    {
        string source = "";
        string result = _converter.Apply(source);
        Assert.AreEqual(source, result);
    }

    [Fact]
    public void NullSource_ReturnsUnchanged()
    {
        string result = _converter.Apply(null);
        Assert.IsNull(result);
    }

    [Fact]
    public void ConsistentMultiLineAccessors_ReturnsUnchanged()
    {
        string source = "public class MyClass\r\n{\r\n    public int MyProp\r\n    {\r\n        get\r\n        {\r\n            return 0;\r\n        }\r\n        set\r\n        {\r\n        }\r\n    }\r\n}";
        string result = _converter.Apply(source);
        // Already consistent multi-line, should remain mostly unchanged
        Assert.Contains("public int MyProp", result);
    }

    [Fact]
    public void PropertyWithoutAccessorList_ReturnsUnchanged()
    {
        string source = "public class MyClass { public int MyProp => 0; }";
        string result = _converter.Apply(source);
        // Expression-bodied property should remain unchanged
        Assert.Contains("MyProp", result);
    }

    [Fact]
    public void NoAccessors_ReturnsUnchanged()
    {
        string source = "public class MyClass { }";
        string result = _converter.Apply(source);
        Assert.AreEqual(source, result);
    }

    [Fact]
    public void EventWithSingleAccessor_ReturnsUnchanged()
    {
        string source = "public class MyClass { public event System.EventHandler MyEvent { add { } } }";
        string result = _converter.Apply(source);
        // Events with only add/remove should not be processed if only one present
        Assert.Contains("MyEvent", result);
    }

    [Fact]
    public void PropertyWithSingleLineGetterAndMultiLineSetter_CompressesSetter()
    {
        string source = "public class C { private int _value; public int Value { get { return _value; } set\r\n{\r\n_value = value;\r\n} } }";

        string result = _converter.Apply(source);

        Assert.IsTrue(Regex.IsMatch(result, @"set\s*\{\s*_value\s*=\s*value;\s*\}"));
    }

    [Fact]
    public void PropertyWithMultiLineGetterAndSingleLineSetter_ExpandsSetter()
    {
        string source = "public class C { private int _value; public int Value { get\r\n{\r\nreturn _value;\r\n} set { _value = value; } } }";

        string result = _converter.Apply(source);

        Assert.IsTrue(Regex.IsMatch(result, @"public\s+int\s+Value\s*\{.*get.*set.*\}", RegexOptions.Singleline));
    }

    [Fact]
    public void EventWithInconsistentAccessors_CompressesSecondAccessor()
    {
        string source = "public class C { private System.EventHandler _changed; public event System.EventHandler Changed { add { _changed += value; } remove\r\n{\r\n_changed -= value;\r\n} } }";

        string result = _converter.Apply(source);

        Assert.IsTrue(Regex.IsMatch(result, @"remove\s*\{\s*_changed\s*-=\s*value;\s*\}"));
    }

    [Fact]
    public void AbstractPropertyWithoutAccessorBodies_ReturnsUnchanged()
    {
        string source = "public abstract class C { public abstract int Value { get; set; } }";

        string result = _converter.Apply(source);

        Assert.AreEqual(source, result);
    }

    [Fact]
    public void ExpressionBodiedAccessors_ReturnUnchanged()
    {
        string source = "public class C { private int _value; public int Value { get => _value; set => _value = value; } }";

        string result = _converter.Apply(source);

        Assert.AreEqual(source, result);
    }

    [Fact]
    public void MultiStatementAccessor_IsNotCompressed()
    {
        string source = "public class C { private int _value; public int Value { get { return _value; } set\r\n{\r\n_value = value;\r\nSystem.Console.WriteLine(value);\r\n} } }";

        string result = _converter.Apply(source);

        Assert.Contains("System.Console.WriteLine(value);", result);
        Assert.Contains("set\r\n{", result);
    }

    [Theory]
    [InlineData("class C\r\n{\r\n    event System.Action E\r\n    {\r\n        add { }\r\n        remove { }\r\n    }\r\n}\r\n")]
    [InlineData("class C\r\n{\r\n    event System.Action E\r\n    {\r\n        add\r\n        {\r\n            _e += value;\r\n        }\r\n        remove\r\n        {\r\n            _e -= value;\r\n        }\r\n    }\r\n}\r\n")]
    [InlineData("class C\r\n{\r\n    event System.Action E\r\n    {\r\n        add => _e += value;\r\n        remove\r\n        {\r\n            _e -= value;\r\n        }\r\n    }\r\n}\r\n")]
    [InlineData("class C\r\n{\r\n    int P\r\n    {\r\n        get => _p;\r\n        set\r\n        {\r\n            _p = value;\r\n        }\r\n    }\r\n}\r\n")]
    [InlineData("class C\r\n{\r\n    int P { get; init; }\r\n    int Q { get { return 1; } }\r\n}\r\n")]
    [InlineData("using System;\r\nConsole.WriteLine(new C().P);\r\nclass C\r\n{\r\n    int _p;\r\n    public int P { get { return _p; } set { _p = value; } }\r\n}\r\n")]
    [InlineData("interface I\r\n{\r\n    int P { get; set; }\r\n    event System.Action E;\r\n}\r\n")]
    [InlineData("class C\r\n{\r\n#if NEVER_DEFINED\r\n    int P { get { return 1; } set\r\n    {\r\n    } }\r\n#endif\r\n}\r\n")]
    [InlineData("interface I { event System.Action E; }\r\nclass C : I\r\n{\r\n    event System.Action I.E;\r\n}\r\n")]
    public void AccessorsThatAreAlreadyConsistentOrHaveNoBlockBodies_AreUnchanged(string source) => Assert.AreEqual(source, _converter.Apply(source));

    [Theory]
    [InlineData(
        "class C\r\n{\r\n    int P\r\n    {\r\n        get { return _p; }\r\n        set\r\n        {\r\n            _p = value;\r\n        }\r\n    }\r\n}\r\n",
        "class C\r\n{\r\n    int P\r\n    {\r\n        get { return _p; }\r\n        set { _p = value; }\r\n    }\r\n}\r\n")]
    [InlineData(
        "class C\r\n{\r\n    int P\r\n    {\r\n        get\r\n        {\r\n            return _p;\r\n        }\r\n        set { _p = value; }\r\n    }\r\n}\r\n",
        "class C\r\n{\r\n    int P\r\n    {\r\n        get\r\n        {\r\n            return _p;\r\n        }\r\n        set\r\n        {\r\n            _p = value;\r\n        }\r\n    }\r\n}\r\n")]
    [InlineData(
        "class C\n{\n\tint P\n\t{\n\t\tget\n\t\t{\n\t\t\treturn _p;\n\t\t}\n\t\tprivate set { _p = value; /* keep */ }\n\t}\n}\n",
        "class C\n{\n\tint P\n\t{\n\t\tget\n\t\t{\n\t\t\treturn _p;\n\t\t}\n\t\tprivate set\n\t\t{\n\t\t\t_p = value; /* keep */\n\t\t}\n\t}\n}\n")]
    [InlineData(
        "class C\n{\n    event System.Action E\n    {\n        add { _e += value; }\n        remove\n        {\n            _e -= value;\n        }\n    }\n}\n",
        "class C\n{\n    event System.Action E\n    {\n        add { _e += value; }\n        remove { _e -= value; }\n    }\n}\n")]
    public void InconsistentAccessors_FollowTheFirstAccessorKeepingIndentationAndLineBreaks(string source, string expected) => Assert.AreEqual(expected, _converter.Apply(source));

    [Theory]
    [InlineData("class C\r\n{\r\n    int P\r\n    {\r\n        get { return _p; }\r\n        set\r\n        {\r\n            // store\r\n            _p = value;\r\n        }\r\n    }\r\n}\r\n")]
    [InlineData("class C\r\n{\r\n    int P\r\n    {\r\n        get { return _p; }\r\n        set\r\n        {\r\n            _p = value; // store\r\n        }\r\n    }\r\n}\r\n")]
    [InlineData("class C\r\n{\r\n    int P\r\n    {\r\n        get { return _p; }\r\n        set // store\r\n        {\r\n            _p = value;\r\n        }\r\n    }\r\n}\r\n")]
    [InlineData("class C\r\n{\r\n    int P\r\n    {\r\n        get { return _p; }\r\n        set\r\n        {\r\n            _p = Compute(1,\r\n                2);\r\n        }\r\n    }\r\n}\r\n")]
    public void AccessorsThatCannotBeCompressedWithoutLosingLayout_AreUnchanged(string source) => Assert.AreEqual(source, _converter.Apply(source));

    [Fact]
    public void SingleLineSetterWhoseBodyAlreadyBreaksTheLine_IsNotExpandedIntoABlankLine()
    {
        string source = "class C\r\n{\r\n    int P\r\n    {\r\n        get\r\n        {\r\n            return _p;\r\n        }\r\n        set { _p = value; // keep\r\n        } }\r\n}\r\n";

        string expected = "class C\r\n{\r\n    int P\r\n    {\r\n        get\r\n        {\r\n            return _p;\r\n        }\r\n        set\r\n        {\r\n            _p = value; // keep\r\n        } }\r\n}\r\n";

        Assert.AreEqual(expected, _converter.Apply(source));
    }
}
