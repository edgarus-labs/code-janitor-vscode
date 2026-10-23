using CodeJanitor.Engine.Reorganize;
using CodeJanitor.Engine.Tests.Steps.Support;
using Xunit;
using static CodeJanitor.Engine.Tests.Reorganize.ReorganizeHarness;

namespace CodeJanitor.Engine.Tests.Reorganize;

public sealed class ReorganizeTests
{

    // reorganize: ordering members
    [Fact]
    public void OrdersMembersByMemberTypeAndAlphabetizesEachGroup()
    {
        var source = Lines("class C",
          "{",
          "    public void Zeta() { }",
          "    private int _b;",
          "    public C() { }",
          "    private int _a;",
          "    public void Alpha() { }",
          "}",
          "");

        Assert.Equal(Lines("class C", "{", "    private int _a;", "    private int _b;", "    public C() { }", "    public void Alpha() { }", "    public void Zeta() { }", "}", ""), Run(source));
    }

    [Fact]
    public void ReturnsAFileThatIsAlreadyInOrderByteForByte()
    {
        var source = "using System;\r\n\r\nnamespace N\r\n{\r\n\tclass C\r\n\t{\r\n\t\tint _a;   \r\n\r\n\r\n\t\tint _b;\r\n\t\tvoid   A() { }\r\n\t}\r\n}\r\n";

        Assert.Equal(source, Run(source));
    }

    [Fact]
    public void KeepsTheMemberTypeOrderOfEveryKindOfMember()
    {
        var source = Lines("public class C",
          "{",
          "    public class Nested { }",
          "    public struct S { }",
          "    public void M() { }",
          "    public int this[int i] => i;",
          "    public int P { get; set; }",
          "    public interface I { }",
          "    public enum E { A }",
          "    public event System.Action Ev;",
          "    public delegate void D();",
          "    ~C() { }",
          "    public C() { }",
          "    public int F;",
          "}",
          "");

        Assert.Equal(Lines("public class C",
            "{",
            "    public int F;",
            "    public C() { }",
            "    ~C() { }",
            "    public delegate void D();",
            "    public event System.Action Ev;",
            "    public enum E { A }",
            "    public interface I { }",
            "    public int P { get; set; }",
            "    public int this[int i] => i;",
            "    public void M() { }",
            "    public struct S { }",
            "    public class Nested { }",
            "}",
            ""), Run(source));
    }

    [Fact]
    public void OrdersByAccessLevelWithinAMemberTypeAndByStaticBeforeInstance()
    {
        var source = Lines("class C",
          "{",
          "    private void A() { }",
          "    public void B() { }",
          "    protected void C2() { }",
          "    internal void D() { }",
          "    protected internal void E() { }",
          "    public static void F() { }",
          "    void G() { }",
          "}",
          "");

        Assert.Equal(Lines("class C",
            "{",
            "    public static void F() { }",
            "    public void B() { }",
            "    internal void D() { }",
            "    protected internal void E() { }",
            "    protected void C2() { }",
            "    private void A() { }",
            "    void G() { }",
            "}",
            ""), Run(source));
    }

    [Fact]
    public void TreatsAMemberWithoutAModifierAsPrivateInAClassAndPublicInAnInterface()
    {
        var source = "class C\n{\n    void Hidden() { }\n    public void Shown() { }\n}\ninterface I\n{\n    void B();\n    void A();\n}\n";

        Assert.Equal("interface I\n{\n    void A();\n    void B();\n}\nclass C\n{\n    public void Shown() { }\n    void Hidden() { }\n}\n", Run(source));
    }

    [Fact]
    public void HonoursTheReverseAccessOrderAndAccessFirstPrimaryOrder()
    {
        var source = "class C\n{\n    public void B() { }\n    private int _f;\n    private void A() { }\n    public int F;\n}\n";

        Assert.Equal("class C\n{\n    private int _f;\n    public int F;\n    private void A() { }\n    public void B() { }\n}\n", Run(source, new ReorganizeSettings { ReverseOrderByAccessLevel = true }));
        Assert.Equal("class C\n{\n    public int F;\n    public void B() { }\n    private int _f;\n    private void A() { }\n}\n", Run(source, new ReorganizeSettings { PrimaryOrderByAccessLevel = true }));
    }

