#nullable disable
#pragma warning disable RS1010, RS1025, RS1026, RS2008 // Test analyzers and fixers: no release tracking, minimal registration on purpose.

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection;
using CodeJanitor.Engine.Diagnostics;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CodeFixes;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Emit;
using Xunit;

namespace CodeJanitor.Engine.Tests.Diagnostics;

/// <summary>
/// Unit tests for <see cref="CodeFixProviderCatalog" />.
/// </summary>
public sealed class CodeFixProviderCatalogTests
{
    [Fact]
    public void GetProviders_ScansSolutionAnalyzerReferences_InDeterministicOrderWithoutDuplicates()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace();
        Project project = workspace.CreateSolution().Projects.Single();

        System.Collections.Immutable.ImmutableArray<CodeFixProvider> providers = new CodeFixProviderCatalog().GetProviders(project);

        Assert.True(providers.Any(provider => provider.FixableDiagnosticIds.Contains("IDE1006")), "The naming fixer of the host analyzer reference must be discovered.");
        List<string> typeNames = providers.Select(provider => provider.GetType().AssemblyQualifiedName).ToList();
        Assert.Equal(typeNames.OrderBy(name => name, StringComparer.Ordinal).ToList(), typeNames);
        Assert.Equal(typeNames.Count, (providers.Select(provider => provider.GetType().FullName).Distinct()).Count());
    }

    [Fact]
    public void GetProviders_HostSuppliedProvider_ReplacesScannedProviderOfTheSameType()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace();
        Project project = workspace.CreateSolution().Projects.Single();
        Type scannedType = new CodeFixProviderCatalog().GetProviders(project).Single(provider => provider.FixableDiagnosticIds.Contains("IDE1006")).GetType();
        CodeFixProvider hostInstance = (CodeFixProvider)Activator.CreateInstance(scannedType, nonPublic: true);

        System.Collections.Immutable.ImmutableArray<CodeFixProvider> providers = new CodeFixProviderCatalog(new[] { hostInstance }).GetProviders(project);

        Assert.Same(hostInstance, providers.Single(provider => provider.GetType().FullName == scannedType.FullName));
    }

    [Fact]
    public void GetProviders_WithoutProject_Throws() => Assert.Equal("project", Assert.Throws<ArgumentNullException>(() => new CodeFixProviderCatalog().GetProviders(null)).ParamName);

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void GetProviders_AnalyzerReferenceThatCannotBeLoaded_IsSkipped(bool fileExists)
    {
        string directory = CreateTempDirectory();
        try
        {
            string path = Path.Combine(directory, "Broken.Analyzers.dll");
            if (fileExists)
            {
                File.WriteAllText(path, "not an assembly");
            }

            CodeFixProvider hostProvider = new RenameLegacyFieldCodeFixProvider("CJT0500");
            using AdhocWorkspace workspace = new AdhocWorkspace();
            Project project = CreateProject(workspace, new AnalyzerFileReference(path, LoadFromPathLoader.Instance));

            ImmutableArray<CodeFixProvider> providers = new CodeFixProviderCatalog(new[] { hostProvider }).GetProviders(project);

            Assert.Same(hostProvider, providers.Single());
        }
        finally
        {
            Directory.Delete(directory, true);
        }
    }

    [Fact]
    public void GetProviders_AssemblyWithUnloadableTypesAndUnconstructibleFixers_ReturnsOnlyTheUsableFixers()
    {
        string directory = CreateTempDirectory();
        try
        {
            string path = Path.Combine(directory, "Partial.Analyzers.dll");
            File.WriteAllBytes(path, EmitPartiallyLoadableAnalyzerAssembly());
            using AdhocWorkspace workspace = new AdhocWorkspace();
            Project project = CreateProject(workspace, new AnalyzerFileReference(path, LoadFromBytesLoader.Instance));

            ImmutableArray<CodeFixProvider> providers = new CodeFixProviderCatalog().GetProviders(project);

            Assert.Equal(new[] { "LoadableFixer", "VisualBasicAndCSharpFixer" }, providers.Select(provider => provider.GetType().Name).ToArray());
            Assert.Equal(new[] { "CJT0501" }, providers[0].FixableDiagnosticIds.ToArray());
        }
        finally
        {
            Directory.Delete(directory, true);
        }
    }

    [Fact]
    public void GetLoadFailures_NamesTheFixersThatCouldNotBeCreatedAndTheTypesThatCouldNotBeLoaded()
    {
        string directory = CreateTempDirectory();
        try
        {
            string path = Path.Combine(directory, "Partial.Analyzers.dll");
            File.WriteAllBytes(path, EmitPartiallyLoadableAnalyzerAssembly());
            using AdhocWorkspace workspace = new AdhocWorkspace();
            Project project = CreateProject(workspace, new AnalyzerFileReference(path, LoadFromBytesLoader.Instance));

            ImmutableArray<string> failures = new CodeFixProviderCatalog().GetLoadFailures(project);

            Assert.Contains(failures, failure => failure.Contains("ThrowingFixer could not be created: InvalidOperationException", StringComparison.Ordinal));
            Assert.Contains(failures, failure => failure.Contains("ParameterizedFixer could not be created", StringComparison.Ordinal));
            Assert.Contains(failures, failure => failure.Contains("could not be loaded", StringComparison.Ordinal) && failure.Contains("Partial", StringComparison.Ordinal));
            Assert.DoesNotContain(failures, failure => failure.Contains("LoadableFixer", StringComparison.Ordinal) || failure.Contains("VisualBasicOnlyFixer", StringComparison.Ordinal));
        }
        finally
        {
            Directory.Delete(directory, true);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void GetLoadFailures_NamesTheAnalyzerReferenceThatCannotBeLoaded(bool fileExists)
    {
        string directory = CreateTempDirectory();
        try
        {
            string path = Path.Combine(directory, "Broken.Analyzers.dll");
            if (fileExists)
            {
                File.WriteAllText(path, "not an assembly");
            }

            using AdhocWorkspace workspace = new AdhocWorkspace();
            Project project = CreateProject(workspace, new AnalyzerFileReference(path, LoadFromPathLoader.Instance));

            ImmutableArray<string> failures = new CodeFixProviderCatalog().GetLoadFailures(project);

            Assert.Contains("Broken.Analyzers.dll", Assert.Single(failures), StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(directory, true);
        }
    }

    [Fact]
    public void GetLoadFailures_OfTheHostAnalyzers_IsEmpty()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace();

        Assert.Empty(new CodeFixProviderCatalog(hostReferences: HostAnalyzers.References).GetLoadFailures(workspace.CreateSolution().Projects.Single()));
    }

    private static string CreateTempDirectory()
    {
        string directory = Path.Combine(Path.GetTempPath(), "CodeJanitor.UnitTests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);

        return directory;
    }

    private static Project CreateProject(AdhocWorkspace workspace, AnalyzerReference reference) => workspace.CurrentSolution.AddProject("Analyzed", "Analyzed", LanguageNames.CSharp).AddAnalyzerReference(reference);

    /// <summary>
    /// Emits an analyzer assembly with a usable C# fixer, a fixer exported for Visual Basic and C#, a fixer exported
    /// only for Visual Basic, a fixer whose constructor throws, a fixer without a parameterless constructor and a type
    /// deriving from a class of an assembly that is never available at run time.
    /// </summary>
    private static byte[] EmitPartiallyLoadableAnalyzerAssembly()
    {
        MetadataReference missingDependency = Emit(
            "CodeJanitor.UnitTests.MissingDependency" + Guid.NewGuid().ToString("N"),
            "public class MissingBase { }",
            GetFrameworkReferences());

        const string FixerBody =
            " { public override ImmutableArray<string> FixableDiagnosticIds => ImmutableArray.Create(\"CJT0501\");" +
            " public override Task RegisterCodeFixesAsync(CodeFixContext context) => Task.CompletedTask; }\n";
        string source =
            "using System; using System.Collections.Immutable; using System.Threading.Tasks;\n" +
            "using Microsoft.CodeAnalysis; using Microsoft.CodeAnalysis.CodeFixes;\n" +
            "[ExportCodeFixProvider(LanguageNames.CSharp)] public sealed class LoadableFixer : CodeFixProvider" + FixerBody +
            "[ExportCodeFixProvider(LanguageNames.VisualBasic, LanguageNames.CSharp)] public sealed class VisualBasicAndCSharpFixer : CodeFixProvider" + FixerBody +
            "[ExportCodeFixProvider(LanguageNames.VisualBasic)] public sealed class VisualBasicOnlyFixer : CodeFixProvider" + FixerBody +
            "[ExportCodeFixProvider(LanguageNames.CSharp)] public sealed class ThrowingFixer : CodeFixProvider" +
            " { public ThrowingFixer() { throw new InvalidOperationException(); }" +
            " public override ImmutableArray<string> FixableDiagnosticIds => ImmutableArray<string>.Empty;" +
            " public override Task RegisterCodeFixesAsync(CodeFixContext context) => Task.CompletedTask; }\n" +
            "[ExportCodeFixProvider(LanguageNames.CSharp)] public sealed class ParameterizedFixer : CodeFixProvider" +
            " { public ParameterizedFixer(int value) { }" +
            " public override ImmutableArray<string> FixableDiagnosticIds => ImmutableArray<string>.Empty;" +
            " public override Task RegisterCodeFixesAsync(CodeFixContext context) => Task.CompletedTask; }\n" +
            "public class Unloadable : MissingBase { }\n";

        using MemoryStream stream = new MemoryStream();
        CSharpCompilation compilation = CSharpCompilation.Create(
            "CodeJanitor.UnitTests.PartialAnalyzers" + Guid.NewGuid().ToString("N"),
            new[] { CSharpSyntaxTree.ParseText(source) },
            GetFrameworkReferences().Concat(new[] { missingDependency }),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        EmitResult result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));

        return stream.ToArray();
    }

    private static MetadataReference Emit(string assemblyName, string source, IEnumerable<MetadataReference> references)
    {
        using MemoryStream stream = new MemoryStream();
        EmitResult result = CSharpCompilation.Create(assemblyName, new[] { CSharpSyntaxTree.ParseText(source) }, references, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)).Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));

        return MetadataReference.CreateFromImage(stream.ToArray());
    }

    private static IEnumerable<MetadataReference> GetFrameworkReferences() => AppDomain.CurrentDomain.GetAssemblies()
            .Where(assembly => !assembly.IsDynamic && !string.IsNullOrEmpty(assembly.Location))
            .GroupBy(assembly => assembly.GetName().Name, StringComparer.OrdinalIgnoreCase)
            .Select(group => (MetadataReference)MetadataReference.CreateFromFile(group.First().Location))
            .ToList();

    private sealed class LoadFromPathLoader : IAnalyzerAssemblyLoader
    {
        public static readonly LoadFromPathLoader Instance = new LoadFromPathLoader();

        public void AddDependencyLocation(string fullPath)
        {
        }

        public Assembly LoadFromPath(string fullPath) => Assembly.LoadFrom(fullPath);
    }

    private sealed class LoadFromBytesLoader : IAnalyzerAssemblyLoader
    {
        public static readonly LoadFromBytesLoader Instance = new LoadFromBytesLoader();

        public void AddDependencyLocation(string fullPath)
        {
        }

        public Assembly LoadFromPath(string fullPath) => Assembly.Load(File.ReadAllBytes(fullPath));
    }
}
