using CodeJanitor.Server;
using Xunit;

namespace CodeJanitor.Engine.Tests.Server;

public sealed class PathComparerTests
{
    private static readonly string Separator = Path.DirectorySeparatorChar.ToString();

    [Fact]
    public void A_path_is_under_the_directory_itself_or_any_folder_below_it()
    {
        var directory = Path.Combine(Path.GetTempPath(), "cj-paths", "repo");

        Assert.True(PathComparer.IsUnder(directory, directory));
        Assert.True(PathComparer.IsUnder(directory + Separator, directory));
        Assert.True(PathComparer.IsUnder(Path.Combine(directory, "src", "A.cs"), directory));
        Assert.True(PathComparer.IsUnder(Path.Combine(directory, "src"), directory + Separator));
    }

    [Fact]
    public void A_sibling_whose_name_starts_with_the_directory_name_is_not_under_it()
    {
        var directory = Path.Combine(Path.GetTempPath(), "cj-paths", "repo");

        Assert.False(PathComparer.IsUnder(directory + "-other" + Separator + "A.cs", directory));
        Assert.False(PathComparer.IsUnder(Path.GetDirectoryName(directory)!, directory));
    }

    [Fact]
    public void Every_path_of_the_drive_is_under_its_root()
    {
        var root = Path.GetPathRoot(Path.GetTempPath())!;
        var file = Path.Combine(Path.GetTempPath(), "cj-paths", "A.cs");

        Assert.True(PathComparer.IsUnder(root, root));
        Assert.True(PathComparer.IsUnder(file, root));
        Assert.True(PathComparer.IsUnder(Path.Combine(root, "A.cs"), root));
    }
}