    [Fact]
    public void KeepsTheSourceOrderInsideAGroupWhenNotAlphabetizing()
    {
        var source = "class C\n{\n    void B() { }\n    int _x;\n    void A() { }\n}\n";

        Assert.Equal("class C\n{\n    int _x;\n    void B() { }\n    void A() { }\n}\n", Run(source, new ReorganizeSettings { AlphabetizeMembersOfTheSameGroup = false }));
    }

    [Fact]
    public void PlacesExplicitInterfaceImplementationsAtTheEndOfTheirGroupOnRequest()
    {
        var source = "class C : I\n{\n    void I.B() { }\n    public void A() { }\n    void I.A2() { }\n    public void C2() { }\n}\n";

        Assert.Equal("class C : I\n{\n    public void A() { }\n    void I.A2() { }\n    void I.B() { }\n    public void C2() { }\n}\n", Run(source));
        Assert.Equal("class C : I\n{\n    public void A() { }\n    public void C2() { }\n    void I.A2() { }\n    void I.B() { }\n}\n", Run(source, new ReorganizeSettings { ExplicitMembersAtEnd = true }));
    }

    [Fact]
    public void SortsMemberTypesThatShareAnOrderTogetherByTheWeightsOfTheVisualStudioComparer()
    {
        var memberTypes = ReorganizeSettings.DefaultMemberTypes();
        memberTypes[MemberTypeKey.Methods] = new MemberTypeSetting(1, "Methods");
        memberTypes[MemberTypeKey.Fields] = new MemberTypeSetting(2, "Members");
        memberTypes[MemberTypeKey.Properties] = new MemberTypeSetting(2, "Members");
        var source = "class C\n{\n    private int C2;\n    private int B { get; set; }\n    private void Z() { }\n    private int A;\n}\n";

        Assert.Equal("class C\n{\n    private void Z() { }\n    private int B { get; set; }\n    private int A;\n    private int C2;\n}\n", Run(source, new ReorganizeSettings { MemberTypes = memberTypes }));
    }

    [Fact]
    public void ReordersFieldsConstantsStaticReadOnlyStaticInstanceReadOnlyInstance()
    {
        var source = "class C\n{\n    int Instance;\n    readonly int InstanceReadOnly;\n    static int StaticField;\n    static readonly int StaticReadOnly;\n    const int Constant = 1;\n}\n";

        Assert.Equal("class C\n{\n    const int Constant = 1;\n    static readonly int StaticReadOnly;\n    static int StaticField;\n    readonly int InstanceReadOnly;\n    int Instance;\n}\n", Run(source));
    }

    [Fact]
    public void OrdersTheTypesOfANamespaceAndRecursesIntoNestedTypes()
    {
        var source = Lines("namespace N",
          "{",
          "    public class B",
          "    {",
          "        public void Y() { }",
          "        public int X;",
          "    }",
          "",
          "    public enum E { Z, A }",
          "    public interface I { }",
          "}",
          "");

        Assert.Equal(Lines("namespace N",
            "{",
            "    public enum E { Z, A }",
            "    public interface I { }",
            "    public class B",
            "    {",
            "        public int X;",
            "        public void Y() { }",
            "    }",
            "}",
            ""), Run(source));
    }

    // reorganize: what travels with a member
    [Fact]
    public void MovesTheCommentsAboveAMemberItsAttributesXMLDocumentationAndTrailingCommentWithIt()
    {
        var source = Lines("class C",
          "{",
          "    // about Run",
          "    public void Run() { }",
          "",
          "    /// <summary>The field.</summary>",
          "    [Obsolete]",
          "    private int _f; // trailing",
          "",
          "    private int _g;",
          "}",
          "");

        Assert.Equal(Lines("class C",
            "{",
            "    /// <summary>The field.</summary>",
            "    [Obsolete]",
            "    private int _f; // trailing",
            "",
            "    private int _g;",
            "    // about Run",
            "    public void Run() { }",
            "}",
            ""), Run(source));
    }

    [Fact]
    public void LeavesACommentSeparatedFromTheNextMemberByABlankLineWhereItIs()
    {
        var source = "class C\n{\n    // ---- helpers ----\n\n    void B() { }\n    void A() { }\n}\n";

        Assert.Equal("class C\n{\n    // ---- helpers ----\n\n    void A() { }\n    void B() { }\n}\n", Run(source));
    }

