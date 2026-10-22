#nullable disable
using CodeJanitor.Engine.Steps.Transformations;
using Xunit;
using Assert = CodeJanitor.Engine.Tests.Steps.Support.MsAssert;

namespace CodeJanitor.Engine.Tests.Steps;

/// <summary>
/// Unit tests for <see cref="ReturnThrowBlankLinePaddingConverter" />.
/// Pure transformation tests.
/// </summary>
public sealed class ReturnThrowBlankLinePaddingConverterTests
{
    private ISourceTransformation _converter;

    public ReturnThrowBlankLinePaddingConverterTests() => _converter = new ReturnThrowBlankLinePaddingConverter();

    [Fact]
    public void InsertsBlankLineBeforeReturn_WhenPrecededByOtherStatements()
    {
        string input =
            "class C\r\n{\r\n    int M()\r\n    {\r\n        int x = 1;\r\n        return x;\r\n    }\r\n}\r\n";
        string expected =
            "class C\r\n{\r\n    int M()\r\n    {\r\n        int x = 1;\r\n\r\n        return x;\r\n    }\r\n}\r\n";

        Assert.AreEqual(expected, _converter.Apply(input));
    }

    [Fact]
    public void InsertsBlankLineBeforeThrow_WhenPrecededByOtherStatements()
    {
        string input =
            "class C\r\n{\r\n    void M()\r\n    {\r\n        int x = 1;\r\n        throw new System.Exception();\r\n    }\r\n}\r\n";
        string expected =
            "class C\r\n{\r\n    void M()\r\n    {\r\n        int x = 1;\r\n\r\n        throw new System.Exception();\r\n    }\r\n}\r\n";

        Assert.AreEqual(expected, _converter.Apply(input));
    }

    [Fact]
    public void DoesNotInsertBlankLine_WhenReturnIsTheOnlyStatement()
    {
        string input = "class C\r\n{\r\n    int M()\r\n    {\r\n        return 1;\r\n    }\r\n}\r\n";

        Assert.AreEqual(input, _converter.Apply(input));
    }

    [Fact]
    public void DoesNotInsertBlankLine_WhenReturnIsFirstStatementFollowedByUnreachableCode()
    {
        // Unusual (and would normally trigger CS0162), but the return is still the first
        // statement in its block, so there is nothing preceding it to separate it from.
        string input = "class C\r\n{\r\n    int M()\r\n    {\r\n        return 1;\r\n#pragma warning disable CS0162\r\n        int x = 2;\r\n#pragma warning restore CS0162\r\n    }\r\n}\r\n";

        Assert.AreEqual(input, _converter.Apply(input));
    }

    [Fact]
    public void IsIdempotent_WhenBlankLineAlreadyPresent()
    {
        string input =
            "class C\r\n{\r\n    int M()\r\n    {\r\n        int x = 1;\r\n\r\n        return x;\r\n    }\r\n}\r\n";

        Assert.AreEqual(input, _converter.Apply(input));
    }

    [Fact]
    public void InsertsBlankLineBeforeReturn_InsideIfBlock()
    {
        string input =
            "class C\r\n{\r\n    int M(bool b)\r\n    {\r\n        if (b)\r\n        {\r\n            int y = 1;\r\n            return y;\r\n        }\r\n        return 0;\r\n    }\r\n}\r\n";
        string expected =
            "class C\r\n{\r\n    int M(bool b)\r\n    {\r\n        if (b)\r\n        {\r\n            int y = 1;\r\n\r\n            return y;\r\n        }\r\n\r\n        return 0;\r\n    }\r\n}\r\n";

        Assert.AreEqual(expected, _converter.Apply(input));
    }

    [Fact]
    public void HandlesMultipleCandidatesInTheSameFile()
    {
        string input =
            "class C\r\n{\r\n    int M1()\r\n    {\r\n        int x = 1;\r\n        return x;\r\n    }\r\n\r\n    int M2()\r\n    {\r\n        int y = 2;\r\n        return y;\r\n    }\r\n}\r\n";
        string expected =
            "class C\r\n{\r\n    int M1()\r\n    {\r\n        int x = 1;\r\n\r\n        return x;\r\n    }\r\n\r\n    int M2()\r\n    {\r\n        int y = 2;\r\n\r\n        return y;\r\n    }\r\n}\r\n";

        Assert.AreEqual(expected, _converter.Apply(input));
    }

    [Fact]
    public void EmptySource_ReturnsUnchanged() => Assert.AreEqual(string.Empty, _converter.Apply(string.Empty));

