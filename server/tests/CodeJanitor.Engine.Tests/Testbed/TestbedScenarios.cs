using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using CodeJanitor.Engine.CodeStyle;
using CodeJanitor.Engine.Contracts;
using CodeJanitor.Engine.Diagnostics;
using CodeJanitor.Engine.Settings;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Text;
using Xunit;

namespace CodeJanitor.Engine.Tests.Testbed;

/// <summary>
/// One scenario of the public Code Janitor testbed (<c>scenarios.json</c>): a C# file with deliberately bad code, the settings
/// that clean it and the checks the cleaned text must pass.
/// </summary>
public sealed record TestbedScenario(
    string Id,
    string Category,
    string File,
    string Entry,
    JsonObject Settings,
    JsonObject CodeStyle,
    bool EditorConfig,
    bool AlwaysOn,
    bool Everything,
    bool Trap,
    bool ReportOnly,
    bool Policy,
    string? KnownDefect,
    string? ExpectedNamespace,
    JsonObject? UserSettings,
    JsonObject? UserCodeStyle,
    IReadOnlyList<JsonObject> Checks)
{
    /// <summary>The absolute path of the scenario file.</summary>
    public string FullPath => Path.GetFullPath(Path.Combine(TestbedScenarios.Root!, File));

    /// <inheritdoc/>
    public override string ToString() => Id;
}

/// <summary>
/// The shared xunit helper for the testbed (<c>.testbed</c>, a clone of edgarus-labs/code-janitor-testbed): finds it through
/// <c>CODE_JANITOR_TESTBED</c> or <c>&lt;repo&gt;/.testbed</c>, loads <c>scenarios.json</c>, builds the workspace documents of the
/// scenarios (the testbed's C# projects Scenarios, Scenarios.TopLevel, Scenarios.MainMethod and Scenarios.Sealing as one ad-hoc solution with their <c>.editorconfig</c> files, like MSBuildWorkspace
/// loads them) and evaluates the checks.
/// </summary>
public static class TestbedScenarios
{
    /// <summary>Options with no effect on the text of one file (git history or a whole workspace).</summary>
    public static readonly IReadOnlySet<string> NotATextTransformation = new HashSet<string>(StringComparer.Ordinal) { "onlyChangedLines", "renamePublicSymbolsAcrossWorkspace" };

    private static readonly (string Name, OutputKind Kind)[] Projects =
    [
        ("Scenarios", OutputKind.ConsoleApplication),
        ("Scenarios.TopLevel", OutputKind.ConsoleApplication),
        ("Scenarios.MainMethod", OutputKind.ConsoleApplication),
        ("Scenarios.Sealing", OutputKind.DynamicallyLinkedLibrary),
    ];

    private static readonly string[] PreprocessorSymbols =
    [
        "DEBUG", "TRACE", "NET", "NET10_0", "NETCOREAPP",
        "NET5_0_OR_GREATER", "NET6_0_OR_GREATER", "NET7_0_OR_GREATER", "NET8_0_OR_GREATER", "NET9_0_OR_GREATER", "NET10_0_OR_GREATER",
        "NETCOREAPP1_0_OR_GREATER", "NETCOREAPP2_0_OR_GREATER", "NETCOREAPP3_0_OR_GREATER", "NETCOREAPP3_1_OR_GREATER",
    ];

    private static readonly string[] NoWarn = ["CS0169", "CS0219", "CS0414", "CS0618", "CS0649", "CS0168", "CS8618", "CS1030"];

    private static readonly Lazy<string?> LazyRoot = new(FindRoot);
    private static readonly Lazy<IReadOnlyList<TestbedScenario>> LazyAll = new(Load);
    private static readonly Lazy<Solution> LazySolution = new(CreateSolution);
    private static readonly ConcurrentDictionary<string, Solution> LooseSolutions = new(StringComparer.Ordinal);

    /// <summary>The testbed directory, or null when it is not present.</summary>
    public static string? Root => LazyRoot.Value;