    [Fact]
    public void KeepsBlockCommentsDirectlyAboveAMemberWithIt()
    {
        var source = "class C\n{\n    /* B does b */\n    void B() { }\n    void A() { }\n}\n";

        Assert.Equal("class C\n{\n    void A() { }\n    /* B does b */\n    void B() { }\n}\n", Run(source));
    }

    [Fact]
    public void MovesXMLDocumentationWithItsMemberEvenIfABlankLineSeparatesThem()
    {
        var line = "class C\n{\n    /// <summary>Does B.</summary>\n\n    void B() { }\n\n    void A() { }\n}\n";
        var block = "class C\n{\n    /** <summary>Does B.</summary> */\n\n    void B() { }\n\n    void A() { }\n}\n";
        var withNote = "class C\n{\n    // ---- helpers ----\n\n    /// <summary>Does B.</summary>\n\n    // note\n\n    void B() { }\n\n    void A() { }\n}\n";

        Assert.Equal("class C\n{\n    void A() { }\n    /// <summary>Does B.</summary>\n\n    void B() { }\n}\n", Run(line));
        Assert.Equal("class C\n{\n    void A() { }\n    /** <summary>Does B.</summary> */\n\n    void B() { }\n}\n", Run(block));
        Assert.Equal("class C\n{\n    // ---- helpers ----\n\n    void A() { }\n    /// <summary>Does B.</summary>\n\n    // note\n\n    void B() { }\n}\n", Run(withNote));
    }

    [Fact]
    public void MovesAMemberWithAStraySemicolonAfterItAsOne()
    {
        var source = "class C\n{\n    void B() { };\n    void A() { }\n}\n";

        Assert.Equal("class C\n{\n    void A() { }\n    void B() { };\n}\n", Run(source));
    }

    [Fact]
    public void KeepsTheLineEndingsOfTheFile()
    {
        var source = "class C\r\n{\r\n    void B() { }\r\n\r\n    int _a;\r\n}\r\n";

        Assert.Equal("class C\r\n{\r\n    int _a;\r\n    void B() { }\r\n}\r\n", Run(source));
    }

    [Fact]
    public void KeepsTabsAndTheOriginalIndentationOfEachMember()
    {
        var source = "namespace N\n{\n\tclass C\n\t{\n\t\tvoid B()\n\t\t{\n\t\t\tint x;\n\t\t}\n\t\tint _a;\n\t}\n}\n";

        Assert.Equal("namespace N\n{\n\tclass C\n\t{\n\t\tint _a;\n\t\tvoid B()\n\t\t{\n\t\t\tint x;\n\t\t}\n\t}\n}\n", Run(source));
    }

    // reorganize: blank lines
    [Fact]
    public void KeepsTheBlankLineAMemberHadBeforeItWhenItMoves()
    {
        var source = "class C\n{\n    void B() { }\n\n    void A() { }\n\n    int _f;\n}\n";

        // B had none before it (it was first), A and _f had one.
        Assert.Equal("class C\n{\n    int _f;\n\n    void A() { }\n    void B() { }\n}\n", Run(source));
    }

    [Fact]
    public void PadsMovedMembersWithTheBlankLinesTheCleanupPaddingSettingsAskFor()
    {
        var source = "class C\n{\n    void B() { }\n    void A() { }\n    int _f;\n    int _g;\n}\n";

        Assert.Equal("class C\n{\n    int _f;\n    int _g;\n\n    void A() { }\n\n    void B() { }\n}\n", Run(source, null, ReorganizeCleanup.Default));
    }

    [Fact]
    public void DoesNotTouchTheBlankLinesBetweenMembersThatStayNextToEachOther()
    {
        var source = "class C\n{\n    int _a;\n\n\n    int _b;\n    void Z() { }\n    void B() { }\n}\n";

        Assert.Equal("class C\n{\n    int _a;\n\n\n    int _b;\n\n    void B() { }\n\n    void Z() { }\n}\n", Run(source, null, ReorganizeCleanup.Default));
    }

