namespace CodeJanitor.Server;

/// <summary>
/// A path with the symbolic links (and junctions) of it resolved, so that one folder has one spelling: on macOS the temporary
/// folder and <c>/tmp</c> are links, and a process started there reports its working directory without them.
/// </summary>
internal static class RealPath
{
    public static string Resolve(string path)
    {
        var full = Path.GetFullPath(path);
        var root = Path.GetPathRoot(full) ?? string.Empty;
        var current = root;
        foreach (var part in full[root.Length..].Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
        {
            current = Path.Combine(current, part);
            FileSystemInfo entry = Directory.Exists(current) ? new DirectoryInfo(current) : new FileInfo(current);
            if (entry.Exists && entry.LinkTarget is not null && entry.ResolveLinkTarget(returnFinalTarget: true) is { } target)
            {
                current = target.FullName;
            }
        }

        return current;
    }
}
