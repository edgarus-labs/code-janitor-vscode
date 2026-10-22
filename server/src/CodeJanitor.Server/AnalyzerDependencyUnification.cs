using System.Reflection;
using System.Runtime.Loader;

namespace CodeJanitor.Server;

/// <summary>
/// Analyzers and code fixes that the .NET SDK gives a project (NetAnalyzers, the code style analyzers) are built
/// against the SDK's own copies of shared dependencies such as <c>System.Composition.*</c>, which can be newer than
/// the ones the server ships. A request for such a dependency is answered with the server's copy, as Visual Studio
/// and the compiler server unify analyzer dependencies with the host's.
/// </summary>
internal static class AnalyzerDependencyUnification
{
    private static readonly string[] UnifiedPrefixes = ["System.Composition.", "Microsoft.CodeAnalysis"];

    public static void Register() => AssemblyLoadContext.Default.Resolving += Resolve;

    internal static Assembly? Resolve(AssemblyLoadContext context, AssemblyName requested)
    {
        if (requested.Name is not { } name || !UnifiedPrefixes.Any(prefix => name.StartsWith(prefix, StringComparison.Ordinal)))
        {
            return null;
        }

        var loaded = context.Assemblies.FirstOrDefault(assembly => string.Equals(assembly.GetName().Name, name, StringComparison.Ordinal));
        if (loaded is not null)
        {
            return loaded;
        }

        var shipped = Path.Combine(AppContext.BaseDirectory, name + ".dll");

        return File.Exists(shipped) ? context.LoadFromAssemblyPath(shipped) : null;
    }
}
