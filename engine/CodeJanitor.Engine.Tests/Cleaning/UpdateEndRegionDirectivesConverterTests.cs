using Microsoft.VisualStudio.TestTools.UnitTesting;
using CodeJanitor.Logic.Transformations;

namespace CodeJanitor.UnitTests.Cleaning;

[TestClass]
public sealed class UpdateEndRegionDirectivesConverterTests
{
    private UpdateEndRegionDirectivesConverter _converter;

    [TestInitialize]
    public void TestInitialize()
    {
        _converter = new UpdateEndRegionDirectivesConverter();
    }

    [TestMethod]
    public void EmptySource_ReturnsUnchanged()
    {
        var source = "";
        var result = _converter.Apply(source);
        Assert.AreEqual(source, result);
    }

    [TestMethod]
    public void NullSource_ReturnsUnchanged()
    {
        var result = _converter.Apply(null);
        Assert.IsNull(result);
    }

    [TestMethod]
    public void NoRegions_ReturnsUnchanged()
    {
        var source = "public class MyClass\r\n{\r\n}\r\n";
        var result = _converter.Apply(source);
        Assert.AreEqual(source, result);
    }

    [TestMethod]
    public void SingleRegionWithoutName_UpdatesEndregionCorrectly()
    {
        var source = "public class MyClass\r\n{\r\n    #region\r\n    public void MyMethod() { }\r\n    #endregion\r\n}\r\n";
        var result = _converter.Apply(source);
        // Empty region name should result in just "#endregion"
        Assert.IsTrue(result.Contains("#endregion\r\n"));
    }

    [TestMethod]
    public void SingleRegionWithName_UpdatesEndregionToMatchRegionName()
    {
        var source = "public class MyClass\r\n{\r\n    #region MyRegion\r\n    public void MyMethod() { }\r\n    #endregion WrongName\r\n}\r\n";
        var result = _converter.Apply(source);
        Assert.IsTrue(result.Contains("#endregion MyRegion"));
    }

    [TestMethod]
    public void MultipleRegions_UpdatesAllEndregionsCorrectly()
    {
        var source = "public class MyClass\r\n{\r\n    #region Fields\r\n    private int _field;\r\n    #endregion\r\n\r\n    #region Methods\r\n    public void MyMethod() { }\r\n    #endregion\r\n}\r\n";
        var result = _converter.Apply(source);
        Assert.IsTrue(result.Contains("#endregion Fields"));
        Assert.IsTrue(result.Contains("#endregion Methods"));
    }

    [TestMethod]
    public void NestedRegions_UpdatesAllEndregionsInStack()
    {
        var source = "#region Outer\r\n#region Inner\r\npublic class MyClass { }\r\n#endregion\r\n#endregion\r\n";
        var result = _converter.Apply(source);
        Assert.IsTrue(result.Contains("#endregion Inner"));
        Assert.IsTrue(result.Contains("#endregion Outer"));
    }

    [TestMethod]
    public void RegionWithWhitespaceNormalization_NormalizesWhitespace()
    {
        var source = "#region   MyRegion   \r\ncode\r\n#endregion\r\n";
        var result = _converter.Apply(source);
        // The region name is trimmed, so we should have "#endregion MyRegion"
        Assert.IsTrue(result.Contains("#endregion MyRegion"));
    }

    [TestMethod]
    public void PreservesIndentation()
    {
        var source = "public class MyClass\r\n{\r\n        #region Fields\r\n        private int _field;\r\n        #endregion OldName\r\n}\r\n";
        var result = _converter.Apply(source);
        // Should preserve the 8-space indentation
        Assert.IsTrue(result.Contains("        #endregion Fields"));
    }

    [TestMethod]
    public void MismatchedRegions_KeepsLineAsIs()
    {
        // More endregions than regions - the extra endregion should be kept as-is
        var source = "#region Fields\r\n#endregion WrongName1\r\n#endregion WrongName2\r\n";
        var result = _converter.Apply(source);
        // First endregion should be updated, second should be kept
        Assert.IsTrue(result.Contains("#endregion Fields"));
        Assert.IsTrue(result.Contains("#endregion WrongName2"));
    }
}
