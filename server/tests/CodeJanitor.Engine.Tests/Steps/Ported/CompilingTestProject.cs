#nullable disable
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;

namespace CodeJanitor.Engine.Tests.Steps;

/// <summary>
/// Builds an in-memory C# project (mscorlib only, unsafe code allowed) so tests can bind a document semantically and
/// compile transformed output.
/// </summary>
internal static class CompilingTestProject
{
    /// <summary>
    /// Creates the target document <c>Target.cs</c> in a project that also contains <paramref name="librarySources" />.
    /// </summary>
    public static Document CreateDocument(string source, params string[] librarySources)
        => CreateDocument(source, LanguageVersion.Latest, new MetadataReference[0], librarySources);

    /// <summary>
    /// Creates the target document <c>Target.cs</c> in a project with the given language version and additional
    /// metadata references (for example System.Core or System.Text.Json).
    /// </summary>
    public static Document CreateDocument(
        string source,
        LanguageVersion languageVersion,
        IEnumerable<MetadataReference> additionalReferences,
        params string[] librarySources)
        => CreateDocument(source, new CSharpParseOptions(languageVersion), additionalReferences, librarySources);

    /// <summary>
    /// Creates the target document <c>Target.cs</c> in a project with the given parse options (for example the
    /// preprocessor symbols of a build configuration) and additional metadata references.
    /// </summary>
    public static Document CreateDocument(
        string source,
        CSharpParseOptions parseOptions,
        IEnumerable<MetadataReference> additionalReferences,
        params string[] librarySources)
        => AddProject(new AdhocWorkspace().CurrentSolution, "TestProject", parseOptions, additionalReferences, librarySources)
            .AddDocument("Target.cs", SourceText.From(source));

    /// <summary>
    /// Creates the target document <c>Target.cs</c> in a project that also contains <paramref name="librarySources" />
    /// and references a second project, <c>ReferencedProject</c>, made of <paramref name="referencedSources" />.
    /// </summary>
    public static Document CreateDocumentReferencingProject(string source, IEnumerable<string> referencedSources, params string[] librarySources)
    {
        CSharpParseOptions parseOptions = new CSharpParseOptions(LanguageVersion.Latest);
        Project referenced = AddProject(new AdhocWorkspace().CurrentSolution, "ReferencedProject", parseOptions, new MetadataReference[0], referencedSources);

        return AddProject(referenced.Solution, "TestProject", parseOptions, new MetadataReference[0], librarySources)
            .AddProjectReference(new ProjectReference(referenced.Id))
            .AddDocument("Target.cs", SourceText.From(source));
    }

    private static Project AddProject(
        Solution solution,
        string name,
        CSharpParseOptions parseOptions,
        IEnumerable<MetadataReference> additionalReferences,
        IEnumerable<string> sources)
    {
        Project project = solution
            .AddProject(name, name, LanguageNames.CSharp)
            .WithCompilationOptions(new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, allowUnsafe: true))
            .WithParseOptions(parseOptions)
            .AddMetadataReferences(RuntimeReferences)
            .AddMetadataReferences(additionalReferences);

        int index = 0;
        foreach (string source in sources)
        {
            project = project.AddDocument($"Library{index++}.cs", SourceText.From(source)).Project;
        }

        return project;
    }

    /// <summary>
    /// The core assemblies of the running .NET (System.Private.CoreLib, System.Runtime, System.Linq, ...), the
    /// counterpart of mscorlib and System.Core on .NET Framework; System.Text.Json and the rest are added by the tests
    /// that need them.
    /// </summary>
    private static MetadataReference[] RuntimeReferences { get; } = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES"))
        .Split(System.IO.Path.PathSeparator)
        .Where(path => System.IO.Path.GetFileName(path) is "System.Private.CoreLib.dll" or "System.Runtime.dll" or "System.Linq.dll" or "System.Linq.Expressions.dll" or "System.Linq.Queryable.dll" or "System.Collections.dll" or "netstandard.dll" or "mscorlib.dll")
        .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
        .ToArray();

    /// <summary>The runtime assembly with the given name (for example <c>System.Text.Json</c>).</summary>
    public static MetadataReference RuntimeAssembly(string name) => MetadataReference.CreateFromFile(((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES"))
        .Split(System.IO.Path.PathSeparator)
        .Single(path => System.IO.Path.GetFileNameWithoutExtension(path) == name));

    /// <summary>
    /// Compiles the project of <paramref name="document" /> with the document text replaced by
    /// <paramref name="text" /> and returns every compile error as "ID: message".
    /// </summary>
    public static async Task<IReadOnlyList<string>> GetCompileErrorsAsync(Document document, string text)
    {
        Compilation compilation = await document.WithText(SourceText.From(text)).Project.GetCompilationAsync();

        return compilation.GetDiagnostics()
            .Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error)
            .Select(diagnostic => $"{diagnostic.Id}: {diagnostic.GetMessage(CultureInfo.InvariantCulture)}")
            .ToList();
    }
}
