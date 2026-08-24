using Microsoft.VisualStudio.TestTools.UnitTesting;
using CodeJanitor.Logic.Transformations;

namespace CodeJanitor.UnitTests.Transformations;

/// <summary>
/// Unit tests for <see cref="StringInterpolationConverter" />.
/// </summary>
[TestClass]
public sealed class StringInterpolationConverterTests
{
    private StringInterpolationConverter _converter;

    [TestInitialize]
    public void TestInitialize()
    {
        _converter = new StringInterpolationConverter();
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void Name_IsNotEmpty()
    {
        Assert.IsFalse(string.IsNullOrWhiteSpace(_converter.Name));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void Apply_SimpleStringFormat_ConvertsToInterpolatedString()
    {
        var input = @"
public class C
{
    public string M(string name, int count)
    {
        return string.Format(""Hello {0}, you have {1} messages."", name, count);
    }
}";
        var expected = @"
public class C
{
    public string M(string name, int count)
    {
        return $""Hello {name}, you have {count} messages."";
    }
}";

        var result = _converter.Apply(input);

        Assert.AreEqual(expected, result);
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void Apply_StringFormatWithFormatSpecifier_ConvertsProperly()
    {
        var input = @"
public class C
{
    public string M(double price)
    {
        return string.Format(""Price: {0:C2}"", price);
    }
}";
        var expected = @"
public class C
{
    public string M(double price)
    {
        return $""Price: {price:C2}"";
    }
}";

        var result = _converter.Apply(input);

        Assert.AreEqual(expected, result);
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void Apply_StringFormatWithAlignment_ConvertsProperly()
    {
        var input = @"
public class C
{
    public string M(int id)
    {
        return string.Format(""ID: {0,5}"", id);
    }
}";
        var expected = @"
public class C
{
    public string M(int id)
    {
        return $""ID: {id,5}"";
    }
}";

        var result = _converter.Apply(input);

        Assert.AreEqual(expected, result);
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void Apply_NonLiteralFormatString_Skipped()
    {
        var input = @"
public class C
{
    public string M(string template, int value)
    {
        return string.Format(template, value);
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