    /// <summary>Whether the testbed is present.</summary>
    public static bool IsAvailable => Root is not null;

    /// <summary>Every scenario, in file order; throws <see cref="TestbedHelp.Missing"/> without a testbed.</summary>
    public static IReadOnlyList<TestbedScenario> All => LazyAll.Value;

    /// <summary>The scenario with the id.</summary>
    public static TestbedScenario Get(string id) => All.Single(scenario => scenario.Id == id);

    /// <summary>The ids of the scenarios matching <paramref name="filter"/>, as xunit <c>MemberData</c> rows.</summary>
    public static TheoryData<string> Ids(Func<TestbedScenario, bool> filter)
    {
        var data = new TheoryData<string>();
        foreach (var scenario in All.Where(filter))
        {
            data.Add(scenario.Id);
        }

        return data;
    }

    /// <summary>The default settings with every boolean off and no C# file header.</summary>
    public static JsonObject AllOff()
    {
        var settings = CleanupSettingsDefaults.Create();
        foreach (var key in settings.Select(entry => entry.Key).ToList())
        {
            if (settings[key]?.GetValueKind() is JsonValueKind.True or JsonValueKind.False)
            {
                settings[key] = false;
            }
        }

        settings["fileHeaderCSharp"] = string.Empty;

        return settings;
    }

    /// <summary>Every boolean on (but the options that are not text transformations) and every Code Style rule at its proposed value.</summary>
    public static JsonObject EverythingOn()
    {
        var settings = CleanupSettingsDefaults.Create();
        foreach (var key in settings.Select(entry => entry.Key).ToList())
        {
            if (settings[key]?.GetValueKind() is JsonValueKind.True or JsonValueKind.False)
            {
                settings[key] = !NotATextTransformation.Contains(key);
            }
        }

        var rules = new JsonObject();
        foreach (var rule in CodeStyleRules.All)
        {
            rules[rule.Key] = rule.DefaultValue;
        }

        settings["codeStyleRules"] = rules;

        return settings;
    }

    /// <summary>The user settings of a scenario: all off with its settings and Code Style rules on, or everything on.</summary>
    public static JsonObject SettingsOf(TestbedScenario scenario)
    {
        if (scenario.Everything)
        {
            var everything = EverythingOn();
            if (scenario.Settings["reorganize"] is JsonObject reorganize)
            {
                var merged = (JsonObject)everything["reorganize"]!.DeepClone();
                foreach (var (key, value) in reorganize)
                {
                    if (key != "memberTypes")
                    {
                        merged[key] = value?.DeepClone();
                    }
                }

                everything["reorganize"] = merged;
            }

            return everything;
        }

        var settings = AllOff();
        foreach (var (key, value) in Merge(scenario.UserSettings, scenario.Settings))
        {
            if (!settings.ContainsKey(key))
            {
                throw new InvalidOperationException($"{scenario.Id}: unknown setting {key}");
            }

            if (key == "reorganize" && value is JsonObject reorganize)
            {
                var merged = (JsonObject)settings["reorganize"]!.DeepClone();
                foreach (var (option, optionValue) in reorganize)
                {
                    if (option == "memberTypes" && optionValue is JsonObject memberTypes)
                    {
                        var types = (JsonObject)merged["memberTypes"]!;
                        foreach (var (type, typeValue) in memberTypes)
                        {
                            types[type] = typeValue?.DeepClone();
                        }
                    }
                    else
                    {
                        merged[option] = optionValue?.DeepClone();
                    }
                }

                settings["reorganize"] = merged;
            }
            else
            {
                settings[key] = ToProtocol(key, value);
            }
        }

        var rules = new JsonObject();
        foreach (var (key, value) in Merge(scenario.UserCodeStyle, scenario.CodeStyle))
        {
            var rule = CodeStyleRules.Find(key) ?? throw new InvalidOperationException($"{scenario.Id}: unknown Code Style rule {key}");
            var text = value?.GetValue<string>();
            rules[key] = string.IsNullOrEmpty(text) ? rule.DefaultValue : text;
        }

        settings["codeStyleRules"] = rules;

        return settings;
    }

