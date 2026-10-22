using System.Text;
using System.Text.Json.Nodes;
using CodeJanitor.Engine.Contracts;
using CodeJanitor.Engine.Diagnostics;
using CodeJanitor.Engine.Settings;
using CodeJanitor.Engine.Steps;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;

namespace CodeJanitor.Engine.Tests.Steps.Support;

/// <summary>
/// Runs Code Janitor's own steps (the <see cref="ICleanupStep" />s of the Steps and Commands namespaces) on a document,
/// by stage and order, as the engine does.
/// </summary>
internal static class StepHarness
{
    private static readonly MetadataReference[] References = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
        .Split(Path.PathSeparator)
        .Where(path => Path.GetFileName(path).StartsWith("System.", StringComparison.Ordinal) || Path.GetFileName(path) is "mscorlib.dll" or "netstandard.dll")
        .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
        .ToArray();

    /// <summary>Every step of the Steps and Commands namespaces, by stage then order.</summary>
    public static IReadOnlyList<ICleanupStep> Steps { get; } = typeof(SourceTextStep).Assembly.GetTypes()
        .Where(type => typeof(ICleanupStep).IsAssignableFrom(type) && !type.IsAbstract && type.GetConstructor(Type.EmptyTypes) is not null)
        .Where(type => type.Namespace is "CodeJanitor.Engine.Steps" or "CodeJanitor.Engine.Commands")
        .Select(type => (ICleanupStep)Activator.CreateInstance(type)!)
        .OrderBy(step => step.Stage)
        .ThenBy(step => step.Order)
        .ToList();

    /// <summary>The user settings with every boolean off and no file header, then <paramref name="overrides" />.</summary>
    public static JsonObject AllOff(JsonObject? overrides = null)
    {
        var settings = CleanupSettingsDefaults.Create();
        foreach (var key in settings.Select(pair => pair.Key).ToList())
        {
            if (settings[key] is JsonValue value && value.GetValueKind() is System.Text.Json.JsonValueKind.True or System.Text.Json.JsonValueKind.False)
            {
                settings[key] = false;
            }
        }

        settings["fileHeaderCSharp"] = string.Empty;
        foreach (var (key, value) in overrides ?? [])
        {
            settings[key] = value?.DeepClone();
        }

        return settings;
    }

    public static IEffectiveSettings Settings(JsonObject user, IReadOnlyDictionary<string, string>? editorConfig = null, string filePath = "/src/Test.cs") =>
        EffectiveSettings.Create(filePath, user, editorConfig ?? new Dictionary<string, string>(), RepositoryPolicy.None);

    /// <summary>
    /// A document with <paramref name="text" /> at <paramref name="filePath" /> in a project referencing the runtime; a
    /// leading byte order mark becomes the encoding's preamble, as the host does.
    /// </summary>
    public static Document Document(string text, string filePath = "/src/Test.cs", params (string Path, string Text)[] others) =>
        Create(new AdhocWorkspace(), text, filePath, others);

    /// <summary>
    /// A document like <see cref="Document" /> in a workspace that has the host services of the diagnostics stage (analyzers
    /// and code fixes), for the whole cleanup engine.
    /// </summary>
    public static Document EngineDocument(string text, string filePath = "/src/Test.cs") =>
        Create(new AdhocWorkspace(HostAnalyzers.HostServices), text, filePath, []);

    private static Document Create(Workspace workspace, string text, string filePath, (string Path, string Text)[] others)
    {
        var bom = text.StartsWith('\uFEFF');
        var project = workspace.CurrentSolution
            .AddProject("Test", "Test", LanguageNames.CSharp)
            .WithCompilationOptions(new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, nullableContextOptions: NullableContextOptions.Enable))
            .WithParseOptions(new CSharpParseOptions(LanguageVersion.Latest))
            .AddMetadataReferences(References);
        foreach (var (path, otherText) in others)
        {
            project = project.AddDocument(System.IO.Path.GetFileName(path), SourceText.From(otherText), filePath: path).Project;
        }

        return project.AddDocument(System.IO.Path.GetFileName(filePath), SourceText.From(bom ? text[1..] : text, new UTF8Encoding(bom)), filePath: filePath);
    }

    /// <summary>Runs the enabled steps and returns the solution and the document's text (with "\uFEFF" for a preamble).</summary>
    public static async Task<(Solution Solution, string Text)> RunAsync(Document document, IEffectiveSettings settings)
    {
        var id = document.Id;
        var solution = document.Project.Solution;
        foreach (var step in Steps.Where(step => step.IsEnabled(settings)))
        {
            solution = await step.ApplyAsync(solution.GetDocument(id)!, settings, CancellationToken.None);
        }

        return (solution, await TextOfAsync(solution.GetDocument(id)!));
    }

    /// <summary>Runs the enabled steps on <paramref name="text" /> with <paramref name="user" /> settings.</summary>
    public static async Task<string> CleanAsync(string text, JsonObject user, IReadOnlyDictionary<string, string>? editorConfig = null, string filePath = "/src/Test.cs") =>
        (await RunAsync(Document(text, filePath), Settings(user, editorConfig, filePath))).Text;

    public static async Task<string> TextOfAsync(TextDocument document)
    {
        var text = await document.GetTextAsync();

        return (text.Encoding?.GetPreamble().Length > 0 ? "\uFEFF" : string.Empty) + text;
    }
}
