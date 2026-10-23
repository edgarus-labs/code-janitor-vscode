namespace CodeJanitor.Server;

internal static class RealPath
{
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

                current = Resolve(target.FullName, ref links);
            }
        }

        return current;
    }
}
