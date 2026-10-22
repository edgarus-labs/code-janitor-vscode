#nullable disable
using CodeJanitor.Engine.Commands;
using CodeJanitor.Engine.Steps.Transformations;
using Xunit;
using Assert = CodeJanitor.Engine.Tests.Steps.Support.MsAssert;
using VsSettings = CodeJanitor.Engine.Tests.Steps.Support.VsSettings;

namespace CodeJanitor.Engine.Tests.Steps;

public sealed class BlankLinePaddingConverterTests
{
    private BlankLinePaddingConverter _converter;

    public BlankLinePaddingConverterTests()
    {
        _converter = new BlankLinePaddingConverter(VsSettings.Default.IsEnabled);
        DisableAllSettings();
    }


    [Fact]
    public void DoesNotSeparateDocumentationCommentFromItsMember()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeMethods = true;

        string source = "class C\r\n{\r\n    int _x;\r\n    /// <summary>\r\n    /// Does a thing.\r\n    /// </summary>\r\n    void M() { }\r\n}\r\n";

        string result = _converter.Apply(source);

        Assert.DoesNotContain("/// </summary>\r\n\r\n    void M()", result, "A blank line was inserted between the doc comment and the method.");
        Assert.Contains("int _x;\r\n\r\n    /// <summary>", result);
    }

    private static void DisableAllSettings()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeClasses = false;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterClasses = false;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeDelegates = false;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterDelegates = false;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeEnumerations = false;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterEnumerations = false;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeEvents = false;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterEvents = false;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeFieldsSingleLine = false;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterFieldsSingleLine = false;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeFieldsMultiLine = false;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterFieldsMultiLine = false;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeInterfaces = false;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterInterfaces = false;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeMethods = false;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterMethods = false;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeNamespaces = false;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterNamespaces = false;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforePropertiesSingleLine = false;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterPropertiesSingleLine = false;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforePropertiesMultiLine = false;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterPropertiesMultiLine = false;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeRegionTags = false;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterRegionTags = false;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeEndRegionTags = false;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterEndRegionTags = false;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeStructs = false;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterStructs = false;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeUsingStatementBlocks = false;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterUsingStatementBlocks = false;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeCaseStatements = false;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeSingleLineComments = false;
    }

    [Fact]
    public void AllSettingsDisabled_ReturnsUnchanged()
    {
        string source = "public class Foo { public void Bar() { } }";
        string result = _converter.Apply(source);
        Assert.AreEqual(source, result);
    }

    [Fact]
    public void EmptySource_ReturnsUnchanged()
    {
        string result = _converter.Apply("");
        Assert.AreEqual("", result);
    }

    [Fact]
    public void NullSource_ReturnsUnchanged() => Assert.IsNull(_converter.Apply(null));

    [Fact]
    public void BeforeMethod_InsertsBlankLine()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeMethods = true;
        string source = "public class Foo\r\n{\r\n    private int _x;\r\n    public void Bar() { }\r\n}\r\n";
        string result = _converter.Apply(source);
        Assert.Contains("_x;\r\n\r\n    public void Bar()", result, result);
    }

    [Fact]
    public void BeforeMethod_AlreadyHasBlankLine_DoesNotDouble()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeMethods = true;
        string source = "public class Foo\r\n{\r\n    private int _x;\r\n\r\n    public void Bar() { }\r\n}\r\n";
        string result = _converter.Apply(source);
        // Should not add another blank line
        Assert.DoesNotContain("_x;\r\n\r\n\r\n    public void Bar()", result, result);
    }

    [Fact]
    public void AfterMethod_InsertsBlankLine()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterMethods = true;
        string source = "public class Foo\r\n{\r\n    public void Bar() { }\r\n    private int _x;\r\n}\r\n";
        string result = _converter.Apply(source);
        Assert.Contains("{ }\r\n\r\n    private int _x;", result, result);
    }

    [Fact]
    public void BeforeClass_InsertsBlankLine()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeClasses = true;
        string source = "namespace MyNs\r\n{\r\n    public class Foo { }\r\n    public class Bar { }\r\n}\r\n";
        string result = _converter.Apply(source);
        Assert.Contains("Foo { }\r\n\r\n    public class Bar", result, result);
    }

    [Fact]
    public void BeforeClass_AdjacentToOpenBrace_SkipsInsertion()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeClasses = true;
        // Class at start of namespace body (right after {)
        string source = "namespace MyNs\r\n{\r\n    public class Foo { }\r\n}\r\n";
        string result = _converter.Apply(source);
        // Should not insert before Foo (adjacent to opening brace of namespace)
        Assert.DoesNotContain("{\r\n\r\n    public class Foo", result, result);
    }

    [Fact]
    public void BeforeMethod_AdjacentToOpenBrace_SkipsInsertion()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeMethods = true;
        string source = "public class Foo\r\n{\r\n    public void Bar() { }\r\n}\r\n";
        string result = _converter.Apply(source);
        // Method is first in class (after {), should not insert blank
        Assert.DoesNotContain("{\r\n\r\n    public void Bar()", result, result);
    }

    [Fact]
    public void BeforeProperty_SingleLine_InsertsBlankLine()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforePropertiesSingleLine = true;
        string source = "public class Foo\r\n{\r\n    private int _x;\r\n    public int X { get; set; }\r\n}\r\n";
        string result = _converter.Apply(source);
        Assert.Contains("_x;\r\n\r\n    public int X", result, result);
    }

    [Fact]
    public void BeforeEnum_InsertsBlankLine()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeEnumerations = true;
        string source = "public class Foo { }\r\npublic enum Bar { A, B }\r\n";
        string result = _converter.Apply(source);
        Assert.Contains("{ }\r\n\r\npublic enum Bar", result, result);
    }

    [Fact]
    public void BeforeStruct_InsertsBlankLine()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeStructs = true;
        string source = "public class Foo { }\r\npublic struct Bar { }\r\n";
        string result = _converter.Apply(source);
        Assert.Contains("{ }\r\n\r\npublic struct Bar", result, result);
    }

    [Fact]
    public void BeforeInterface_InsertsBlankLine()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeInterfaces = true;
        string source = "public class Foo { }\r\npublic interface IBar { }\r\n";
        string result = _converter.Apply(source);
        Assert.Contains("{ }\r\n\r\npublic interface IBar", result, result);
    }

    [Fact]
    public void BeforeRegionTag_InsertsBlankLine()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeRegionTags = true;
        string source = "public class Foo\r\n{\r\n    private int _x;\r\n    #region Methods\r\n    public void Bar() { }\r\n    #endregion\r\n}\r\n";
        string result = _converter.Apply(source);
        Assert.Contains("_x;\r\n\r\n    #region Methods", result, result);
    }

    [Fact]
    public void AfterEndRegionTag_InsertsBlankLine()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterEndRegionTags = true;
        string source = "public class Foo\r\n{\r\n    #region Fields\r\n    private int _x;\r\n    #endregion\r\n    public void Bar() { }\r\n}\r\n";
        string result = _converter.Apply(source);
        Assert.Contains("#endregion\r\n\r\n    public void Bar()", result, result);
    }

    [Fact]
    public void PreservesNewlineStyle_Unix()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeMethods = true;
        string source = "public class Foo\n{\n    private int _x;\n    public void Bar() { }\n}\n";
        string result = _converter.Apply(source);
        Assert.Contains("_x;\n\n    public void Bar()", result, result);
    }

    [Fact]
    public void Name_DescribesTheCleanup() => Assert.AreEqual("Insert blank line padding", _converter.Name);

    [Theory]
    [InlineData("BeforeClasses", "enum E { A }\nclass C { }", "enum E { A }\n\nclass C { }")]
    [InlineData("AfterClasses", "class C { }\nenum E { A }", "class C { }\n\nenum E { A }")]
    [InlineData("BeforeDelegates", "class C { }\ndelegate void D();", "class C { }\n\ndelegate void D();")]
    [InlineData("AfterDelegates", "delegate void D();\nclass C { }", "delegate void D();\n\nclass C { }")]
    [InlineData("BeforeEnumerations", "class C { }\nenum E { A }", "class C { }\n\nenum E { A }")]
    [InlineData("AfterEnumerations", "enum E { A }\nclass C { }", "enum E { A }\n\nclass C { }")]
    [InlineData("BeforeEvents", "class C\n{\n    int a;\n    event System.Action E;\n}", "class C\n{\n    int a;\n\n    event System.Action E;\n}")]
    [InlineData("AfterEvents", "class C\n{\n    event System.Action E { add { } remove { } }\n    int a;\n}", "class C\n{\n    event System.Action E { add { } remove { } }\n\n    int a;\n}")]
    [InlineData("BeforeFieldsSingleLine", "class C\n{\n    void M() { }\n    int a;\n}", "class C\n{\n    void M() { }\n\n    int a;\n}")]
    [InlineData("AfterFieldsSingleLine", "class C\n{\n    int a;\n    void M() { }\n}", "class C\n{\n    int a;\n\n    void M() { }\n}")]
    [InlineData("BeforeFieldsMultiLine", "class C\n{\n    void M() { }\n    int[] a =\n        { 1 };\n}", "class C\n{\n    void M() { }\n\n    int[] a =\n        { 1 };\n}")]
    [InlineData("AfterFieldsMultiLine", "class C\n{\n    int[] a =\n        { 1 };\n    void M() { }\n}", "class C\n{\n    int[] a =\n        { 1 };\n\n    void M() { }\n}")]
    [InlineData("BeforeInterfaces", "class C { }\ninterface I { }", "class C { }\n\ninterface I { }")]
    [InlineData("AfterInterfaces", "interface I { }\nclass C { }", "interface I { }\n\nclass C { }")]
    [InlineData("BeforeMethods", "class C\n{\n    int a;\n    void M() { }\n}", "class C\n{\n    int a;\n\n    void M() { }\n}")]
    [InlineData("AfterMethods", "class C\n{\n    void M() { }\n    int a;\n}", "class C\n{\n    void M() { }\n\n    int a;\n}")]
    [InlineData("BeforeNamespaces", "using System;\nnamespace N { }", "using System;\n\nnamespace N { }")]
    [InlineData("AfterNamespaces", "namespace N { }\nnamespace M { }", "namespace N { }\n\nnamespace M { }")]
    [InlineData("BeforePropertiesSingleLine", "class C\n{\n    int a;\n    int P { get; }\n}", "class C\n{\n    int a;\n\n    int P { get; }\n}")]
    [InlineData("AfterPropertiesSingleLine", "class C\n{\n    int P { get; }\n    int a;\n}", "class C\n{\n    int P { get; }\n\n    int a;\n}")]
    [InlineData("BeforePropertiesMultiLine", "class C\n{\n    int a;\n    int P\n    {\n        get { return 1; }\n    }\n}", "class C\n{\n    int a;\n\n    int P\n    {\n        get { return 1; }\n    }\n}")]
    [InlineData("AfterPropertiesMultiLine", "class C\n{\n    int P\n    {\n        get { return 1; }\n    }\n    int a;\n}", "class C\n{\n    int P\n    {\n        get { return 1; }\n    }\n\n    int a;\n}")]
    [InlineData("BeforeRegionTags", "class C\n{\n    int a;\n    #region R\n    int b;\n    #endregion\n    int c;\n}", "class C\n{\n    int a;\n\n    #region R\n    int b;\n    #endregion\n    int c;\n}")]
    [InlineData("AfterRegionTags", "class C\n{\n    int a;\n    #region R\n    int b;\n    #endregion\n    int c;\n}", "class C\n{\n    int a;\n    #region R\n\n    int b;\n    #endregion\n    int c;\n}")]
    [InlineData("BeforeEndRegionTags", "class C\n{\n    int a;\n    #region R\n    int b;\n    #endregion\n    int c;\n}", "class C\n{\n    int a;\n    #region R\n    int b;\n\n    #endregion\n    int c;\n}")]
    [InlineData("AfterEndRegionTags", "class C\n{\n    int a;\n    #region R\n    int b;\n    #endregion\n    int c;\n}", "class C\n{\n    int a;\n    #region R\n    int b;\n    #endregion\n\n    int c;\n}")]
    [InlineData("BeforeStructs", "class C { }\nstruct S { }", "class C { }\n\nstruct S { }")]
    [InlineData("AfterStructs", "struct S { }\nclass C { }", "struct S { }\n\nclass C { }")]
    [InlineData("BeforeUsingStatementBlocks", "// header\nusing System;\nclass C { }", "// header\n\nusing System;\nclass C { }")]
    [InlineData("AfterUsingStatementBlocks", "using System;\nclass C { }", "using System;\n\nclass C { }")]
    [InlineData("BeforeCaseStatements", "switch (x)\n{\n    case 1:\n        break;\n    default:\n        return;\n}", "switch (x)\n{\n    case 1:\n        break;\n\n    default:\n        return;\n}")]
    [InlineData("BeforeSingleLineComments", "int a = 1;\n// note\nint b = 2;", "int a = 1;\n\n// note\nint b = 2;")]
    public void EachSetting_OnItsOwn_PadsOnlyItsConstruct(string setting, string source, string expected)
    {
        VsSettings.Default["Cleaning_InsertBlankLinePadding" + setting] = true;

        Assert.AreEqual(expected, _converter.Apply(source));
    }

    [Fact]
    public void TopLevelStatementsFile_PadsTypesAfterTheStatements_AndLeavesStatementsAndLocalFunctionsAlone()
    {
        EnableAllBeforeSettings();
        string source =
            "using System;\r\n" +
            "\r\n" +
            "Console.WriteLine(\"hi\");\r\n" +
            "static int Local() => 1;\r\n" +
            "Console.WriteLine(Local());\r\n" +
            "class Foo\r\n" +
            "{\r\n" +
            "    int _a;\r\n" +
            "    void M() { }\r\n" +
            "}\r\n" +
            "record R(int X);\r\n";
        string expected =
            "using System;\r\n" +
            "\r\n" +
            "Console.WriteLine(\"hi\");\r\n" +
            "static int Local() => 1;\r\n" +
            "Console.WriteLine(Local());\r\n" +
            "\r\n" +
            "class Foo\r\n" +
            "{\r\n" +
            "    int _a;\r\n" +
            "\r\n" +
            "    void M() { }\r\n" +
            "}\r\n" +
            "\r\n" +
            "record R(int X);\r\n";

        Assert.AreEqual(expected, _converter.Apply(source));
    }

    [Fact]
    public void FileScopedNamespace_BeforePaddingSeparatesItFromTheUsings()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeNamespaces = true;
        string source = "using System;\r\nnamespace N;\r\n\r\nclass C { }\r\n";

        Assert.AreEqual("using System;\r\n\r\nnamespace N;\r\n\r\nclass C { }\r\n", _converter.Apply(source));
    }

    [Fact]
    public void MultiLineDocumentationComment_PaddingGoesAboveTheComment()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeClasses = true;
        string source = "int x = 1;\n/** <summary>C</summary> */\nclass C { }\n";

        Assert.AreEqual("int x = 1;\n\n/** <summary>C</summary> */\nclass C { }\n", _converter.Apply(source));
    }

    [Fact]
    public void Attributes_PaddingGoesAboveTheAttributeList()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeMethods = true;
        string source = "class C\n{\n    int _x;\n    [System.Obsolete]\n    void M() { }\n}\n";

        Assert.AreEqual("class C\n{\n    int _x;\n\n    [System.Obsolete]\n    void M() { }\n}\n", _converter.Apply(source));
    }

    [Fact]
    public void BeforeAndAfterBetweenTwoMembers_InsertsASingleBlankLine()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeMethods = true;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterMethods = true;
        string source = "class C\n{\n    void A() { }\n    void B() { }\n}\n";

        Assert.AreEqual("class C\n{\n    void A() { }\n\n    void B() { }\n}\n", _converter.Apply(source));
    }

    [Theory]
    [InlineData("class C\n{\n    void M() { }\n}\n")]
    [InlineData("class C\n{\n    void M() { }\n} // end of C\n")]
    [InlineData("class C\n{\n    void M() { }\n};\n")]
    public void AfterPadding_IsNotInsertedBeforeAClosingBrace(string source)
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterMethods = true;

        Assert.AreEqual(source, _converter.Apply(source));
    }

    [Fact]
    public void BeforePadding_IsNotInsertedAfterALineEndingWithAnOpeningBrace()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeFieldsSingleLine = true;
        string source = "class C {\n    int a;\n}\n";

        Assert.AreEqual(source, _converter.Apply(source));
    }

    [Fact]
    public void CarriageReturnOnlyLineBreaks_ArePreserved()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeMethods = true;
        string source = "class C\r{\r    int _x;\r    void M() { }\r}\r";

        Assert.AreEqual("class C\r{\r    int _x;\r\r    void M() { }\r}\r", _converter.Apply(source));
    }

    [Fact]
    public void TabIndentation_IsPreserved()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeMethods = true;
        string source = "class C\r\n{\r\n\tint a;\r\n\tvoid M() { }\r\n}\r\n";

        Assert.AreEqual("class C\r\n{\r\n\tint a;\r\n\r\n\tvoid M() { }\r\n}\r\n", _converter.Apply(source));
    }

    [Fact]
    public void DeclarationsInsideDisabledPreprocessorBranches_AreNotPadded()
    {
        EnableAllBeforeSettings();
        string source = "class C\r\n{\r\n    int _x;\r\n#if NEVER_DEFINED\r\n    void M() { }\r\n#endif\r\n}\r\n";

        Assert.AreEqual(source, _converter.Apply(source));
    }

    [Theory]
    [InlineData("var s = @\"\r\nclass X { }\r\n#region R\r\n\";\r\n")]
    [InlineData("var s = \"\"\"\r\n    class X { }\r\n    #region R\r\n    \"\"\";\r\n")]
    [InlineData("var s = $\"\"\"\r\n    void M() { }\r\n    {1}\r\n    \"\"\";\r\n")]
    [InlineData("/*\r\nint a;\r\nvoid M() { }\r\n*/\r\n")]
    public void CodeLikeTextInsideLiteralsAndComments_IsNotPadded(string source)
    {
        EnableAllBeforeSettings();
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeSingleLineComments = false;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeCaseStatements = false;

        Assert.AreEqual(source, _converter.Apply(source));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   \r\n\t\r\n")]
    [InlineData("class C { }")]
    public void TrivialFiles_AreUnchanged(string source)
    {
        EnableAllBeforeSettings();
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterClasses = true;

        Assert.AreEqual(source, _converter.Apply(source));
    }

    [Fact]
    public void FileWithSyntaxErrors_OnlyAddsBlankLines_AndLosesNoText()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeMethods = true;
        string source = "class C\r\n{\r\n    int a\r\n    void M( { }\r\n";

        string result = _converter.Apply(source);

        Assert.AreEqual(source, result.Replace("\r\n\r\n", "\r\n"));
    }

    [Theory]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public void CombinedSettings_ArePaddedIdempotently(bool before, bool after)
    {
        if (before)
        {
            EnableAllBeforeSettings();
        }

        if (after)
        {
            EnableAllAfterSettings();
        }

        string source =
            "// header\r\nusing System;\r\nusing System.Text;\r\nnamespace N\r\n{\r\n    #region Fields\r\n    class C\r\n    {\r\n" +
            "        int a;\r\n        // note\r\n        int b;\r\n        int P { get; }\r\n        void M(int x)\r\n        {\r\n" +
            "            switch (x)\r\n            {\r\n                case 1:\r\n                    break;\r\n" +
            "                default:\r\n                    return;\r\n            }\r\n        }\r\n        event System.Action E;\r\n" +
            "#if true\r\n        int c;\r\n#else\r\n        int d;\r\n#endif\r\n    }\r\n    #endregion\r\n    struct S { }\r\n" +
            "    enum E2 { A }\r\n    delegate void D();\r\n    interface I { }\r\n}\r\n";

        string once = _converter.Apply(source);
        string twice = _converter.Apply(once);

        Assert.AreNotEqual(source, once, "The scenario has to be padded at all.");
        Assert.AreEqual(once, twice, "A second run changed the output:\r\n" + once);
    }

    [Theory]
    [InlineData("BeforeMethods", "class C\n{\n    int a;\n#if true\n    void M() { }\n#endif\n}\n", "class C\n{\n    int a;\n#if true\n    void M() { }\n#endif\n}\n")]
    [InlineData("BeforeMethods", "class C\n{\n    int a;\n#if false\n    int b;\n#else\n    void M() { }\n#endif\n}\n", "class C\n{\n    int a;\n#if false\n    int b;\n#else\n    void M() { }\n#endif\n}\n")]
    [InlineData("BeforeSingleLineComments", "class C\n{\n#if true\n    // c\n    int a;\n#endif\n}\n", "class C\n{\n#if true\n    // c\n    int a;\n#endif\n}\n")]
    [InlineData("AfterMethods", "class C\n{\n#if true\n    void M() { }\n#endif\n    int a;\n}\n", "class C\n{\n#if true\n    void M() { }\n#endif\n    int a;\n}\n")]
    [InlineData("AfterMethods", "class C\n{\n#if true\n    void M() { }\n#else\n    int b;\n#endif\n}\n", "class C\n{\n#if true\n    void M() { }\n#else\n    int b;\n#endif\n}\n")]
    [InlineData("BeforeMethods", "class C\n{\n#if true\n    int a;\n#endif\n    void M() { }\n}\n", "class C\n{\n#if true\n    int a;\n#endif\n\n    void M() { }\n}\n")]
    public void ConditionalDirectives_AreNotSeparatedFromTheCodeTheyEnclose(string setting, string source, string expected)
    {
        VsSettings.Default["Cleaning_InsertBlankLinePadding" + setting] = true;

        Assert.AreEqual(expected, _converter.Apply(source));
    }

    [Fact]
    public void ConstructorsDestructorsOperatorsAndConversions_UseTheMethodSettings()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeMethods = true;
        string source =
            "class C\n{\n    int a;\n    C() { }\n    int b;\n    ~C() { }\n    int c;\n" +
            "    public static C operator +(C x, C y) => x;\n    int d;\n    public static implicit operator int(C x) => 0;\n}\n";
        string expected =
            "class C\n{\n    int a;\n\n    C() { }\n    int b;\n\n    ~C() { }\n    int c;\n\n" +
            "    public static C operator +(C x, C y) => x;\n    int d;\n\n    public static implicit operator int(C x) => 0;\n}\n";

        Assert.AreEqual(expected, _converter.Apply(source));
    }

    [Fact]
    public void IndexersAndEventFields_UseThePropertyAndEventSettings()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforePropertiesSingleLine = true;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeEvents = true;
        string source = "class C\n{\n    int a;\n    int this[int i] => i;\n    int b;\n    event System.Action E;\n}\n";

        Assert.AreEqual("class C\n{\n    int a;\n\n    int this[int i] => i;\n    int b;\n\n    event System.Action E;\n}\n", _converter.Apply(source));
    }

    [Fact]
    public void GenericPartialAsyncMembers_ArePadded()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeMethods = true;
        string source =
            "partial class C<T> where T : class\n{\n    int a;\n" +
            "    async System.Threading.Tasks.Task<T> M<U>() where U : T => await Get<T>();\n}\n";
        string expected =
            "partial class C<T> where T : class\n{\n    int a;\n\n" +
            "    async System.Threading.Tasks.Task<T> M<U>() where U : T => await Get<T>();\n}\n";

        Assert.AreEqual(expected, _converter.Apply(source));
    }

    [Fact]
    public void UsingDirectives_ProgramFileWithGlobalStaticAndAliasUsings_IsPaddedAsOneBlock()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeUsingStatementBlocks = true;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterUsingStatementBlocks = true;
        string source = "// header\r\nglobal using System;\r\nusing static System.Math;\r\nusing X = System.String;\r\nConsole.WriteLine(Abs(-1));\r\n";
        string expected = "// header\r\n\r\nglobal using System;\r\nusing static System.Math;\r\nusing X = System.String;\r\n\r\nConsole.WriteLine(Abs(-1));\r\n";

        Assert.AreEqual(expected, _converter.Apply(source));
    }

    [Fact]
    public void UsingDirectives_InsideANamespace_ArePaddedSeparatelyFromTheOuterBlock()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeUsingStatementBlocks = true;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterUsingStatementBlocks = true;
        string source = "using System;\nnamespace N\n{\n    using A;\n    using B;\n    class C { }\n}\n";

        Assert.AreEqual("using System;\n\nnamespace N\n{\n    using A;\n    using B;\n\n    class C { }\n}\n", _converter.Apply(source));
    }

    [Fact]
    public void UsingDirectives_SeparatedByABlankLine_DoNotGetASecondBlankLine()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeUsingStatementBlocks = true;
        string source = "namespace N\n{\n    using A;\n\n    using B;\n}\n";

        Assert.AreEqual(source, _converter.Apply(source));
    }

    [Fact]
    public void UsingDirectives_OnTheLastLineWithoutLineBreak_AreUnchanged()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterUsingStatementBlocks = true;

        Assert.AreEqual("using System;", _converter.Apply("using System;"));
    }

    [Fact]
    public void UsingStatements_AreNotUsingDirectiveBlocks()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeUsingStatementBlocks = true;
        string source = "class C\n{\n    void M()\n    {\n        Foo();\n        using (var x = Get()) { }\n    }\n}\n";

        Assert.AreEqual(source, _converter.Apply(source));
    }

    [Fact]
    public void RegionTags_AtTheFileEdges_AreOnlyPaddedInward()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeRegionTags = true;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterRegionTags = true;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeEndRegionTags = true;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterEndRegionTags = true;
        string source = "#region A\nclass C { }\n#endregion";

        Assert.AreEqual("#region A\n\nclass C { }\n\n#endregion", _converter.Apply(source));
    }

    [Fact]
    public void EndRegionTag_OnTheFirstLine_IsNotPaddedAbove()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeEndRegionTags = true;
        string source = "#endregion\nclass C { }\n";

        Assert.AreEqual(source, _converter.Apply(source));
    }

    [Fact]
    public void CaseStatements_CrLfSwitchWithReturnValues_IsPadded()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeCaseStatements = true;
        string source = "switch (x)\r\n{\r\n    case 1:\r\n        return 5;\r\n    case 2:\r\n        break;\r\n    default:\r\n        return;\r\n}\r\n";
        string expected = "switch (x)\r\n{\r\n    case 1:\r\n        return 5;\r\n\r\n    case 2:\r\n        break;\r\n\r\n    default:\r\n        return;\r\n}\r\n";

        Assert.AreEqual(expected, _converter.Apply(source));
    }

    [Fact]
    public void CaseStatements_AlreadyPaddedOrFallingThrough_AreUnchanged()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeCaseStatements = true;
        string source = "switch (x)\n{\n    case 1:\n    case 2:\n        break;\n\n    default:\n        break;\n}\n";

        Assert.AreEqual(source, _converter.Apply(source));
    }

    [Theory]
    [InlineData("int a;\n// first\n// second\n", "int a;\n\n// first\n// second\n")]
    [InlineData("void M()\n{\n    // first line of the body\n}\n", "void M()\n{\n    // first line of the body\n}\n")]
    [InlineData("/// <summary>\n// c\n", "/// <summary>\n// c\n")]
    [InlineData("int a;\n/// <summary>x</summary>\nvoid M() { }\n", "int a;\n/// <summary>x</summary>\nvoid M() { }\n")]
    [InlineData("int a;\n\n// c\n", "int a;\n\n// c\n")]
    [InlineData("// c\nint a;\n", "// c\nint a;\n")]
    public void SingleLineComments_LineFeedFile(string source, string expected)
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeSingleLineComments = true;

        Assert.AreEqual(expected, _converter.Apply(source));
    }

    private static void EnableAllAfterSettings()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterClasses = true;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterDelegates = true;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterEnumerations = true;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterEvents = true;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterFieldsSingleLine = true;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterFieldsMultiLine = true;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterInterfaces = true;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterMethods = true;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterNamespaces = true;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterPropertiesSingleLine = true;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterPropertiesMultiLine = true;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterRegionTags = true;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterEndRegionTags = true;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterStructs = true;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterUsingStatementBlocks = true;
    }

    private static void EnableAllBeforeSettings()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeClasses = true;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeDelegates = true;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeEnumerations = true;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeEvents = true;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeFieldsSingleLine = true;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeFieldsMultiLine = true;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeInterfaces = true;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeMethods = true;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeNamespaces = true;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforePropertiesSingleLine = true;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforePropertiesMultiLine = true;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeRegionTags = true;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeEndRegionTags = true;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeStructs = true;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeUsingStatementBlocks = true;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeCaseStatements = true;
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeSingleLineComments = true;
    }

    [Fact]
    public void SingleLineComments_CrLfFile_InsertsACompleteCrLfBlankLine()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeSingleLineComments = true;

        Assert.AreEqual("int a = 1;\r\n\r\n// note\r\nint b = 2;\r\n", _converter.Apply("int a = 1;\r\n// note\r\nint b = 2;\r\n"));
    }

    [Theory]
    [InlineData("BeforeSingleLineComments", "class C\n{\n    string s = @\"a\n// not a comment\n\";\n}\n")]
    [InlineData("BeforeSingleLineComments", "var s = \"\"\"\n    a\n    // not a comment\n    \"\"\";\n")]
    [InlineData("BeforeSingleLineComments", "/*\n text\n// inner\n*/\n")]
    [InlineData("BeforeSingleLineComments", "int x; // first part\n// continued\n")]
    [InlineData("BeforeCaseStatements", "var s = @\"\n    break;\n    case 1:\n\";\n")]
    public void TextThatIsNotARealCommentOrCaseLabel_IsNotPadded(string setting, string source)
    {
        VsSettings.Default["Cleaning_InsertBlankLinePadding" + setting] = true;

        Assert.AreEqual(source, _converter.Apply(source));
    }

    [Theory]
    [InlineData("BeforeMethods", "class C\n{\n    int _x;\n    // Explains M\n    void M() { }\n}\n", "class C\n{\n    int _x;\n\n    // Explains M\n    void M() { }\n}\n")]
    [InlineData("BeforeMethods", "class C\n{\n    int _x;\n    /* Explains M */\n    [System.Obsolete]\n    void M() { }\n}\n", "class C\n{\n    int _x;\n\n    /* Explains M */\n    [System.Obsolete]\n    void M() { }\n}\n")]
    [InlineData("BeforeUsingStatementBlocks", "using A;\n// the B block\nusing B;\n", "using A;\n\n// the B block\nusing B;\n")]
    public void BeforePadding_GoesAboveTheCommentAttachedToTheDeclaration(string setting, string source, string expected)
    {
        VsSettings.Default["Cleaning_InsertBlankLinePadding" + setting] = true;

        Assert.AreEqual(expected, _converter.Apply(source));
    }

    [Theory]
    [InlineData("AfterMethods", "class C\n{\n    void A() { }\n\n    void B() { }\n}\n", "class C\n{\n    void A() { }\n\n    void B() { }\n}\n")]
    [InlineData("AfterUsingStatementBlocks", "namespace N\n{\n    using A;\n\n    using B;\n    class C { }\n}\n", "namespace N\n{\n    using A;\n\n    using B;\n\n    class C { }\n}\n")]
    [InlineData("AfterClasses", "using System;\nConsole.WriteLine(1);\nclass Foo { }\n", "using System;\nConsole.WriteLine(1);\nclass Foo { }\n")]
    [InlineData("AfterNamespaces", "namespace N;\n\nclass C { }\n", "namespace N;\n\nclass C { }\n")]
    public void AfterPadding_IsNotAddedWhereABlankLineOrTheEndOfTheFileFollows(string setting, string source, string expected)
    {
        VsSettings.Default["Cleaning_InsertBlankLinePadding" + setting] = true;

        Assert.AreEqual(expected, _converter.Apply(source));
    }

    [Fact]
    public void MixedLineEndings_PaddingLandsOnTheDeclarationLine()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingBeforeMethods = true;
        string source = "class C\n{\r\n    int _x;\r\n    void M() { }\r\n    int _y;\r\n    int _z;\r\n}\r\n";

        Assert.AreEqual("class C\n{\r\n    int _x;\r\n\r\n    void M() { }\r\n    int _y;\r\n    int _z;\r\n}\r\n", _converter.Apply(source));
    }

    [Fact]
    public void AfterSingleLineField_FollowedByVerbatimStringLines_DoesNotChangeTheString()
    {
        VsSettings.Default.Cleaning_InsertBlankLinePaddingAfterFieldsSingleLine = true;
        string source = "class C\r\n{\r\n    int a; string b = @\"x\r\ny\";\r\n}\r\n";

        Assert.AreEqual(source, _converter.Apply(source));
    }
}