    /// <summary>The testbed's C# projects as one solution (cached; documents carry the files' text without a byte order mark).</summary>
    public static Solution Solution => LazySolution.Value;

    /// <summary>
    /// The document of a scenario file, optionally with another text (a leading U+FEFF marks a byte order mark). A file in no
    /// testbed project gets an ad-hoc project of its own, with the <c>.editorconfig</c> files above it.
    /// </summary>
    public static Document CreateDocument(TestbedScenario scenario, string? text = null) => CreateDocument(scenario.FullPath, text);

    /// <summary>The document of a file of the testbed, optionally with another text.</summary>
    public static Document CreateDocument(string fullPath, string? text = null)
    {
        var solution = Solution;
        var documentId = solution.GetDocumentIdsWithFilePath(fullPath).FirstOrDefault();
        if (documentId is null)
        {
            solution = LooseSolutions.GetOrAdd(fullPath, CreateLooseSolution);
            documentId = solution.GetDocumentIdsWithFilePath(fullPath).Single();
        }

        return text is null ? solution.GetDocument(documentId)! : solution.WithDocumentText(documentId, ToSourceText(text)).GetDocument(documentId)!;
    }

    /// <summary>Reads a file as the host does: the text with a leading U+FEFF when the file has a UTF-8 byte order mark.</summary>
    public static string ReadText(string fullPath)
    {
        var bytes = System.IO.File.ReadAllBytes(fullPath);
        var bom = bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF;
        var text = new UTF8Encoding(false).GetString(bytes, bom ? 3 : 0, bytes.Length - (bom ? 3 : 0));

        return bom ? "\uFEFF" + text : text;
    }

    /// <summary>A source text as the host builds it: without the U+FEFF, which becomes the text's encoding preamble.</summary>
    public static SourceText ToSourceText(string text)
    {
        var bom = text.StartsWith('\uFEFF');

        return SourceText.From(bom ? text[1..] : text, new UTF8Encoding(bom));
    }

    /// <summary>The text of a document as the host writes it: a leading U+FEFF when its encoding has a preamble.</summary>
    public static async Task<string> TextOfAsync(Document document)
    {
        var text = await document.GetTextAsync();

        return (text.Encoding?.GetPreamble().Length > 0 ? "\uFEFF" : string.Empty) + text;
    }

    /// <summary>Why <paramref name="output"/> fails the checks of the scenario; empty when it passes them.</summary>
    public static IReadOnlyList<string> Failures(TestbedScenario scenario, string output, IReadOnlyList<string> issues) =>
        scenario.Checks.Select(check => Failure(check, output, issues)).OfType<string>().ToList();

