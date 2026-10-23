#nullable disable
using CodeJanitor.Engine.Steps.Transformations;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;
using Assert = CodeJanitor.Engine.Tests.Steps.Support.MsAssert;

namespace CodeJanitor.Engine.Tests.Steps;

/// <summary>
/// Unit tests for <see cref="IndentationGuard" />: the indentation of a line may change unless the line starts inside a
/// multi-line string literal, disabled text or a multi-line comment. Each source marks the start of the tested line
/// with <c>|</c>, which is removed before parsing.
/// </summary>
public sealed class IndentationGuardTests
{
    [Theory]
    [InlineData("class C\n{\n|    int x;\n}\n")]
    [InlineData("|using System;\n")]
    [InlineData("class C\n{\n|    /* one\n       two */\n}\n")]
    [InlineData("class C\n{\n    string S = @\"a\n\";\n|    int x;\n}\n")]
    [InlineData("class C\n{\n    string S(int x) => $\"\"\"\n        {\n|            x\n        } text\n        \"\"\";\n}\n")]
    [InlineData("class C\n{\n    string S(int x) =>\n|        $\"\"\"\n        {x}\n        \"\"\";\n}\n")]
    [InlineData("#if NEVER\nclass Old { }\n#endif\n|class C { }\n")]
    [InlineData("class C { }\n#if NEVER\nclass Old { }\n|")]
    [InlineData("System.Console.WriteLine(\n|    \"top-level\");\n")]
    public void CanChangeIndentation_OutsideStringsCommentsAndDisabledText(string markedSource) => Assert.IsTrue(CanChangeIndentation(markedSource));

    [Theory]
    [InlineData("class C\n{\n    string S = @\"first\n|    second\";\n}\n")]
    [InlineData("class C\n{\n    string S = \"\"\"\n|        raw\n        \"\"\";\n}\n")]
    [InlineData("class C\n{\n    string S(int x) => $\"\"\"\n|        {x} raw\n        \"\"\";\n}\n")]
    [InlineData("class C\n{\n    string S(int x) => $@\"{x}\n|    }} namespace {{\";\n}\n")]
    [InlineData("class C\n{\n    string S(int x) => $\"\"\"\n        {x}\n|        \"\"\";\n}\n")]
    [InlineData("class C\n{\n    /* one\n|       two */\n}\n")]
    [InlineData("class C\n{\n    /** <summary>\n|     * doc</summary> */\n    int x;\n}\n")]
    [InlineData("#if NEVER\nclass Old\n{\n|    int x;\n}\n#endif\n")]
    [InlineData("#if NEVER\n|class Old { }\n#endif\n")]
    public void CannotChangeIndentation_InsideStringsCommentsAndDisabledText(string markedSource) => Assert.IsFalse(CanChangeIndentation(markedSource));

    private static bool CanChangeIndentation(string markedSource)
    {
        int lineStart = markedSource.IndexOf('|');
        SyntaxNode root = CSharpSyntaxTree.ParseText(markedSource.Remove(lineStart, 1)).GetRoot();

        return IndentationGuard.CanChangeIndentation(root, lineStart);
    }
}
