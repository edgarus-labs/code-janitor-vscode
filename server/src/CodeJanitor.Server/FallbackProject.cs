using System.Collections.Immutable;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace CodeJanitor.Server;

/// <summary>
/// The ad-hoc C# project of a file outside every loadable project: the running .NET runtime's assemblies as references
/// and the file's <c>.editorconfig</c> files as analyzer config documents.
/// </summary>
internal static partial class FallbackProject
{
    private static readonly Lazy<ImmutableArray<MetadataReference>> RuntimeReferences = new(LoadRuntimeReferences);

    /// <summary>A solution of <paramref name="empty"/> with the fallback project of <paramref name="filePath"/>, and its document.</summary>
    public static (Solution Solution, DocumentId DocumentId) Create(Solution empty, string filePath, Action<string> report)
    {
        var name = Path.GetFileNameWithoutExtension(filePath);
        var projectId = ProjectId.CreateNewId(name);
        var documentId = DocumentId.CreateNewId(projectId, filePath);
        var editorConfigs = EditorConfigChain(Path.GetDirectoryName(filePath), report)
            .Select(path => DocumentInfo.Create(DocumentId.CreateNewId(projectId, path), Path.GetFileName(path), loader: new FileTextLoader(path, defaultEncoding: null), filePath: path));
        var project = ProjectInfo.Create(
                projectId,
                VersionStamp.Create(),
                name,
                name,
                LanguageNames.CSharp,
                compilationOptions: new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, nullableContextOptions: NullableContextOptions.Enable, allowUnsafe: true),
                parseOptions: new CSharpParseOptions(LanguageVersion.Default),
                documents: [DocumentInfo.Create(documentId, Path.GetFileName(filePath), loader: new FileTextLoader(filePath, defaultEncoding: null), filePath: filePath)],
                metadataReferences: RuntimeReferences.Value)
            .WithAnalyzerConfigDocuments(editorConfigs);

        return (empty.AddProject(project), documentId);
    }

    /// <summary>The <c>.editorconfig</c> files from <paramref name="directory"/> up to the first one with <c>root = true</c>.</summary>
    internal static IEnumerable<string> EditorConfigChain(string? directory, Action<string> report, Func<string, IEnumerable<string>>? readLines = null)
    {
        for (var current = directory; current is not null; current = Path.GetDirectoryName(current))
        {
            var path = Path.Combine(current, ".editorconfig");
            if (!File.Exists(path))
            {
                continue;
            }

            yield return path;
            if (IsRoot(path, report, readLines ?? File.ReadLines))
            {
                yield break;
            }
        }
    }

    private static bool IsRoot(string editorConfig, Action<string> report, Func<string, IEnumerable<string>> readLines)
    {
        try
        {
            foreach (var line in readLines(editorConfig))
            {
                var trimmed = line.Trim();
                if (trimmed.StartsWith('['))
                {
                    return false;
                }

                if (RootDeclaration().IsMatch(trimmed))
                {
                    return true;
                }
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            report($"{editorConfig} could not be read ({exception.Message}), so whether it is a root .editorconfig is unknown and the .editorconfig files above it are applied too.");
        }

        return false;
    }

    private static ImmutableArray<MetadataReference> LoadRuntimeReferences()
    {
        var runtimeDirectory = RuntimeEnvironment.GetRuntimeDirectory();
        var trusted = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string ?? string.Empty;

        return [.. trusted.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
            .Where(path => path.EndsWith(".dll", StringComparison.OrdinalIgnoreCase) && PathComparer.IsUnder(path, runtimeDirectory))
            .Order(StringComparer.Ordinal)
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))];
    }

    [GeneratedRegex(@"^root\s*=\s*true\s*([#;].*)?$", RegexOptions.IgnoreCase)]
    private static partial Regex RootDeclaration();
}