    // reorganize: types and places left alone
    [Fact]
    public void DoesNotReorderTheMembersOfAnEnum()
    {
        Assert.Equal("enum E\n{\n    Z,\n    A,\n}\n", Run("enum E\n{\n    Z,\n    A,\n}\n"));
    }

    [Fact]
    public void DoesNotReorderTheMembersOfATypeWithStructLayoutOrComImport()
    {
        var layout = "[StructLayout(LayoutKind.Sequential)]\nstruct S\n{\n    public void M() { }\n    public int A;\n}\n";
        var com = "[System.Runtime.InteropServices.ComImport]\ninterface I\n{\n    void B();\n    void A();\n}\n";

        Assert.Equal(layout, Run(layout));
        Assert.Equal(com, Run(com));
    }

    [Fact]
    public void DoesNotReorderTheMembersOfATypeWhoseLayoutAttributeIsGlobalQualified()
    {
        var layout =
          "[global::System.Runtime.InteropServices.StructLayout(global::System.Runtime.InteropServices.LayoutKind.Sequential)]\nstruct POINT\n{\n    public int y;\n    public int x;\n}\n";
        var com = "[global::System.Runtime.InteropServices.ComImport]\ninterface I\n{\n    void B();\n    void A();\n}\n";

        Assert.Equal(layout, Run(layout));
        Assert.Equal(com, Run(com));
    }

    [Fact]
    public void DoesNotReorderTheMembersOfACOMInterfaceWhoseOrderIsItsVtable()
    {
        var generated = "[GeneratedComInterface]\n[Guid(\"00000000-0000-0000-0000-000000000001\")]\ninterface I\n{\n    void B();\n    void A();\n}\n";
        var typed = "[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]\ninterface J\n{\n    void B();\n    void A();\n}\n";

        Assert.Equal(generated, Run(generated));
        Assert.Equal(typed, Run(typed));
    }

    [Fact]
    public void DoesNotDescendIntoATypeWithAFixedLayout()
    {
        var source = "[StructLayout(LayoutKind.Explicit)]\nstruct S\n{\n    struct Inner\n    {\n        public void M() { }\n        public int A;\n    }\n}\n";

        Assert.Equal(source, Run(source));
    }

    [Fact]
    public void KeepsTheOrderOfTheInstanceFieldsOfAStructWhichIsItsSequentialLayoutByDefault()
    {
        var native = "struct Native\n{\n    public int Size;\n    public byte Flags;\n    public long Address;\n}\n";
        var record = "record struct Native\n{\n    public int Size;\n    public byte Flags;\n    public long Address;\n}\n";
        // Auto-properties and field-like events are backed by fields of the layout too; static fields and methods are not.
        var mixed =
          "struct S\n{\n    public void M() { }\n    public static int Shared;\n    public int Z;\n    public int Y { get; set; }\n    public event System.Action X;\n    public int A;\n}\n";
        var fixedBuffer = "unsafe struct Buffer\n{\n    public int Length;\n    public fixed byte Data[16];\n}\n";

        Assert.Equal(native, Run(native));
        Assert.Equal(record, Run(record));
        Assert.Equal(fixedBuffer, Run(fixedBuffer));
        Assert.Equal("struct S\n{\n    public static int Shared;\n    public int Z;\n    public int Y { get; set; }\n    public event System.Action X;\n    public int A;\n    public void M() { }\n}\n", Run(mixed));
    }

    [Fact]
    public void OrdersTheFieldsOfAStructWithLayoutKindAutoAndOfAClass()
    {
        var auto = "[StructLayout(LayoutKind.Auto)]\nstruct S\n{\n    public int Z;\n    public int A;\n}\n";
        var qualified = "[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Auto, Pack = 1)]\nstruct S\n{\n    public int Z;\n    public int A;\n}\n";

        Assert.Equal("[StructLayout(LayoutKind.Auto)]\nstruct S\n{\n    public int A;\n    public int Z;\n}\n", Run(auto));
        Assert.Contains("    public int A;\n    public int Z;\n", Run(qualified));
        Assert.Equal("class C\n{\n    public int A;\n    public int Z;\n}\n", Run("class C\n{\n    public int Z;\n    public int A;\n}\n"));
    }

