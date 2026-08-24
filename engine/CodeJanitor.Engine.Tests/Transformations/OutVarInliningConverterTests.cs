using Microsoft.VisualStudio.TestTools.UnitTesting;
using CodeJanitor.Logic.Transformations;

namespace CodeJanitor.UnitTests.Transformations;

/// <summary>
/// Unit tests for <see cref="OutVarInliningConverter" />.
/// </summary>
[TestClass]
public sealed class OutVarInliningConverterTests
{
    private OutVarInliningConverter _converter;

    [TestInitialize]
    public void TestInitialize()
    {
        _converter = new OutVarInliningConverter();
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void Name_IsNotEmpty()
    {
        Assert.IsFalse(string.IsNullOrWhiteSpace(_converter.Name));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void Apply_UninitializedDeclarationBeforeIfTryParse_InlinesOutVar()
    {
        var input = @"
public class C
{
    public void M(string s)
    {
        int result;
        if (int.TryParse(s, out result))
        {
            DoWork(result);
        }
    }
}";
        var expected = @"
public class C
{
    public void M(string s)
    {
        if (int.TryParse(s, out var result))
        {
            DoWork(result);
        }
    }
}";

        var result = _converter.Apply(input);

        Assert.AreEqual(expected, result);
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void Apply_InitializedDeclaration_DoesNotInlined()
    {
        var input = @"
public class C
{
    public void M(string s)
    {
        int result = 0;
        if (int.TryParse(s, out result))
        {
            DoWork(result);
        }
    }
}";

        var result = _converter.Apply(input);

        Assert.AreEqual(input, result);
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void Apply_NullOrEmpty_ReturnsOriginal()
    {
        Assert.IsNull(_converter.Apply(null));
        Assert.AreEqual(string.Empty, _converter.Apply(string.Empty));
    }
}
