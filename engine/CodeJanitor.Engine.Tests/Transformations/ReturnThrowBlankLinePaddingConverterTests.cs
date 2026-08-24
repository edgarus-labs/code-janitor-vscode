using Microsoft.VisualStudio.TestTools.UnitTesting;
using CodeJanitor.Logic.Transformations;

namespace CodeJanitor.UnitTests.Transformations;

/// <summary>
/// Unit tests for <see cref="ReturnThrowBlankLinePaddingConverter" />.
/// Pure transformation tests (no Visual Studio / EnvDTE required).
/// </summary>

[TestClass]
public sealed class ReturnThrowBlankLinePaddingConverterTests
{
    private ISourceTransformation _converter;

    [TestInitialize]
    public void TestInitialize()
    {
        _converter = new ReturnThrowBlankLinePaddingConverter();
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void InsertsBlankLineBeforeReturn_WhenPrecededByOtherStatements()
    {
        var input =
            "class C\r\n{\r\n    int M()\r\n    {\r\n        int x = 1;\r\n        return x;\r\n    }\r\n}\r\n";
        var expected =
            "class C\r\n{\r\n    int M()\r\n    {\r\n        int x = 1;\r\n\r\n        return x;\r\n    }\r\n}\r\n";

        Assert.AreEqual(expected, _converter.Apply(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void InsertsBlankLineBeforeThrow_WhenPrecededByOtherStatements()
    {
        var input =
            "class C\r\n{\r\n    void M()\r\n    {\r\n        int x = 1;\r\n        throw new System.Exception();\r\n    }\r\n}\r\n";
        var expected =
            "class C\r\n{\r\n    void M()\r\n    {\r\n        int x = 1;\r\n\r\n        throw new System.Exception();\r\n    }\r\n}\r\n";

        Assert.AreEqual(expected, _converter.Apply(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void DoesNotInsertBlankLine_WhenReturnIsTheOnlyStatement()
    {
        var input = "class C\r\n{\r\n    int M()\r\n    {\r\n        return 1;\r\n    }\r\n}\r\n";

        Assert.AreEqual(input, _converter.Apply(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void DoesNotInsertBlankLine_WhenReturnIsFirstStatementFollowedByUnreachableCode()
    {
        // Unusual (and would normally trigger CS0162), but the return is still the first
        // statement in its block, so there is nothing preceding it to separate it from.
        var input = "class C\r\n{\r\n    int M()\r\n    {\r\n        return 1;\r\n#pragma warning disable CS0162\r\n        int x = 2;\r\n#pragma warning restore CS0162\r\n    }\r\n}\r\n";

        Assert.AreEqual(input, _converter.Apply(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void IsIdempotent_WhenBlankLineAlreadyPresent()
    {
        var input =
            "class C\r\n{\r\n    int M()\r\n    {\r\n        int x = 1;\r\n\r\n        return x;\r\n    }\r\n}\r\n";

        Assert.AreEqual(input, _converter.Apply(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void InsertsBlankLineBeforeReturn_InsideIfBlock()
    {
        var input =
            "class C\r\n{\r\n    int M(bool b)\r\n    {\r\n        if (b)\r\n        {\r\n            int y = 1;\r\n            return y;\r\n        }\r\n        return 0;\r\n    }\r\n}\r\n";
        var expected =
            "class C\r\n{\r\n    int M(bool b)\r\n    {\r\n        if (b)\r\n        {\r\n            int y = 1;\r\n\r\n            return y;\r\n        }\r\n\r\n        return 0;\r\n    }\r\n}\r\n";

        Assert.AreEqual(expected, _converter.Apply(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void HandlesMultipleCandidatesInTheSameFile()
    {
        var input =
            "class C\r\n{\r\n    int M1()\r\n    {\r\n        int x = 1;\r\n        return x;\r\n    }\r\n\r\n    int M2()\r\n    {\r\n        int y = 2;\r\n        return y;\r\n    }\r\n}\r\n";
        var expected =
            "class C\r\n{\r\n    int M1()\r\n    {\r\n        int x = 1;\r\n\r\n        return x;\r\n    }\r\n\r\n    int M2()\r\n    {\r\n        int y = 2;\r\n\r\n        return y;\r\n    }\r\n}\r\n";

        Assert.AreEqual(expected, _converter.Apply(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void EmptySource_ReturnsUnchanged()
    {
        Assert.AreEqual(string.Empty, _converter.Apply(string.Empty));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void NullSource_ReturnsNull()
    {
        Assert.IsNull(_converter.Apply(null));
    }
}