    [Fact]
    public void ReorganizesStructsInterfacesRecordsAndPartialClasses()
    {
        var source = Lines("partial class P { void B() { } }",
          "struct S",
          "{",
          "    public void B() { }",
          "    public int A;",
          "}",
          "record R(int X)",
          "{",
          "    public void B() { }",
          "    public int A;",
          "}",
          "record struct RS(int X)",
          "{",
          "    public void B() { }",
          "    public int A;",
          "}",
          "");
        var result = Run(source);

        Assert.Contains("struct S\n{\n    public int A;\n    public void B() { }\n}", result);
        Assert.Contains("record R(int X)\n{\n    public int A;\n    public void B() { }\n}", result);
        Assert.Contains("record struct RS(int X)\n{\n    public int A;\n    public void B() { }\n}", result);
    }

    [Fact]
    public void OrdersTheTypesOfAFileScopedNamespace()
    {
        var source = "namespace N;\n\npublic class B { }\n\npublic enum A { X }\n";

        Assert.Equal("namespace N;\n\npublic enum A { X }\npublic class B { }\n", Run(source));
    }

    [Fact]
    public void LeavesABodyWhoseMembersShareALineAloneAndReportsIt()
    {
        var source = "class C { void B() { } int A; }\nclass D\n{\n    void B() { }\n    int A;\n}\n";
        var result = Detailed(source, new ReorganizeSettings(), ReorganizeCleanup.Default);

        Assert.Equal("class C { void B() { } int A; }\nclass D\n{\n    int A;\n\n    void B() { }\n}\n", result.Output);
        Assert.Contains("C (line 1): skipped because of more than one member on a line", Assert.Single(result.Skipped));
    }

    [Fact]
    public void LeavesTopLevelStatementsInPlaceAndStillOrdersTheTypes()
    {
        var source = "using System;\nConsole.WriteLine(1);\nclass B { }\nclass A\n{\n    void Z() { }\n    int F;\n}\n";

        Assert.Equal("using System;\nConsole.WriteLine(1);\nclass B { }\nclass A\n{\n    int F;\n    void Z() { }\n}\n", Run(source));
        // Top-level statements are nothing to report: the types of such a file are not ordered, and that is all.
        Assert.Empty(Detailed(source, new ReorganizeSettings(), ReorganizeCleanup.Default).Skipped);
    }

    [Fact]
    public void ReorganizesAFileThatStartsWithAByteOrderMarkAndKeepsTheMark()
    {
        var inNamespace = "\uFEFFnamespace N\n{\n    class Zed\n    {\n        void B() { }\n        void A() { }\n    }\n}\n";
        var atTop = "\uFEFFclass Zed\n{\n    void B() { }\n    void A() { }\n}\n";
        var documented = "\uFEFF/// <summary>Doc.</summary>\nclass Zed\n{\n    void B() { }\n    void A() { }\n}\n";

        Assert.Equal("\uFEFFnamespace N\n{\n    class Zed\n    {\n        void A() { }\n        void B() { }\n    }\n}\n", Run(inNamespace));
        Assert.Equal("\uFEFFclass Zed\n{\n    void A() { }\n    void B() { }\n}\n", Run(atTop));
        Assert.Equal("\uFEFF/// <summary>Doc.</summary>\nclass Zed\n{\n    void A() { }\n    void B() { }\n}\n", Run(documented));
    }

    [Fact]
    public void OrdersMembersThatAreExplicitImplementationsOfInterfaceEventsAndIndexers()
    {
        var source = "class C : I\n{\n    event System.Action I.E { add { } remove { } }\n    int I.this[int i] { get => 0; }\n    void I.B() { }\n    int I.A { get; set; }\n}\n";

        Assert.Equal("class C : I\n{\n    event System.Action I.E { add { } remove { } }\n    int I.A { get; set; }\n    int I.this[int i] { get => 0; }\n    void I.B() { }\n}\n", Run(source));
    }

