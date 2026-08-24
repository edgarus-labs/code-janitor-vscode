using Microsoft.VisualStudio.TestTools.UnitTesting;
using CodeJanitor.Logic.Transformations;

namespace CodeJanitor.UnitTests.Transformations;

/// <summary>
/// Unit tests for <see cref="NameOfOperatorConverter" />.
/// </summary>
[TestClass]
public sealed class NameOfOperatorConverterTests
{
    private NameOfOperatorConverter _converter;

    [TestInitialize]
    public void TestInitialize()
    {
        _converter = new NameOfOperatorConverter();
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void Name_IsNotEmpty()
    {
        Assert.IsFalse(string.IsNullOrWhiteSpace(_converter.Name));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void Apply_ArgumentNullException_ConvertsToNameOf()
    {
        var input = @"
public class C
{
    public void M(string myParam)
    {
        if (myParam == null)
        {
            throw new ArgumentNullException(""myParam"");
        }
    }
}";
        var expected = @"
public class C
{
    public void M(string myParam)
    {
        if (myParam == null)
        {
            throw new ArgumentNullException(nameof(myParam));
        }
    }
}";

        var result = _converter.Apply(input);

        Assert.AreEqual(expected, result);
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void Apply_ArgumentException_ConvertsParameterNameToNameOf()
    {
        var input = @"
public class C
{
    public void M(int count)
    {
        if (count < 0)
        {
            throw new ArgumentException(""Count cannot be negative."", ""count"");
        }
    }
}";
        var expected = @"
public class C
{
    public void M(int count)
    {
        if (count < 0)
        {
            throw new ArgumentException(""Count cannot be negative."", nameof(count));
        }
    }
}";

        var result = _converter.Apply(input);

        Assert.AreEqual(expected, result);
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void Apply_UnknownIdentifier_DoesNotConvert()
    {
        var input = @"
public class C
{
    public void M(int count)
    {
        throw new ArgumentNullException(""nonExistentParam"");
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
