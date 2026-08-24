using Microsoft.VisualStudio.TestTools.UnitTesting;
using CodeJanitor.Logic.Transformations;

namespace CodeJanitor.UnitTests.Transformations;

/// <summary>
/// Unit tests for <see cref="SealedClassConverter" />.
/// Policy (ADR-0007): sealing is opt-in and API-changing (CA1852-style), so scope is limited
/// to top-level classes that are not public/protected (i.e. cannot be inherited outside the
/// assembly), not already sealed/abstract/static/partial, and provably not derived from by any
/// other type declared in the same file. This is a single-file heuristic: it cannot see
/// derived types declared in other files of the same assembly, so it remains an explicit
/// opt-in setting.
/// </summary>

[TestClass]
public sealed class SealedClassConverterTests
{
    private IClassSealingConverter _converter;

    [TestInitialize]
    public void TestInitialize()
    {
        _converter = new SealedClassConverter();
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void InternalClassWithNoDerivedTypeInFile_BecomesSealed()
    {
        var input = "internal class Foo { }";
        var expected = "internal sealed class Foo { }";

        Assert.AreEqual(expected, _converter.SealWhenSafe(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void ClassWithNoAccessModifier_BecomesSealed()
    {
        var input = "class Foo { }";
        var expected = "sealed class Foo { }";

        Assert.AreEqual(expected, _converter.SealWhenSafe(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void ClassWithDerivedClassInSameFile_StaysUnsealed()
    {
        var input = "internal class Foo { } internal class Bar : Foo { }";
        var expected = "internal class Foo { } internal sealed class Bar : Foo { }";

        Assert.AreEqual(expected, _converter.SealWhenSafe(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void AlreadySealedClass_Unchanged()
    {
        var input = "internal sealed class Foo { }";

        Assert.AreEqual(input, _converter.SealWhenSafe(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void AbstractClass_Unchanged()
    {
        var input = "internal abstract class Foo { }";

        Assert.AreEqual(input, _converter.SealWhenSafe(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void StaticClass_Unchanged()
    {
        var input = "internal static class Foo { }";

        Assert.AreEqual(input, _converter.SealWhenSafe(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void PartialClass_Unchanged()
    {
        var input = "internal partial class Foo { }";

        Assert.AreEqual(input, _converter.SealWhenSafe(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void PublicClass_BecomesSealed()
    {
        var input = "public class Foo { }";
        var expected = "public sealed class Foo { }";

        Assert.AreEqual(expected, _converter.SealWhenSafe(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void PublicClassWithDerivedClassInSameFile_BaseStaysUnsealed_DerivedBecomesSealed()
    {
        var input = "public class Animal { } public class Dog : Animal { }";
        var expected = "public class Animal { } public sealed class Dog : Animal { }";

        Assert.AreEqual(expected, _converter.SealWhenSafe(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void PublicRecordClass_BecomesSealed()
    {
        var input = "public record Person(string Name);";
        var expected = "public sealed record Person(string Name);";

        Assert.AreEqual(expected, _converter.SealWhenSafe(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void RecordStruct_Unchanged()
    {
        var input = "public record struct Point(int X, int Y);";

        Assert.AreEqual(input, _converter.SealWhenSafe(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void ClassImplementingInterface_BecomesSealed()
    {
        var input = "internal class Foo : System.IDisposable { public void Dispose() { } }";
        var expected = "internal sealed class Foo : System.IDisposable { public void Dispose() { } }";

        Assert.AreEqual(expected, _converter.SealWhenSafe(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void NestedClassIsNotSealed_OnlyOuterConsidered()
    {
        var input = "internal class Outer { internal class Inner { } }";
        var expected = "internal sealed class Outer { internal class Inner { } }";

        Assert.AreEqual(expected, _converter.SealWhenSafe(input));
    }
}