    /// <summary>Why <paramref name="output"/> fails one check, or null when it passes.</summary>
    public static string? Failure(JsonObject check, string output, IReadOnlyList<string> issues)
    {
        var text = output.Replace("\r\n", "\n", StringComparison.Ordinal);
        string S(string key) => check[key]!.GetValue<string>();

        switch (check["t"]?.GetValue<string>())
        {
            case "contains":
                return text.Contains(S("s"), StringComparison.Ordinal) ? null : $"expected the output to contain {JsonSerializer.Serialize(S("s"))}";
            case "absent":
                return text.Contains(S("s"), StringComparison.Ordinal) ? $"expected the output NOT to contain {JsonSerializer.Serialize(S("s"))}" : null;
            case "startsWith":
                return text.StartsWith(S("s"), StringComparison.Ordinal) ? null : $"expected the output to start with {JsonSerializer.Serialize(S("s"))}";
            case "endsWith":
                return text.EndsWith(S("s"), StringComparison.Ordinal) ? null : $"expected the output to end with {JsonSerializer.Serialize(S("s"))}";
            case "noBom":
                return text.StartsWith('\uFEFF') ? "expected the byte order mark to be removed" : null;
            case "reported":
                return issues.Any(issue => Regex.IsMatch(issue, S("re"))) ? null : $"expected a reported issue matching /{S("re")}/, got: {JsonSerializer.Serialize(issues)}";
            case "order":
                {
                    var from = 0;
                    foreach (var part in check["s"]!.AsArray().Select(node => node!.GetValue<string>()))
                    {
                        var at = text.IndexOf(part, from, StringComparison.Ordinal);
                        if (at < 0)
                        {
                            return $"expected {JsonSerializer.Serialize(part)} after {(from == 0 ? "the start" : "the previous part")}";
                        }

                        from = at + part.Length;
                    }

                    return null;
                }

            case "blankBetween":
            case "noBlankBetween":
                {
                    var a = S("a");
                    var b = S("b");
                    var first = text.IndexOf(a, StringComparison.Ordinal);
                    var second = first < 0 ? -1 : text.IndexOf(b, first + a.Length, StringComparison.Ordinal);
                    if (first < 0 || second < 0)
                    {
                        return $"could not find {JsonSerializer.Serialize(first < 0 ? a : b)} (in order) in the output";
                    }

                    var blank = Regex.IsMatch(text[(first + a.Length)..second], @"\n[ \t]*\n");
                    var wanted = check["t"]!.GetValue<string>() == "blankBetween";

                    return blank == wanted ? null : wanted ? $"expected a blank line between {JsonSerializer.Serialize(a)} and {JsonSerializer.Serialize(b)}" : $"expected no blank line between {JsonSerializer.Serialize(a)} and {JsonSerializer.Serialize(b)}";
                }

            default:
                return $"unknown check type {check["t"]?.ToJsonString()}";
        }
    }

    private static IEnumerable<KeyValuePair<string, JsonNode?>> Merge(JsonObject? first, JsonObject second)
    {
        var merged = new Dictionary<string, JsonNode?>(StringComparer.Ordinal);
        foreach (var (key, value) in first ?? [])
        {
            merged[key] = value;
        }

        foreach (var (key, value) in second)
        {
            merged[key] = value;
        }

        return merged;
    }

    private static JsonNode? ToProtocol(string key, JsonNode? value) => key switch
    {
        "fileHeaderPosition" when value?.GetValueKind() == JsonValueKind.Number => value.GetValue<int>() == 1 ? "afterUsings" : "documentStart",
        "fileHeaderUpdateMode" when value?.GetValueKind() == JsonValueKind.Number => value.GetValue<int>() == 1 ? "replace" : "insert",
        _ => value?.DeepClone(),
    };

    private static string? FindRoot()
    {
        var candidates = new List<string?> { Environment.GetEnvironmentVariable("CODE_JANITOR_TESTBED") };
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            candidates.Add(Path.Combine(directory.FullName, ".testbed"));
        }

        candidates.Add("/root/dev/code-janitor-vscode/.testbed");