    [Fact]
    public void NullSource_ReturnsNull() => Assert.IsNull(_converter.Apply(null));

    [Fact]
    public void NameAndSingleLineIfWithoutBlock_HandledCorrectly()
    {
        Assert.AreEqual("Blank Line Before Return/Throw", _converter.Name);

        string input = "class C { void M(bool b) { if (b) return; } }";
        Assert.AreEqual(input, _converter.Apply(input));

        string unixInput = "class C\n{\n    int M()\n    {\n        int x = 1;\n        return x;\n    }\n}\n";
        string expectedUnix = "class C\n{\n    int M()\n    {\n        int x = 1;\n\n        return x;\n    }\n}\n";
        Assert.AreEqual(expectedUnix, _converter.Apply(unixInput));
    }

    [Fact]
    public void TopLevelStatementsFile_PadsReturnsInLocalFunctionsButNotTheTopLevelReturn()
    {
        string input =
            "using System;\r\n\r\nConsole.WriteLine(\"hi\");\r\nreturn Compute();\r\n\r\n" +
            "static int Compute()\r\n{\r\n    var x = 1;\r\n    return x;\r\n}\r\n";
        string expected =
            "using System;\r\n\r\nConsole.WriteLine(\"hi\");\r\nreturn Compute();\r\n\r\n" +
            "static int Compute()\r\n{\r\n    var x = 1;\r\n\r\n    return x;\r\n}\r\n";

        Assert.AreEqual(expected, _converter.Apply(input));
    }

