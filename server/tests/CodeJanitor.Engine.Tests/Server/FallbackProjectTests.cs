using CodeJanitor.Server;
using Xunit;

namespace CodeJanitor.Engine.Tests.Server;

public sealed class FallbackProjectTests
{
    [Fact]
    public void The_chain_stops_at_the_first_editorconfig_with_root_true()
    {
        using var tree = new TempTree();
        tree.Write(".editorconfig", "[*.cs]\nindent_size = 8\n");
        var nested = tree.Write("src/.editorconfig", "root = true\n\n[*.cs]\nindent_size = 2\n");
        var reported = new List<string>();

        var chain = FallbackProject.EditorConfigChain(Path.GetDirectoryName(nested), reported.Add).ToList();

        Assert.Equal([nested], chain);
        Assert.Empty(reported);
    }

    [Theory]
    [InlineData(typeof(IOException))]
    [InlineData(typeof(UnauthorizedAccessException))]
    public void An_editorconfig_that_cannot_be_read_is_reported_and_the_files_above_it_still_apply(Type failure)
    {
        using var tree = new TempTree();
        var parent = tree.Write(".editorconfig", "root = true\n");
        var nested = tree.Write("src/.editorconfig", "[*.cs]\nindent_size = 2\n");
        var reported = new List<string>();

        var chain = FallbackProject.EditorConfigChain(
                Path.GetDirectoryName(nested),
                reported.Add,
                path => path == nested ? throw (Exception)Activator.CreateInstance(failure, "denied")! : File.ReadLines(path))
            .ToList();

        Assert.Equal([nested, parent], chain);
        var message = Assert.Single(reported);
        Assert.Contains(nested, message, StringComparison.Ordinal);
        Assert.Contains("denied", message, StringComparison.Ordinal);
    }
}
