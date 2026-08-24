using Microsoft.VisualStudio.TestTools.UnitTesting;
using CodeJanitor.Logic.Transformations;

namespace CodeJanitor.UnitTests.Transformations;

/// <summary>
/// Unit tests for <see cref="MoveUsingsOutsideNamespaceConverter" />.
/// Pure transformation tests (no Visual Studio / EnvDTE required).
/// </summary>
[TestClass]
public sealed class MoveUsingsOutsideNamespaceConverterTests
{
    private MoveUsingsOutsideNamespaceConverter _converter;

    [TestInitialize]
    public void TestInitialize()
    {
        _converter = new MoveUsingsOutsideNamespaceConverter();
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void MovesUsingsFromBlockNamespaceToTop()
    {
        var input = "namespace CodeJanitor\r\n{\r\n    using System;\r\n    using System.Collections.Generic;\r\n\r\n    public class Sample\r\n    {\r\n    }\r\n}\r\n";
        var result = _converter.MoveUsingsOutside(input);

        StringAssert.StartsWith(result, "using System;\r\nusing System.Collections.Generic;\r\n\r\nnamespace CodeJanitor");
        Assert.IsFalse(result.Contains("{\r\n    using System;"));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void MovesUsingsFromFileScopedNamespaceToTop()
    {
        var input = "namespace CodeJanitor;\r\n\r\nusing System;\r\nusing System.Linq;\r\n\r\npublic class Sample\r\n{\r\n}\r\n";
        var result = _converter.MoveUsingsOutside(input);

        StringAssert.StartsWith(result, "using System;\r\nusing System.Linq;\r\n\r\nnamespace CodeJanitor;");
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void AlreadyAtTop_ReturnsUnchanged()
    {
        var input = "using System;\r\n\r\nnamespace CodeJanitor\r\n{\r\n    public class Sample\r\n    {\r\n    }\r\n}\r\n";
        var result = _converter.MoveUsingsOutside(input);

        Assert.AreEqual(input, result);
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void MergesAndDeduplicatesExistingTopUsingsWithNamespaceUsings()
    {
        var input = "using System;\r\nusing System.Text;\r\n\r\nnamespace CodeJanitor\r\n{\r\n    using System;\r\n    using System.Collections.Generic;\r\n\r\n    public class Sample\r\n    {\r\n    }\r\n}\r\n";
        var result = _converter.MoveUsingsOutside(input);

        StringAssert.StartsWith(result, "using System;\r\nusing System.Text;\r\nusing System.Collections.Generic;\r\n\r\nnamespace CodeJanitor");
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void PreservesFileHeaderWhenMovingUsingsToTop()
    {
        var input = "// Copyright (c) 2026\r\n\r\nnamespace CodeJanitor\r\n{\r\n    using System;\r\n\r\n    public class Sample\r\n    {\r\n    }\r\n}\r\n";
        var result = _converter.MoveUsingsOutside(input);

        StringAssert.StartsWith(result, "// Copyright (c) 2026\r\n\r\nusing System;\r\n\r\nnamespace CodeJanitor");
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void CombinedWithFileScopedConverter_ProducesCleanModernFileScopedCode()
    {
        var input = "namespace CodeJanitor\r\n{\r\n    using System;\r\n\r\n    public class Sample\r\n    {\r\n    }\r\n}\r\n";

        var pipeline = new SourceTransformationPipeline(
            new MoveUsingsOutsideNamespaceConverter(),
            new FileScopedNamespaceConverter());

        var result = pipeline.Run(input);

        var expected = "using System;\r\n\r\nnamespace CodeJanitor;\r\n\r\npublic class Sample\r\n{\r\n}\r\n";
        Assert.AreEqual(expected, result);
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void MoveUsingsOutside_OnCodeJanitorCs_MovesUsingsToTop()
    {
        var path = @"D:\dev\code-janitor\CodeJanitor\CodeJanitor.cs";
        if (System.IO.File.Exists(path))
        {
            var content = System.IO.File.ReadAllText(path);
            var result = _converter.MoveUsingsOutside(content);
            StringAssert.StartsWith(result, "using System;\r\n\r\nnamespace CodeJanitor");
            Assert.IsFalse(result.Contains("namespace CodeJanitor\r\n{\r\n    using System;"));
        }
    }
}
