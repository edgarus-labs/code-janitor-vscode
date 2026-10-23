using System.Runtime.CompilerServices;

namespace CodeJanitor.Engine.Tests.Server;

/// <summary>A temporary folder of files, deleted on dispose.</summary>
internal sealed class TempTree : IDisposable
{
    public TempTree()
    {
        Root = Path.Combine(Path.GetTempPath(), "cj-server-" + Guid.NewGuid().ToString("N")[..12]);
        Directory.CreateDirectory(Root);
    }

    public string Root { get; }

    public string PathOf(string relative) => Path.Combine(Root, relative.Replace('/', Path.DirectorySeparatorChar));

    public string Write(string relative, string text)
    {
        var path = PathOf(relative);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, text);

        return path;
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(Root, recursive: true);
        }
        catch (IOException)
        {
        }
    }
}

internal static class ServerTestPaths
{
    public const string Project = "<Project Sdk=\"Microsoft.NET.Sdk\">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n    <Nullable>enable</Nullable>\n  </PropertyGroup>\n</Project>\n";

    /// <summary>The clone of the testbed repository: <c>CODE_JANITOR_TESTBED</c>, else <c>.testbed</c> in the repository root.</summary>
    public static string Testbed()
    {
        var configured = Environment.GetEnvironmentVariable("CODE_JANITOR_TESTBED");
        var root = string.IsNullOrEmpty(configured) ? Path.Combine(RepositoryRoot(), ".testbed") : Path.GetFullPath(configured);

        return File.Exists(Path.Combine(root, "scenarios.json")) ? root : throw new InvalidOperationException(Engine.Tests.Testbed.TestbedHelp.Missing);
    }

    public static string RepositoryRoot([CallerFilePath] string source = "") =>
        Path.GetFullPath(Path.Combine(Path.GetDirectoryName(source)!, "..", "..", "..", ".."));

    /// <summary>The built server next to the test assembly.</summary>
    public static string ServerAssembly() => Path.Combine(AppContext.BaseDirectory, "CodeJanitor.Server.dll");
}
