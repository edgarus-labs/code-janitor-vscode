using System.Collections.Immutable;
using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Host.Mef;

namespace CodeJanitor.Engine.Diagnostics;

/// <summary>
/// The IDE analyzers and code fixes of Roslyn (<c>Microsoft.CodeAnalysis(.CSharp).Features</c>), which Visual Studio hosts
/// as solution-level analyzer references: the engine analyzes every project with them on top of the project's own
/// analyzer references (the SDK and NuGet analyzers).
/// </summary>
public static class HostAnalyzers
{
    private static readonly Lazy<ImmutableArray<Assembly>> LazyFeaturesAssemblies = new(() =>
    [
        Assembly.Load(new AssemblyName("Microsoft.CodeAnalysis.Features")),
        Assembly.Load(new AssemblyName("Microsoft.CodeAnalysis.CSharp.Features")),
    ]);

    private static readonly Lazy<ImmutableArray<AnalyzerReference>> LazyReferences = new(() =>
        LazyFeaturesAssemblies.Value
            .Select(assembly => (AnalyzerReference)new AnalyzerFileReference(assembly.Location, LoadedAssemblyLoader.Instance))
            .ToImmutableArray());

    private static readonly Lazy<MefHostServices> LazyHostServices = new(() => MefHostServices.Create(MefHostAssemblies));

    /// <summary>The Roslyn Features assemblies.</summary>
    public static ImmutableArray<Assembly> FeaturesAssemblies => LazyFeaturesAssemblies.Value;

    /// <summary>The MEF assemblies a workspace needs for the code fixes (rename, formatting): the defaults plus the Features assemblies.</summary>
    public static IEnumerable<Assembly> MefHostAssemblies => MefHostServices.DefaultAssemblies.Concat(FeaturesAssemblies).Distinct();

    /// <summary>Host services built from <see cref="MefHostAssemblies"/>, shared by every workspace of the process.</summary>
    public static MefHostServices HostServices => LazyHostServices.Value;

    /// <summary>The Features assemblies as analyzer references.</summary>
    public static ImmutableArray<AnalyzerReference> References => LazyReferences.Value;

    /// <summary>Resolves analyzer assemblies to the ones the process already loaded, so analyzer and fixer types are the runtime types.</summary>
    private sealed class LoadedAssemblyLoader : IAnalyzerAssemblyLoader
    {
        public static readonly LoadedAssemblyLoader Instance = new();

        public void AddDependencyLocation(string fullPath)
        {
        }

        public Assembly LoadFromPath(string fullPath) => Assembly.Load(AssemblyName.GetAssemblyName(fullPath));
    }
}
