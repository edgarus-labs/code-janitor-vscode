using System.Collections.Concurrent;
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;

namespace CodeJanitor.Engine.Settings;

/// <summary>
/// Reads the <c>.editorconfig</c> options that apply to a source file through Roslyn's analyzer config engine, so section
/// globs, nearest-file-wins ordering, <c>root = true</c> and global configs behave as in the compiler. Keys are the
/// lower-cased option names; values are raw, including any <c>:severity</c> suffix. Diagnostic severities, which Roslyn
/// keeps apart, are included as <c>dotnet_diagnostic.&lt;lower-cased id&gt;.severity = none|silent|suggestion|warning|error</c>.
/// </summary>
public static class EditorConfigOptions
{
    /// <summary>The file name searched in the source file's directory and its ancestors.</summary>
    public const string EditorConfigFileName = ".editorconfig";

    private static readonly ConcurrentDictionary<string, (DateTime LastWriteTimeUtc, long Length, AnalyzerConfig Config)> ParsedConfigs =
        new(StringComparer.Ordinal);

    /// <summary>The most parsed <c>.editorconfig</c> files kept; beyond it the cache starts over.</summary>
    internal const int MaxCachedConfigs = 256;

    /// <summary>The number of cached parsed <c>.editorconfig</c> files.</summary>
    internal static int CachedConfigCount => ParsedConfigs.Count;

    /// <summary>Whether the parsed <c>.editorconfig</c> at <paramref name="configPath"/> is cached.</summary>
    internal static bool IsCached(string configPath) => ParsedConfigs.ContainsKey(configPath);

    /// <summary>Drops the cached parse of the <c>.editorconfig</c> at <paramref name="configPath"/>, for example when it changed or was deleted.</summary>
    public static void Forget(string configPath) => ParsedConfigs.TryRemove(configPath, out _);

    /// <summary>
    /// The options of the document from its project's analyzer config documents (which carry unsaved text), or from the
    /// <c>.editorconfig</c> files on disk when the project has none.
    /// </summary>
    public static async Task<IReadOnlyDictionary<string, string>> ForDocumentAsync(Document document, CancellationToken cancellationToken)
    {
        if (string.IsNullOrEmpty(document.FilePath))
        {
            return ImmutableDictionary<string, string>.Empty;
        }

        var configDocuments = document.Project.AnalyzerConfigDocuments.Where(config => config.FilePath is not null).ToList();
        if (configDocuments.Count == 0)
        {
            return Load(document.FilePath);
        }

        var configs = new List<AnalyzerConfig>(configDocuments.Count);
        foreach (var config in configDocuments)
        {
            var text = await config.GetTextAsync(cancellationToken).ConfigureAwait(false);
            configs.Add(AnalyzerConfig.Parse(text, config.FilePath));
        }

        return Merge(configs, document.FilePath);
    }

    /// <summary>
    /// The options of a file from the <c>.editorconfig</c> files of its directory and its ancestors. Never throws: blank or
    /// invalid paths and unreadable files yield no options.
    /// </summary>
    public static IReadOnlyDictionary<string, string> Load(string? filePath)
    {
        if (string.IsNullOrWhiteSpace(filePath))
        {
            return ImmutableDictionary<string, string>.Empty;
        }

        try
        {
            var fullPath = Path.GetFullPath(filePath);

            return Merge(LoadChain(fullPath).Select(entry => entry.Config).ToList(), fullPath);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return ImmutableDictionary<string, string>.Empty;
        }
    }

    /// <summary>
    /// The nearest <c>.editorconfig</c> on disk, among those Roslyn applies to <paramref name="filePath"/>, whose matching
    /// sections define <paramref name="key"/>; null when none does.
    /// </summary>
    public static string? FindDefiningConfigPath(string? filePath, string key)
    {
        if (string.IsNullOrWhiteSpace(filePath))
        {
            return null;
        }

        try
        {
            var fullPath = Path.GetFullPath(filePath);
            var chain = LoadChain(fullPath);
            if (!Merge(chain.Select(entry => entry.Config).ToList(), fullPath).ContainsKey(key))
            {
                return null;
            }

            return chain.First(entry => Merge([entry.Config], fullPath).ContainsKey(key)).Path;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return null;
        }
    }

    /// <summary>The key under which a diagnostic's configured severity is reported, e.g. <c>dotnet_diagnostic.ide0011.severity</c>.</summary>
    public static string DiagnosticSeverityKey(string diagnosticId) => "dotnet_diagnostic." + diagnosticId.ToLowerInvariant() + ".severity";

    private static IReadOnlyDictionary<string, string> Merge(IReadOnlyCollection<AnalyzerConfig> configs, string fullPath)
    {
        if (configs.Count == 0)
        {
            return ImmutableDictionary<string, string>.Empty;
        }

        var result = AnalyzerConfigSet.Create(configs).GetOptionsForSourcePath(fullPath);
        var options = result.AnalyzerOptions.ToBuilder();
        foreach (var severity in result.TreeOptions)
        {
            var text = ToSeverityText(severity.Value);
            if (text is not null)
            {
                options[DiagnosticSeverityKey(severity.Key)] = text;
            }
        }

        return options.ToImmutable();
    }

    private static string? ToSeverityText(ReportDiagnostic severity) => severity switch
    {
        ReportDiagnostic.Suppress => "none",
        ReportDiagnostic.Hidden => "silent",
        ReportDiagnostic.Info => "suggestion",
        ReportDiagnostic.Warn => "warning",
        ReportDiagnostic.Error => "error",
        _ => null,
    };

    private static List<(string Path, AnalyzerConfig Config)> LoadChain(string fullPath)
    {
        var chain = new List<(string Path, AnalyzerConfig Config)>();

        for (var directory = Path.GetDirectoryName(fullPath); !string.IsNullOrEmpty(directory); directory = Path.GetDirectoryName(directory))
        {
            var configPath = Path.Combine(directory, EditorConfigFileName);
            var config = TryLoadConfig(configPath);
            if (config is not null)
            {
                chain.Add((configPath, config));
            }
        }

        return chain;
    }

    private static AnalyzerConfig? TryLoadConfig(string configPath)
    {
        try
        {
            var file = new FileInfo(configPath);
            if (!file.Exists)
            {
                Forget(configPath);

                return null;
            }

            if (ParsedConfigs.TryGetValue(configPath, out var cached) && cached.LastWriteTimeUtc == file.LastWriteTimeUtc && cached.Length == file.Length)
            {
                return cached.Config;
            }

            var config = AnalyzerConfig.Parse(File.ReadAllText(configPath), configPath);
            if (ParsedConfigs.Count >= MaxCachedConfigs && !ParsedConfigs.ContainsKey(configPath))
            {
                ParsedConfigs.Clear();
            }

            ParsedConfigs[configPath] = (file.LastWriteTimeUtc, file.Length, config);

            return config;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }
}