    // reorganize: pipeline transformation
    [Fact]
    public async Task IsACleanupPipelineStepThatAppliesTheReorganizerWithTheGivenSettings()
    {
        var step = new ReorganizeStep();
        var enabled = EngineSettings(new() { ["reorganize"] = new System.Text.Json.Nodes.JsonObject { ["runAtStartOfCleanup"] = true }, ["insertBlankLinePaddingBeforeMethods"] = false, ["insertBlankLinePaddingAfterMethods"] = false });

        Assert.Equal("Reorganize members", step.Name);
        Assert.Equal(CodeJanitor.Engine.Contracts.CleanupStage.Reorganize, step.Stage);
        Assert.False(step.IsEnabled(EngineSettings()));
        Assert.True(step.IsEnabled(enabled));
        Assert.Equal("class C\n{\n    int _a;\n    void B() { }\n}\n", await ApplyStepAsync(step, "class C\n{\n    void B() { }\n    int _a;\n}\n", enabled));
        Assert.Equal("", await ApplyStepAsync(step, "", enabled));
    }

    [Fact]
    public async Task LeavesAFileWithPreprocessorConditionalsAloneUnlessThePolicyIsYesAsAStepCannotAsk()
    {
        var source = "class C\n{\n    void B() { }\n#if X\n    int _a;\n#endif\n}\n";
        var step = new ReorganizeStep();
        var ask = EngineSettings(new() { ["reorganize"] = new System.Text.Json.Nodes.JsonObject { ["runAtStartOfCleanup"] = true } });
        var yes = EngineSettings(new() { ["reorganize"] = new System.Text.Json.Nodes.JsonObject { ["runAtStartOfCleanup"] = true, ["performWhenPreprocessorConditionals"] = "yes" } });

        Assert.Equal(source, await ApplyStepAsync(step, source, ask));
        Assert.NotEqual(source, await ApplyStepAsync(step, source, yes));
    }

    [Fact]
    public async Task ReportsInACleanupTheTypesItLeavesAloneAndAFileItDoesNotReorganize()
    {
        var engine = new CleanupEngine([new ReorganizeStep()]);
        var request = new CodeJanitor.Engine.Contracts.CleanupRequest(new System.Text.Json.Nodes.JsonObject { ["reorganize"] = new System.Text.Json.Nodes.JsonObject { ["runAtStartOfCleanup"] = true } }, [], null);

        var shared = await engine.CleanupAsync(StepHarness.EngineDocument("class C { void B() { } int A; }\n"), request, CancellationToken.None);
        var conditional = await engine.CleanupAsync(StepHarness.EngineDocument("class C\n{\n    void B() { }\n#if X\n    int _a;\n#endif\n}\n"), request, CancellationToken.None);

        Assert.Contains("Reorganize members: C (line 1): skipped because of more than one member on a line", shared.Issues);
        Assert.Contains(
            "Reorganize members: not applied, the file has preprocessor conditionals (#if, #pragma); set codeJanitor.reorganize.performWhenPreprocessorConditionals to \"yes\" to reorganize such files in a cleanup",
            conditional.Issues);
    }

    private static async Task<string> ApplyStepAsync(ReorganizeStep step, string source, CodeJanitor.Engine.Contracts.IEffectiveSettings settings)
    {
        var document = await DocumentAsync(source);
        var solution = await step.ApplyAsync(document, settings, CancellationToken.None);

        return (await solution.GetDocument(document.Id)!.GetTextAsync()).ToString();
    }

    // reorganize: edge cases
    [Fact]
    public void OrdersTheNamespacesOfAFileAfterItsUsingDirectives()
    {
        var source = "using System;\nnamespace B\n{\n    class X { }\n}\nnamespace A\n{\n    class Y { }\n}\n";

        Assert.Equal("using System;\nnamespace A\n{\n    class Y { }\n}\nnamespace B\n{\n    class X { }\n}\n", Run(source));
    }

    [Fact]
    public void KeepsAssemblyAttributesInFrontOfAllDeclarations()
    {
        var source = "using System;\n[assembly: CLSCompliant(true)]\nnamespace B\n{\n    class X { }\n}\nnamespace A\n{\n    class Y { }\n}\n";

        // The attribute list is not part of a declaration: the namespaces after it are sorted and it stays in front of them.
        Assert.Equal("using System;\n[assembly: CLSCompliant(true)]\nnamespace A\n{\n    class Y { }\n}\nnamespace B\n{\n    class X { }\n}\n", Run(source));
    }

