using Microsoft.VisualStudio.TestTools.UnitTesting;
using CodeJanitor.Logic.Transformations;

namespace CodeJanitor.UnitTests.Transformations;

/// <summary>
/// Unit tests for <see cref="FileScopedNamespaceConverter" />.
/// Pure transformation tests (no Visual Studio / EnvDTE required).
/// </summary>

[TestClass]
public sealed class FileScopedNamespaceConverterTests
{
    private INamespaceScopeConverter _converter;

    [TestInitialize]
    public void TestInitialize()
    {
        _converter = new FileScopedNamespaceConverter();
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void ConvertsSingleBlockNamespaceToFileScoped()
    {
        var input = "namespace A\r\n{\r\n    class C\r\n    {\r\n    }\r\n}\r\n";
        var expected = "namespace A;\r\n\r\nclass C\r\n{\r\n}\r\n";

        Assert.AreEqual(expected, _converter.ConvertToFileScoped(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void MovesUsingsOutsideNamespaceWhenConvertingToFileScoped()
    {
        var input = "namespace A\r\n{\r\n    using System;\r\n\r\n    class C\r\n    {\r\n    }\r\n}\r\n";
        var expected = "using System;\r\n\r\nnamespace A;\r\n\r\nclass C\r\n{\r\n}\r\n";

        Assert.AreEqual(expected, _converter.ConvertToFileScoped(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void AlreadyFileScoped_ReturnsUnchanged()
    {
        var input = "namespace A;\r\n\r\nclass C\r\n{\r\n}\r\n";

        Assert.AreEqual(input, _converter.ConvertToFileScoped(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void MultipleNamespaces_ReturnsUnchanged()
    {
        var input = "namespace A\r\n{\r\n}\r\nnamespace B\r\n{\r\n}\r\n";

        Assert.AreEqual(input, _converter.ConvertToFileScoped(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void NoNamespace_ReturnsUnchanged()
    {
        var input = "class C\r\n{\r\n}\r\n";

        Assert.AreEqual(input, _converter.ConvertToFileScoped(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void NestedNamespace_ReturnsUnchanged()
    {
        var input = "namespace A\r\n{\r\n    namespace B\r\n    {\r\n    }\r\n}\r\n";

        Assert.AreEqual(input, _converter.ConvertToFileScoped(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void PreservesFileHeaderAndOuterUsings()
    {
        var input = "// file header\r\nusing System;\r\n\r\nnamespace A\r\n{\r\n    class C\r\n    {\r\n    }\r\n}\r\n";
        var expected = "// file header\r\nusing System;\r\n\r\nnamespace A;\r\n\r\nclass C\r\n{\r\n}\r\n";

        Assert.AreEqual(expected, _converter.ConvertToFileScoped(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void HasMultipleNamespaces_MultipleTopLevelNamespaces_ReturnsTrue()
    {
        var input = "namespace A\r\n{\r\n}\r\nnamespace B\r\n{\r\n}\r\n";

        Assert.IsTrue(_converter.HasMultipleNamespaces(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void HasMultipleNamespaces_NestedNamespace_ReturnsTrue()
    {
        var input = "namespace A\r\n{\r\n    namespace B\r\n    {\r\n    }\r\n}\r\n";

        Assert.IsTrue(_converter.HasMultipleNamespaces(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void HasMultipleNamespaces_SingleBlockNamespace_ReturnsFalse()
    {
        var input = "namespace A\r\n{\r\n    class C\r\n    {\r\n    }\r\n}\r\n";

        Assert.IsFalse(_converter.HasMultipleNamespaces(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void HasMultipleNamespaces_SingleFileScopedNamespace_ReturnsFalse()
    {
        var input = "namespace A;\r\n\r\nclass C\r\n{\r\n}\r\n";

        Assert.IsFalse(_converter.HasMultipleNamespaces(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void HasMultipleNamespaces_NoNamespace_ReturnsFalse()
    {
        var input = "class C\r\n{\r\n}\r\n";

        Assert.IsFalse(_converter.HasMultipleNamespaces(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void ConvertsRealWorldReproFile_MultipleClassesFieldsPropertiesAndMethods()
    {
        // Mirrors the actual manual-test repro file used while diagnosing BUG-001
        // (scratch/BUG-001-repro, later copied into a playground console app), after a
        // Cleanup pass had already reorganized it: a single block-scoped namespace
        // containing two classes, with fields, properties, and methods (including a
        // private helper and local variable declarations).
        var input =
            "namespace CodeJanitor.Scratch.Bug001\r\n" +
            "{\r\n" +
            "    /// <summary>\r\n" +
            "    /// Repro for BUG-001: running CodeJanitor Cleanup/Reorganize on a file with a\r\n" +
            "    /// file-scoped namespace (C# 10+) should NOT remove or corrupt the\r\n" +
            "    /// \"namespace CodeJanitor.Scratch.Bug001;\" declaration line above.\r\n" +
            "    /// </summary>\r\n" +
            "\r\n" +
            "    public class FileScopedNamespaceSample\r\n" +
            "    {\r\n" +
            "        private List<string> _items = new List<string>();\r\n" +
            "\r\n" +
            "        public string Name { get; set; }\r\n" +
            "\r\n" +
            "        public void DoWork()\r\n" +
            "        {\r\n" +
            "            Console.WriteLine(\"hello\");\r\n" +
            "            var list = new List<string>();\r\n" +
            "            list.Add(\"a\");\r\n" +
            "        }\r\n" +
            "\r\n" +
            "        private void PrivateHelper()\r\n" +
            "        {\r\n" +
            "            int x = 5;\r\n" +
            "\r\n" +
            "            Console.WriteLine(x);\r\n" +
            "        }\r\n" +
            "    }\r\n" +
            "\r\n" +
            "    public class SecondClassInSameNamespace\r\n" +
            "    {\r\n" +
            "        public int Value { get; set; }\r\n" +
            "    }\r\n" +
            "}\r\n";

        Assert.IsFalse(_converter.HasMultipleNamespaces(input), "Repro file has exactly one namespace and should not be flagged as multiple.");

        var converted = _converter.ConvertToFileScoped(input);

        Assert.AreNotEqual(input, converted, "Expected the converter to change the block-scoped namespace to file-scoped.");
        StringAssert.Contains(converted, "namespace CodeJanitor.Scratch.Bug001;");
        StringAssert.Contains(converted, "public class FileScopedNamespaceSample");
        StringAssert.Contains(converted, "public class SecondClassInSameNamespace");
        StringAssert.Contains(converted, "public int Value { get; set; }");

        // The dedented body should no longer contain the original 4-space class indentation.
        Assert.IsFalse(converted.Contains("\r\n    public class FileScopedNamespaceSample"),
            "Expected class declarations to be dedented by one level after file-scoped conversion.");
    }
}
