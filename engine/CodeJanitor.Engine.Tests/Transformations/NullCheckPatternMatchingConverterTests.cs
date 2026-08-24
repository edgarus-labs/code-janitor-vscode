using Microsoft.VisualStudio.TestTools.UnitTesting;
using CodeJanitor.Logic.Transformations;

namespace CodeJanitor.UnitTests.Transformations;

/// <summary>
/// Unit tests for <see cref="NullCheckPatternMatchingConverter" />.
/// </summary>
[TestClass]
public sealed class NullCheckPatternMatchingConverterTests
{
    private NullCheckPatternMatchingConverter _converter;

    [TestInitialize]
    public void TestInitialize()
    {
        _converter = new NullCheckPatternMatchingConverter();
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void Name_IsNotEmpty()
    {
        Assert.IsFalse(string.IsNullOrWhiteSpace(_converter.Name));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void Apply_NotEqualsNull_ConvertsToIsNotNull()
    {
        var input = @"
public class C
{
    public void M(object x)
    {
        if (x != null)
        {
            DoWork();
        }
    }
}";
        var expected = @"
public class C
{
    public void M(object x)
    {
        if (x is not null)
        {
            DoWork();
        }
    }
}";

        var result = _converter.Apply(input);

        Assert.AreEqual(expected, result);
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void Apply_EqualsEqualsNull_ConvertsToIsNull()
    {
        var input = @"
public class C
{
    public void M(object x)
    {
        if (x == null)
        {
            return;
        }
    }
}";
        var expected = @"
public class C
{
    public void M(object x)
    {
        if (x is null)
        {
            return;
        }
    }
}";

        var result = _converter.Apply(input);

        Assert.AreEqual(expected, result);
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void Apply_ReversedNullChecks_ConvertsProperly()
    {
        var input = @"
public class C
{
    public void M(object a, object b)
    {
        if (null != a && null == b)
        {
            DoWork();
        }
    }
}";
        var expected = @"
public class C
{
    public void M(object a, object b)
    {
        if (a is not null && b is null)
        {
            DoWork();
        }
    }
}";

        var result = _converter.Apply(input);

        Assert.AreEqual(expected, result);
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void Apply_TernaryAndReturnExpressions_ConvertsProperly()
    {
        var input = @"
public class C
{
    public bool Check(object x, object y)
    {
        var flag = x != null ? true : false;
        return y == null;
    }
}";
        var expected = @"
public class C
{
    public bool Check(object x, object y)
    {
        var flag = x is not null ? true : false;
        return y is null;
    }
}";

        var result = _converter.Apply(input);

        Assert.AreEqual(expected, result);
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void Apply_NullOrEmpty_ReturnsOriginal()
    {
        Assert.IsNull(_converter.Apply(null));
        Assert.AreEqual(string.Empty, _converter.Apply(string.Empty));
    }
}