    [Fact]
    public void HasNothingToReportForAFileOfAssemblyAttributesOnly()
    {
        var source = "using System.Reflection;\n\n[assembly: AssemblyTitle(\"T\")]\n[assembly: AssemblyCompany(\"C\")]\n";
        var result = Detailed(source, new ReorganizeSettings(), ReorganizeCleanup.Default);

        Assert.Equal(source, result.Output);
        Assert.Empty(result.Skipped);
    }

    [Fact]
    public void KeepsAnExternAliasAndTheUsingsAfterItInFrontOfTheTypesOfANamespace()
    {
        var source = "namespace N\n{\n    extern alias V1;\n    using V1::Ext;\n\n    class B { }\n    class A { }\n}\n";

        Assert.Equal("namespace N\n{\n    extern alias V1;\n    using V1::Ext;\n\n    class A { }\n    class B { }\n}\n", Run(source));
    }

    [Fact]
    public void KeepsTheUsingsOfANamespaceBeforeItsTypes()
    {
        var source = "namespace N\n{\n    using System;\n\n    class B { }\n    class A { }\n}\n";

        Assert.Equal("namespace N\n{\n    using System;\n\n    class A { }\n    class B { }\n}\n", Run(source));
    }

    [Fact]
    public void ReorganizesTheNestedTypesOfATypeItLeavesAlone()
    {
        var source = "class Outer\n{\n    void Z() { } int _shared;\n    class Inner\n    {\n        void B() { }\n        int _a;\n    }\n}\n";
        var result = Detailed(source, new ReorganizeSettings(), ReorganizeCleanup.Default);

        Assert.Contains("class Inner\n    {\n        int _a;\n\n        void B() { }\n    }", result.Output);
        Assert.Contains("Outer (line 1): skipped because of more than one member on a line", Assert.Single(result.Skipped));
    }

    [Fact]
    public void KeepsARegionOnlyIfItStillHoldsMembersOfItsNameAfterSortingAcrossRegions()
    {
        var source = "class C\n{\n    #region Fields\n    int _b;\n    void B() { }\n    #endregion\n    #region Methods\n    int _a;\n    void A() { }\n    #endregion\n}\n";
        var once = Run(source, new ReorganizeSettings { KeepMembersWithinRegions = false, RegionsRemoveExistingRegions = true });

        // Sorted across the regions: _a, _b, A, B. Fields then holds fields and Methods holds methods only.
        Assert.Equal("class C\n{\n    #region Fields\n    int _a;\n    int _b;\n    #endregion\n    #region Methods\n    void A() { }\n    void B() { }\n    #endregion\n}\n", once);
    }

    [Fact]
    public void NamesTheRegionsOfAPrivateProtectedMemberAfterItsAccessLevel()
    {
        var source = "class C\n{\n    private protected void M() { }\n}\n";

        Assert.Contains("#region Private Protected Methods", Run(source, new ReorganizeSettings { RegionsInsertNewRegions = true, RegionsIncludeAccessLevel = true }));
    }

    [Fact]
    public void PlacesACommentThatTrailsTheOpeningBraceWithTheBrace()
    {
        var source = "class C\n{ // the body\n    void B() { }\n    int _a;\n}\n";

        Assert.Equal("class C\n{ // the body\n    int _a;\n    void B() { }\n}\n", Run(source));
    }

    [Fact]
    public void IndentsTheRegionsItInsertsLikeTheMembersOfABodyThatIsIndentedWithTabs()
    {
        var source = "namespace N\n{\n\tclass C\n\t{\n\t\tvoid B() { }\n\t\tint _a;\n\t}\n}\n";

        Assert.Contains("\t\t#region Fields\n\t\tint _a;\n\t\t#endregion Fields\n\t\t#region Methods\n", Run(source, new ReorganizeSettings { RegionsInsertNewRegions = true }));
    }

    [Fact]
    public void KeepsTheIndentationOfARegionInsertedAroundAIfBlock()
    {
        var source = "class C\n{\n#if X\n    int _a;\n#endif\n    void M() { }\n}\n";

        Assert.Contains("    #region Fields\n#if X\n    int _a;\n#endif\n    #endregion Fields", Run(source, new ReorganizeSettings { RegionsInsertNewRegions = true, PerformWhenPreprocessorConditionals = PreprocessorPolicy.Yes }));
    }
}

