namespace CodeJanitor.Server;

/// <summary>
/// A path with the symbolic links (and junctions) of it resolved, so that one folder has one spelling: on macOS the temporary
/// folder and <c>/tmp</c> are links, and a process started there reports its working directory without them.
/// </summary>
internal static class RealPath
{
    /// <summary>The most links one path may pass through, as the operating systems allow.</summary>
    private const int MaxLinks = 40;

    public static string Resolve(string path)
    {
        var links = 0;

        return Resolve(Path.GetFullPath(path), ref links);
    }

    private static string Resolve(string full, ref int links)
    {
        var root = Path.GetPathRoot(full) ?? string.Empty;
        var current = root;
        foreach (var part in full[root.Length..].Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
        {
            current = Path.Combine(current, part);
            FileSystemInfo entry = Directory.Exists(current) ? new DirectoryInfo(current) : new FileInfo(current);
            if (entry.Exists && entry.LinkTarget is not null && entry.ResolveLinkTarget(returnFinalTarget: true) is { } target)
            {
                if (++links > MaxLinks)
                {
                    throw new IOException($"Too many symbolic links: {full}");
                }

                // The target is a path of its own: on macOS the temporary folder /var/folders/... is reached through the link /var.
                current = Resolve(target.FullName, ref links);
            }
        }

        return current;
    }
}
