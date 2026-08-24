using System.Linq;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using CodeJanitor.Logic.Transformations;

namespace CodeJanitor.UnitTests.Transformations;

/// <summary>
/// Unit tests for <see cref="SourceTransformationPipeline" />. Verifies that composable blocks
/// run in order and feed each other, which is the core "flow" of the headless-Roslyn cleanup
/// path (BL-018).
/// </summary>

[TestClass]
public sealed class SourceTransformationPipelineTests
{
    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void EmptyPipeline_ReturnsSourceUnchanged()
    {
        var pipeline = new SourceTransformationPipeline();
        var input = "class C\n{\n}\n";

        Assert.AreEqual(input, pipeline.Run(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void SingleBlock_IsApplied()
    {
        var pipeline = new SourceTransformationPipeline(new TabToSpaceConverter());
        var input = "class C\n{\n\tint x;\n}\n";
        var expected = "class C\n{\n    int x;\n}\n";

        Assert.AreEqual(expected, pipeline.Run(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void MultipleBlocks_RunInOrderAndFeedEachOther()
    {
        // Tab-indented, unsorted usings inside a namespace. First convert tabs to spaces, then
        // sort the using directives - each block consumes the previous block's output.
        var pipeline = new SourceTransformationPipeline(
            new TabToSpaceConverter(),
            new UsingDirectiveOrganizer());

        var input = "namespace N\n{\n\tusing B;\n\tusing A;\n}\n";
        var expected = "namespace N\n{\n    using A;\n    using B;\n}\n";

        Assert.AreEqual(expected, pipeline.Run(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void NullBlocks_AreIgnored()
    {
        var pipeline = new SourceTransformationPipeline(null, new TabToSpaceConverter(), null);
        var input = "class C\n{\n\tint x;\n}\n";
        var expected = "class C\n{\n    int x;\n}\n";

        Assert.AreEqual(expected, pipeline.Run(input));
        Assert.AreEqual(1, pipeline.Transformations.Count);
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void Transformations_ExposedInOrder()
    {
        var pipeline = new SourceTransformationPipeline(
            new TabToSpaceConverter(),
            new UsingDirectiveOrganizer());

        var names = pipeline.Transformations.Select(t => t.Name).ToList();

        Assert.AreEqual(2, names.Count);
        Assert.AreEqual("Convert tabs to spaces", names[0]);
        Assert.AreEqual("Sort using directives", names[1]);
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void EmptySource_ReturnsUnchanged()
    {
        var pipeline = new SourceTransformationPipeline(new TabToSpaceConverter());

        Assert.AreEqual(string.Empty, pipeline.Run(string.Empty));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void FullFlow_TabsThenTrailingThenSortThenFinalNewline()
    {
        // Tab-indented, unsorted usings with trailing spaces and no final newline. The blocks run
        // in order: expand tabs, strip trailing whitespace, sort usings, ensure final newline.
        var pipeline = new SourceTransformationPipeline(
            new TabToSpaceConverter(),
            new RemoveTrailingWhitespaceConverter(),
            new UsingDirectiveOrganizer(),
            new EnsureFinalNewlineConverter());

        var input = "namespace N\n{\n\tusing B;  \n\tusing A;\n}";
        var expected = "namespace N\n{\n    using A;\n    using B;\n}\n";

        Assert.AreEqual(expected, pipeline.Run(input));
    }

    [TestMethod]
    [TestCategory("Transformations UnitTests")]
    public void AdaptedConverters_AreComposableInPipeline()
    {
        // Verify that VarWhenApparentConverter, ReadonlyFieldConverter, SealedClassConverter,
        // and FileScopedNamespaceConverter (which were adapted to implement ISourceTransformation)
        // can be instantiated and composed in a pipeline with other blocks.
        var pipeline = new SourceTransformationPipeline(
            new UsingDirectiveOrganizer(),
            new VarWhenApparentConverter(),
            new ReadonlyFieldConverter(),
            new SealedClassConverter(),
            new FileScopedNamespaceConverter());

        // A simple example: namespace that gets converted to file-scoped. The var/readonly/sealed
        // converters won't apply but should not disrupt the pipeline.
        // FileScopedNamespaceConverter appends: header + "namespace N;" + newline + newline + dedented body + newline
        var input = "namespace N\n{\n\tusing B;\n\tusing A;\n}\n";
        var expected = "using A;\nusing B;\n\nnamespace N;\n";

        var result = pipeline.Run(input);
        Assert.AreEqual(expected, result, $"Expected length: {expected.Length}, Actual length: {result.Length}. Expected repr: {repr(expected)}, Actual repr: {repr(result)}");

        // Verify all transformations are exposed with their names.
        var names = pipeline.Transformations.Select(t => t.Name).ToList();
        Assert.AreEqual(5, names.Count);
        Assert.IsTrue(names.Contains("Sort using directives"));
        Assert.IsTrue(names.Contains("Var When Apparent"));
        Assert.IsTrue(names.Contains("Readonly Field"));
        Assert.IsTrue(names.Contains("Sealed Class"));
        Assert.IsTrue(names.Contains("File-Scoped Namespace"));
    }

    private static string repr(string s)
    {
        return "\"" + s.Replace("\r", "\\r").Replace("\n", "\\n") + "\"";
    }
}
