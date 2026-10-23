#nullable disable
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using CodeJanitor.Engine.Commands;
using CodeJanitor.Engine.Steps.Transformations;
using CodeJanitor.Engine.Tests.Steps;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Xunit;
using Assert = CodeJanitor.Engine.Tests.Steps.Support.MsAssert;
using VsSettings = CodeJanitor.Engine.Tests.Steps.Support.VsSettings;

namespace CodeJanitor.Engine.Tests.Steps;

public sealed class UpdateSingleLineMethodsConverterTests
{
    private UpdateSingleLineMethodsConverter _converter;

    public UpdateSingleLineMethodsConverterTests()
    {
        _converter = new UpdateSingleLineMethodsConverter(VsSettings.Default.IsEnabled);
        VsSettings.Default.Cleaning_UpdateSingleLineMethods = true;
    }


    [Fact]
    public void SettingDisabled_ReturnsUnchanged()
    {
        VsSettings.Default.Cleaning_UpdateSingleLineMethods = false;
        string source = "public class MyClass { public void MyMethod() { return; } }";
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
    public void MultiLineMethod_ReturnsUnchanged()
    {
        string source = "public class MyClass\r\n{\r\n    public void MyMethod()\r\n    {\r\n        return;\r\n    }\r\n}";
        string result = _converter.Apply(source);
        // Multi-line methods should not be affected
        Assert.Contains("public void MyMethod()", result);
    }

    [Fact]
    public void NoMethods_ReturnsUnchanged()
    {
        string source = "public class MyClass { }";
        string result = _converter.Apply(source);
        Assert.Contains("public class MyClass", result);
    }

    [Fact]
    public void AbstractMethod_ReturnsUnchanged()
    {
        string source = "public abstract class MyClass { public abstract void MyMethod(); }";
        string result = _converter.Apply(source);
        // Abstract methods should not be spread
        Assert.Contains("public abstract void MyMethod()", result);
    }

    [Fact]
    public void InterfaceMethod_ReturnsUnchanged()
    {
        string source = "public interface IMyInterface { void MyMethod(); }";
        string result = _converter.Apply(source);
        // Interface methods should not be spread
        Assert.Contains("void MyMethod()", result);
    }

    [Theory]
    [InlineData("class C\r\n{\r\n    int M() => 1;\r\n}\r\n")]
    [InlineData("class C\r\n{\r\n    void M() { }\r\n}\r\n")]
    [InlineData("class C\r\n{\r\n    void M() { Foo(1,\r\n        2); }\r\n}\r\n")]
    [InlineData("using System;\r\nConsole.WriteLine(Local());\r\nstatic int Local() { return 1; }\r\n")]
    [InlineData("class C\r\n{\r\n    void M()\r\n    {\r\n        Run(() => { A(); });\r\n    }\r\n}\r\n")]
    [InlineData("class C\r\n{\r\n    void M()\r\n    {\r\n        Run(delegate { A(); });\r\n    }\r\n}\r\n")]
    [InlineData("class C\r\n{\r\n    void M()\r\n    {\r\n        Run(delegate (int x)\r\n        {\r\n            A(x);\r\n        });\r\n    }\r\n}\r\n")]
    [InlineData("class C\r\n{\r\n    System.Action<int> a = delegate (int x)\r\n    {\r\n        A(x);\r\n    };\r\n}\r\n")]
    [InlineData("class C\r\n{\r\n#if NEVER_DEFINED\r\n    void M() { A(); }\r\n#endif\r\n}\r\n")]
    [InlineData("partial class C\r\n{\r\n    partial void M();\r\n}\r\n")]
    [InlineData("class C\r\n{\r\n    extern void M();\r\n}\r\n")]
    public void MethodsThatAreNotSingleLineBlockBodies_AreUnchanged(string source) => Assert.AreEqual(source, _converter.Apply(source));

    [Fact]
    public async Task SingleLineMethods_AreSpreadSoEveryStatementHasItsOwnLine_AndTheFileStillCompiles()
    {
        string source =
            "class C\r\n{\r\n    int _x;\r\n    int Get() { return _x; }\r\n" +
            "    void Set(int v) { _x = v; Log(v); }\r\n    void Log(int v) { }\r\n}\r\n";

        string result = _converter.Apply(source);

        IReadOnlyList<string> errors = await CompilingTestProject.GetCompileErrorsAsync(CompilingTestProject.CreateDocument(source), result);
        Assert.IsEmpty(errors, string.Join(Environment.NewLine, errors));
        SyntaxTree tree = CSharpSyntaxTree.ParseText(result, cancellationToken: CancellationToken.None);
        Dictionary<string, MethodDeclarationSyntax> methods = tree.GetRoot(CancellationToken.None).DescendantNodes().OfType<MethodDeclarationSyntax>()
            .ToDictionary(method => method.Identifier.Text);
        Assert.AreSequenceEqual(new[] { "return _x;" }, methods["Get"].Body.Statements.Select(s => s.ToString()).ToArray());
        Assert.AreSequenceEqual(new[] { "_x = v;", "Log(v);" }, methods["Set"].Body.Statements.Select(s => s.ToString()).ToArray());
        foreach (string name in new[] { "Get", "Set" })
        {
            BlockSyntax body = methods[name].Body;
            int[] lines = new[] { body.OpenBraceToken.Span }
                .Concat(body.Statements.Select(statement => statement.Span))
                .Concat(new[] { body.CloseBraceToken.Span })
                .Select(span => tree.GetLineSpan(span, CancellationToken.None).StartLinePosition.Line)
                .ToArray();
            Assert.HasCount(lines.Length, lines.Distinct(), name + " still has several parts on one line:\r\n" + result);
        }

        Assert.Contains("void Log(int v) { }", result);
    }

    [Theory]
    [InlineData(
        "class C\r\n{\r\n    int M() { return 1; }\r\n}\r\n",
        "class C\r\n{\r\n    int M()\r\n    {\r\n        return 1;\r\n    }\r\n}\r\n")]
    [InlineData(
        "class C\n{\n    int M() { return 1; }\n    void N() { }\n}\n",
        "class C\n{\n    int M()\n    {\n        return 1;\n    }\n    void N() { }\n}\n")]
    [InlineData(
        "class C\r\n{\r\n    void M() { A(); /* why */ }\r\n}\r\n",
        "class C\r\n{\r\n    void M()\r\n    {\r\n        A(); /* why */\r\n    }\r\n}\r\n")]
    [InlineData(
        "class C\n{\n\tvoid M() { A(); B(); }\n}\n",
        "class C\n{\n\tvoid M()\n\t{\n\t\tA();\n\t\tB();\n\t}\n}\n")]
    [InlineData(
        "namespace N\n{\n    class C\n    {\n        void M()\n        { A(); }\n    }\n}\n",
        "namespace N\n{\n    class C\n    {\n        void M()\n        {\n            A();\n        }\n    }\n}\n")]
    [InlineData(
        "class C { void M() { A(); } }",
        "class C { void M()\n{\n    A();\n} }")]
    [InlineData(
        "class C\r\n{\r\n    int M(int a,\r\n          int b) { return a; }\r\n}\r\n",
        "class C\r\n{\r\n    int M(int a,\r\n          int b)\r\n    {\r\n        return a;\r\n    }\r\n}\r\n")]
    [InlineData(
        "class C\r\n{\r\n    T M<T>()\r\n        where T : new() { return new T(); }\r\n}\r\n",
        "class C\r\n{\r\n    T M<T>()\r\n        where T : new()\r\n    {\r\n        return new T();\r\n    }\r\n}\r\n")]
    [InlineData(
        "class C\r\n{\r\n    int M() { return 1; }\n    void N() { }\r\n}\r\n",
        "class C\r\n{\r\n    int M()\n    {\n        return 1;\n    }\n    void N() { }\r\n}\r\n")]
    [InlineData(
        "class C\n{\n    int M() { return 1; }\r\n    void N() { }\n}\n",
        "class C\n{\n    int M()\r\n    {\r\n        return 1;\r\n    }\r\n    void N() { }\n}\n")]
    public void SingleLineMethod_IsSpreadWithTheFileIndentationAndLineBreaks(string source, string expected) => Assert.AreEqual(expected, _converter.Apply(source));

}
