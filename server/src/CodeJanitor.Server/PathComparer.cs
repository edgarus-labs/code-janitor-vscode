namespace CodeJanitor.Server;

/// <summary>Compares file paths as the file system does: case-insensitively on Windows and macOS.</summary>
internal static class PathComparer
{
    public static readonly StringComparer Instance =
        OperatingSystem.IsWindows() || OperatingSystem.IsMacOS() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;

    public static StringComparison Comparison =>
        OperatingSystem.IsWindows() || OperatingSystem.IsMacOS() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

    /// <summary>True when <paramref name="path"/> is <paramref name="directory"/> or lies under it.</summary>
    public static bool IsUnder(string path, string directory)
    {
        var root = Path.TrimEndingDirectorySeparator(directory);
        var isFilesystemRoot = root.Length > 0 && IsSeparator(root[^1]);

        return path.Equals(root, Comparison)
            || (path.Length > root.Length && path.StartsWith(root, Comparison) && (isFilesystemRoot || IsSeparator(path[root.Length])));
    }

    private static bool IsSeparator(char character) => character == Path.DirectorySeparatorChar || character == Path.AltDirectorySeparatorChar;
}