        return candidates.Where(candidate => !string.IsNullOrEmpty(candidate) && System.IO.File.Exists(Path.Combine(candidate, "scenarios.json")))
            .Select(candidate => Path.GetFullPath(candidate!))
            .FirstOrDefault();
    }

    private static IReadOnlyList<TestbedScenario> Load()
    {
        if (Root is null)
        {
            throw new InvalidOperationException(TestbedHelp.Missing);
        }

        var file = JsonNode.Parse(System.IO.File.ReadAllText(Path.Combine(Root, "scenarios.json")))!;

        return file["scenarios"]!.AsArray().Select(node =>
        {
            var entry = node!.AsObject();
            bool Flag(string key) => entry[key]?.GetValueKind() == JsonValueKind.True;
            string? Text(string key) => entry[key]?.GetValueKind() == JsonValueKind.String ? entry[key]!.GetValue<string>() : null;

            return new TestbedScenario(
                Text("id")!,
                Text("category")!,
                Text("file")!,
                Text("entry")!,
                (JsonObject)(entry["settings"]?.DeepClone() ?? new JsonObject()),
                (JsonObject)(entry["codeStyle"]?.DeepClone() ?? new JsonObject()),
                Flag("editorconfig"),
                Flag("alwaysOn"),
                Flag("everything"),
                Flag("trap"),
                Flag("reportOnly"),
                Flag("policy"),
                Text("knownDefect"),
                Text("expectedNamespace"),
                entry["userSettings"]?.DeepClone() as JsonObject,
                entry["userCodeStyle"]?.DeepClone() as JsonObject,
                entry["checks"]!.AsArray().Select(check => (JsonObject)check!.DeepClone()).ToList());
        }).ToList();
    }

    private static Solution CreateSolution()
    {
        var workspace = new AdhocWorkspace(HostAnalyzers.HostServices);
        var solution = workspace.CurrentSolution;
        if (Root is null)
        {
            throw new InvalidOperationException(TestbedHelp.Missing);
        }

        var editorConfigs = Directory.EnumerateFiles(Root, ".editorconfig", SearchOption.AllDirectories).Where(path => !IsBuildOutput(path)).ToList();
        foreach (var (name, kind) in Projects)
        {
            var directory = Path.Combine(Root, "src", name);
            if (!Directory.Exists(directory))
            {
                continue;
            }

            var files = Directory.EnumerateFiles(directory, "*.cs", SearchOption.AllDirectories).Where(path => !IsBuildOutput(path)).Order(StringComparer.Ordinal);
            solution = AddProject(solution, name, directory, files, editorConfigs, kind, allowUnsafe: name == "Scenarios");
        }

        return solution;
    }

    private static Solution CreateLooseSolution(string fullPath)
    {
        var solution = new AdhocWorkspace(HostAnalyzers.HostServices).CurrentSolution;
        var editorConfigs = new List<string>();
        for (var directory = Path.GetDirectoryName(fullPath); !string.IsNullOrEmpty(directory); directory = Path.GetDirectoryName(directory))
        {
            var config = Path.Combine(directory, ".editorconfig");
            if (System.IO.File.Exists(config))
            {
                editorConfigs.Add(config);
            }
        }

        return AddProject(solution, Path.GetFileNameWithoutExtension(fullPath), Path.GetDirectoryName(fullPath)!, [fullPath], editorConfigs, OutputKind.DynamicallyLinkedLibrary, allowUnsafe: true);
    }

    private static Solution AddProject(Solution solution, string name, string directory, IEnumerable<string> files, IEnumerable<string> editorConfigs, OutputKind outputKind, bool allowUnsafe)
    {
        var projectId = ProjectId.CreateNewId(name);
        var parseOptions = new CSharpParseOptions(LanguageVersion.Default, DocumentationMode.Parse, preprocessorSymbols: PreprocessorSymbols);
        var compilationOptions = new CSharpCompilationOptions(
                outputKind,
                nullableContextOptions: NullableContextOptions.Enable,
                allowUnsafe: allowUnsafe)
            .WithSpecificDiagnosticOptions(NoWarn.ToDictionary(id => id, _ => ReportDiagnostic.Suppress));

        var documents = files.Select(path => DocumentInfo.Create(
            DocumentId.CreateNewId(projectId, path),
            Path.GetFileName(path),
            Path.GetRelativePath(directory, Path.GetDirectoryName(path)!).Split(Path.DirectorySeparatorChar).Where(folder => folder != ".").ToList(),
            SourceCodeKind.Regular,
            TextLoader.From(TextAndVersion.Create(ToSourceText(ReadText(path)), VersionStamp.Create(), path)),
            path)).ToList();

        var globalConfigPath = Path.Combine(directory, name + ".GeneratedMSBuildEditorConfig.editorconfig");
        var globalConfig = $"is_global = true\nbuild_property.RootNamespace = {name}\nbuild_property.ProjectDir = {directory}{Path.DirectorySeparatorChar}\n";
        var configs = editorConfigs
            .Select(path => DocumentInfo.Create(DocumentId.CreateNewId(projectId, path), ".editorconfig", loader: TextLoader.From(TextAndVersion.Create(SourceText.From(System.IO.File.ReadAllText(path)), VersionStamp.Create(), path)), filePath: path))
            .Append(DocumentInfo.Create(DocumentId.CreateNewId(projectId, globalConfigPath), Path.GetFileName(globalConfigPath), loader: TextLoader.From(TextAndVersion.Create(SourceText.From(globalConfig), VersionStamp.Create(), globalConfigPath)), filePath: globalConfigPath))
            .ToList();

        var project = ProjectInfo.Create(
                projectId,
                VersionStamp.Create(),
                name,
                name,
                LanguageNames.CSharp,
                filePath: Path.Combine(directory, name + ".csproj"),
                compilationOptions: compilationOptions,
                parseOptions: parseOptions,
                documents: documents,
                metadataReferences: RuntimeReferences.Value,
                analyzerReferences: SdkAnalyzers.Value)
            .WithAnalyzerConfigDocuments(configs)
            .WithDefaultNamespace(name);

        return solution.AddProject(project);
    }

    private static bool IsBuildOutput(string path) =>
        path.Split(Path.DirectorySeparatorChar).Any(segment => segment is "bin" or "obj" or ".git");

    private static readonly Lazy<ImmutableArray<MetadataReference>> RuntimeReferences = new(() =>
        ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator)
            .Where(path => Path.GetFileName(path).StartsWith("System.", StringComparison.Ordinal) || Path.GetFileName(path) is "mscorlib.dll" or "netstandard.dll" or "Microsoft.Win32.Primitives.dll" or "Microsoft.CSharp.dll")
            .Where(path => Path.GetDirectoryName(path) == Path.GetDirectoryName(typeof(object).Assembly.Location))
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
            .ToImmutableArray());

    /// <summary>The .NET analyzers of the installed SDK, which MSBuildWorkspace gives every net5+ project.</summary>
    private static readonly Lazy<ImmutableArray<AnalyzerReference>> SdkAnalyzers = new(() =>
    {
        var runtimeDirectory = RuntimeEnvironment.GetRuntimeDirectory();
        var dotnetRoot = Path.GetFullPath(Path.Combine(runtimeDirectory, "..", "..", ".."));
        var sdk = Directory.Exists(Path.Combine(dotnetRoot, "sdk"))
            ? NewestSdk(Directory.GetDirectories(Path.Combine(dotnetRoot, "sdk")))
            : null;
        var analyzers = sdk is null ? null : Path.Combine(sdk, "Sdks", "Microsoft.NET.Sdk", "analyzers");
        if (analyzers is null || !Directory.Exists(analyzers))
        {
            return [];
        }

        string[] files = ["Microsoft.CodeAnalysis.NetAnalyzers.dll", "Microsoft.CodeAnalysis.CSharp.NetAnalyzers.dll"];

        return files
            .Select(file => Path.Combine(analyzers, file))
            .Where(System.IO.File.Exists)
            .Select(path => (AnalyzerReference)new AnalyzerFileReference(path, LoadFromLoader.Instance))
            .ToImmutableArray();
    });

    /// <summary>The SDK folder with the highest version number, a release before a preview of the same number.</summary>
    internal static string? NewestSdk(IEnumerable<string> directories) => directories
        .Select(folder => (Folder: folder, Name: Path.GetFileName(folder)))
        .Select(sdk => (sdk.Folder, Release: !sdk.Name.Contains('-', StringComparison.Ordinal), Version: Version.TryParse(sdk.Name.Split('-')[0], out var version) ? version : null))
        .Where(sdk => sdk.Version is not null)
        .OrderByDescending(sdk => sdk.Version)
        .ThenByDescending(sdk => sdk.Release)
        .Select(sdk => sdk.Folder)
        .FirstOrDefault();

    private sealed class LoadFromLoader : IAnalyzerAssemblyLoader
    {
        public static readonly LoadFromLoader Instance = new();

        public void AddDependencyLocation(string fullPath)
        {
        }

        public Assembly LoadFromPath(string fullPath) => Assembly.LoadFrom(fullPath);
    }
}