    [Theory]
    [InlineData("class C\r\n{\r\n    int M(int x)\r\n    {\r\n        switch (x)\r\n        {\r\n            case 1:\r\n                Log();\r\n                return 1;\r\n        }\r\n        return 0;\r\n    }\r\n}\r\n",
        "class C\r\n{\r\n    int M(int x)\r\n    {\r\n        switch (x)\r\n        {\r\n            case 1:\r\n                Log();\r\n                return 1;\r\n        }\r\n\r\n        return 0;\r\n    }\r\n}\r\n")]
    [InlineData("class C\r\n{\r\n    string M(string s)\r\n    {\r\n        Log();\r\n        var t = s ?? throw new System.Exception();\r\n    }\r\n}\r\n",
        "class C\r\n{\r\n    string M(string s)\r\n    {\r\n        Log();\r\n        var t = s ?? throw new System.Exception();\r\n    }\r\n}\r\n")]
    [InlineData("class C\r\n{\r\n    System.Collections.Generic.IEnumerable<int> M()\r\n    {\r\n        Log();\r\n        yield return 1;\r\n    }\r\n}\r\n",
        "class C\r\n{\r\n    System.Collections.Generic.IEnumerable<int> M()\r\n    {\r\n        Log();\r\n        yield return 1;\r\n    }\r\n}\r\n")]
    [InlineData("class C\r\n{\r\n    void M()\r\n    {\r\n        Run(() =>\r\n        {\r\n            Log();\r\n            return;\r\n        });\r\n    }\r\n}\r\n",
        "class C\r\n{\r\n    void M()\r\n    {\r\n        Run(() =>\r\n        {\r\n            Log();\r\n\r\n            return;\r\n        });\r\n    }\r\n}\r\n")]
    [InlineData("class C\r\n{\r\n    async System.Threading.Tasks.Task<int> M()\r\n    {\r\n        await Log();\r\n        throw new System.Exception();\r\n    }\r\n}\r\n",
        "class C\r\n{\r\n    async System.Threading.Tasks.Task<int> M()\r\n    {\r\n        await Log();\r\n\r\n        throw new System.Exception();\r\n    }\r\n}\r\n")]
    [InlineData("class C\r\n{\r\n    string M()\r\n    {\r\n        var x = @\"a\r\nreturn b;\";\r\n        return x;\r\n    }\r\n}\r\n",
        "class C\r\n{\r\n    string M()\r\n    {\r\n        var x = @\"a\r\nreturn b;\";\r\n\r\n        return x;\r\n    }\r\n}\r\n")]
    [InlineData("class C\r\n{\r\n    string M()\r\n    {\r\n        var x = \"\"\"\r\n            Log();\r\n            return y;\r\n            \"\"\";\r\n        return x;\r\n    }\r\n}\r\n",
        "class C\r\n{\r\n    string M()\r\n    {\r\n        var x = \"\"\"\r\n            Log();\r\n            return y;\r\n            \"\"\";\r\n\r\n        return x;\r\n    }\r\n}\r\n")]
    [InlineData("class C\r\n{\r\n    int M()\r\n    {\r\n        Log();\r\n#if NEVER_DEFINED\r\n        Log();\r\n        return 1;\r\n#endif\r\n        return 2;\r\n    }\r\n}\r\n",
        "class C\r\n{\r\n    int M()\r\n    {\r\n        Log();\r\n#if NEVER_DEFINED\r\n        Log();\r\n        return 1;\r\n#endif\r\n        return 2;\r\n    }\r\n}\r\n")]
    [InlineData("class C\r\n{\r\n    int M()\r\n    {\r\n        Log();\r\n#if NEVER_DEFINED\r\n        Log();\r\n#else\r\n        return 2;\r\n#endif\r\n    }\r\n}\r\n",
        "class C\r\n{\r\n    int M()\r\n    {\r\n        Log();\r\n#if NEVER_DEFINED\r\n        Log();\r\n#else\r\n        return 2;\r\n#endif\r\n    }\r\n}\r\n")]
    [InlineData("class C\r\n{\r\n    int M()\r\n    {\r\n        Log();\r\n#region Exit\r\n        return 2;\r\n#endregion\r\n    }\r\n}\r\n",
        "class C\r\n{\r\n    int M()\r\n    {\r\n        Log();\r\n#region Exit\r\n        return 2;\r\n#endregion\r\n    }\r\n}\r\n")]
    [InlineData("class C\r\n{\r\n    string M()\r\n    {\r\n        var x = @\"a\r\n#b\";\r\n        return x;\r\n    }\r\n}\r\n",
        "class C\r\n{\r\n    string M()\r\n    {\r\n        var x = @\"a\r\n#b\";\r\n\r\n        return x;\r\n    }\r\n}\r\n")]
    [InlineData("class C\r\n{\r\n\tint M()\r\n\t{\r\n\t\tLog();\r\n\t\treturn 1;\r\n\t}\r\n}",
        "class C\r\n{\r\n\tint M()\r\n\t{\r\n\t\tLog();\r\n\r\n\t\treturn 1;\r\n\t}\r\n}")]
    [InlineData("class C\r\n{\r\n    int M()\r\n    {\r\n        var x = 1;\r\n        // explain\r\n        return x;\r\n    }\r\n}\r\n",
        "class C\r\n{\r\n    int M()\r\n    {\r\n        var x = 1;\r\n\r\n        // explain\r\n        return x;\r\n    }\r\n}\r\n")]
    [InlineData("class C\r\n{\n    int M()\r\n    {\r\n        var x = 1;\r\n        return x;\r\n    }\r\n}\r\n",
        "class C\r\n{\n    int M()\r\n    {\r\n        var x = 1;\r\n\r\n        return x;\r\n    }\r\n}\r\n")]
    [InlineData("class C\r{\r    int M()\r    {\r        Log();\r        return 1;\r    }\r}\r",
        "class C\r{\r    int M()\r    {\r        Log();\r\r        return 1;\r    }\r}\r")]
    public void RealisticInputs_ArePaddedOnlyBeforeBlockLevelReturnAndThrow(string input, string expected) => Assert.AreEqual(expected, _converter.Apply(input));

    [Theory]
    [InlineData("   \r\n\t\r\n")]
    [InlineData("class C { void M( { Log(); return; }")]
    [InlineData("class C\r\n{\r\n    void M() { Foo(); return; }\r\n}\r\n")]
    public void InputsWithoutSeparateReturnLines_AreUnchanged(string input) => Assert.AreEqual(input, _converter.Apply(input));

    [Theory]
    [InlineData(
        "class C\r\n{\r\n    int M()\r\n    {\r\n        var x = 1;\r\n        /// explain\r\n        return x;\r\n    }\r\n}\r\n",
        "class C\r\n{\r\n    int M()\r\n    {\r\n        var x = 1;\r\n\r\n        /// explain\r\n        return x;\r\n    }\r\n}\r\n")]
    [InlineData(
        "class C\r\n{\r\n    int M()\r\n    {\r\n        var x = 1;\r\n        /// explain\r\n\r\n        return x;\r\n    }\r\n}\r\n",
        "class C\r\n{\r\n    int M()\r\n    {\r\n        var x = 1;\r\n        /// explain\r\n\r\n        return x;\r\n    }\r\n}\r\n")]
    public void TripleSlashCommentAboveTheReturn_StaysAttachedOnlyWhenDirectlyAboveIt(string input, string expected) => Assert.AreEqual(expected, _converter.Apply(input));
}
