using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using CodeJanitor.Engine.Contracts;
using CodeJanitor.Engine.Reorganize;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;
using Xunit;

namespace CodeJanitor.Engine.Tests.Reorganize;

/// <summary>Runs the reorganizer on a snippet, compiled with the runtime's assemblies and the SDK's implicit usings.</summary>
internal static class ReorganizeHarness
{
    private const string GlobalUsings = """
        global using System;
        global using System.Collections.Generic;
        global using System.IO;
        global using System.Linq;
        global using System.Net.Http;
        global using System.Reflection;
        global using System.Runtime.InteropServices;
        global using System.Text.RegularExpressions;
        global using System.Threading;
        global using System.Threading.Tasks;
        """;

    private static readonly Lazy<MetadataReference[]> References = new(() =>
        ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator)
            .Where(path => Path.GetFileName(path).StartsWith("System.", StringComparison.Ordinal) || Path.GetFileName(path) is "mscorlib.dll" or "netstandard.dll")
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
            .ToArray());

    private static readonly CSharpParseOptions ParseOptions = CSharpParseOptions.Default.WithLanguageVersion(LanguageVersion.Preview);

    private static readonly SyntaxTree UsingsTree = CSharpSyntaxTree.ParseText(GlobalUsings, ParseOptions, path: "GlobalUsings.cs");

    public static string Lines(params string[] lines) => string.Join("\n", lines);

    /// <summary>The tree of <paramref name="source"/> in a compilation, with its semantic model.</summary>
    public static (SyntaxTree Tree, SemanticModel Model) Compile(string source, CSharpParseOptions? options = null)
    {
        var tree = CSharpSyntaxTree.ParseText(SourceText.From(source), options ?? ParseOptions, path: "Test.cs");
        var compilation = CSharpCompilation.Create(
            "Test",
            [UsingsTree, tree],
            References.Value,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, allowUnsafe: true, nullableContextOptions: NullableContextOptions.Enable));

        return (tree, compilation.GetSemanticModel(tree));
    }

    /// <summary>Reorganizes a snippet; a leading byte order mark is kept, as a document's encoding keeps it.</summary>
    public static ReorganizeResult Detailed(string source, ReorganizeSettings? settings = null, ReorganizeCleanup? cleanup = null)
    {
        if (source.StartsWith('\uFEFF'))
        {
            var inner = Detailed(source[1..], settings, cleanup);

            return inner with { Output = "\uFEFF" + inner.Output };
        }

        var (tree, model) = Compile(source);

        return Reorganizer.Reorganize(tree, model, settings ?? new ReorganizeSettings(), cleanup ?? ReorganizeCleanup.Default);
    }

    /// <summary>Reorganizes a snippet without padding and proves a second run changes nothing.</summary>
    public static string Run(string source, ReorganizeSettings? settings = null, ReorganizeCleanup? cleanup = null)
    {
        cleanup ??= ReorganizeCleanup.WithoutPadding;
        var output = Detailed(source, settings, cleanup).Output;
        Assert.Equal(output, Detailed(output, settings, cleanup).Output);

        return output;
    }

    /// <summary>The names of the members declared at the start of their lines, in order.</summary>
    public static string[] Members(string result) =>
        Regex.Matches(result, @"^\s+(?:public |private |static |readonly |const )*[\w<>\[\], ()?]+ (\w+)(?: =|;| \{|\()", RegexOptions.Multiline)
            .Select(match => match.Groups[1].Value)
            .ToArray();

    /// <summary>Settings for the engine's entry points, from a JSON object of <c>CleanupSettings</c> values.</summary>
    public static IEffectiveSettings EngineSettings(JsonObject? values = null) => new TestSettings(values ?? []);

    public static async Task<Document> DocumentAsync(string source, string path = "Test.cs")
    {
        var workspace = new AdhocWorkspace();
        var project = workspace.AddProject(ProjectInfo.Create(
            ProjectId.CreateNewId(),
            VersionStamp.Default,
            "Test",
            "Test",
            LanguageNames.CSharp,
            compilationOptions: new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, allowUnsafe: true),
            parseOptions: ParseOptions,
            metadataReferences: References.Value));
        project = project.AddDocument("GlobalUsings.cs", GlobalUsings).Project;
        var document = project.AddDocument(Path.GetFileName(path), SourceText.From(source), filePath: path);
        await Task.CompletedTask;

        return document;
    }

    private sealed class TestSettings(JsonObject values) : IEffectiveSettings
    {
        public bool GetBool(string key) =>
            values[key] is JsonValue value && value.TryGetValue<bool>(out var flag) ? flag : ReorganizeCleanup.Defaults.TryGetValue(key, out var fallback) && fallback;

        public string GetString(string key) => values[key]?.GetValue<string>() ?? string.Empty;

        public int GetInt(string key) => values[key]?.GetValue<int>() ?? 0;

        public IReadOnlyList<string> GetList(string key) => values[key] is JsonArray array ? array.Select(item => item!.GetValue<string>()).ToList() : [];

        public JsonNode? GetNode(string key) => values[key];

        public string? EditorConfigValue(string key) => null;
    }
}
