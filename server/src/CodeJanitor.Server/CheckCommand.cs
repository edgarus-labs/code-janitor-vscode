using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using CodeJanitor.Engine.Contracts;
using CodeJanitor.Engine.Pipeline;
using Microsoft.CodeAnalysis;

namespace CodeJanitor.Server;

/// <summary>
/// <c>check [--root &lt;dir&gt;] &lt;paths…&gt;</c>, check mode for CI: runs cleanup as a dry run over the C# files of the paths
/// (default: the current folder; <c>bin</c>/<c>obj</c> excluded) with the default settings, each file's <c>.editorconfig</c> and
/// nearest <c>.codejanitor</c>, and prints <c>file:line: rule (severity): message</c> for every change cleanup would make and
/// every enforced rule it cannot fix. Exits with 1 when there is any. A step or analyzer that crashed and a project that
/// failed to load are printed as <c>file: error: message</c>: the check is then incomplete and exits with 2, like a usage
/// error. The engine's notes (<c>file: note: message</c>) never fail the check.
/// </summary>
internal static partial class CheckCommand
{
    public const string Usage = "Usage: dotnet CodeJanitor.Server.dll check [--root <repository root>] [<file or folder>...]";

    private static readonly HashSet<string> SkippedFolders = new(StringComparer.OrdinalIgnoreCase) { "bin", "obj", "node_modules", ".git", ".vs" };

    public static async Task<int> RunAsync(
        IReadOnlyList<string> arguments,
        TextWriter output,
        TextWriter error,
        WorkspaceHost host,
        ICleanupEngine engine,
        Func<JsonObject> defaultSettings,
        string currentDirectory)
    {
        var args = arguments.Where(argument => argument != "--").ToList();
        var rootIndex = args.IndexOf("--root");
        var root = rootIndex < 0 ? currentDirectory : rootIndex + 1 < args.Count ? args[rootIndex + 1] : null;
        var paths = args.Where((_, index) => rootIndex < 0 || (index != rootIndex && index != rootIndex + 1)).ToList();
        if (root is null || paths.Any(argument => argument.StartsWith("--", StringComparison.Ordinal)))
        {
            await error.WriteAsync(Usage + "\n").ConfigureAwait(false);

            return 2;
        }

        try
        {
            var lines = new List<string>();
            var exitCode = await CheckAsync(paths.Count > 0 ? paths : ["."], Path.GetFullPath(root, currentDirectory), currentDirectory, host, engine, defaultSettings, lines).ConfigureAwait(false);
            foreach (var line in lines)
            {
                await output.WriteAsync(line + "\n").ConfigureAwait(false);
            }

            return exitCode;
        }
        catch (Exception exception) when (exception is not OutOfMemoryException)
        {
            await error.WriteAsync($"Code Janitor check failed: {exception.Message}\n").ConfigureAwait(false);

            return 2;
        }
    }

    private static async Task<int> CheckAsync(
        IReadOnlyList<string> paths,
        string root,
        string currentDirectory,
        WorkspaceHost host,
        ICleanupEngine engine,
        Func<JsonObject> defaultSettings,
        List<string> lines)
    {
        var files = paths
            .SelectMany(target => CSharpFiles(Path.GetFullPath(target, currentDirectory)))
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToList();
        host.Initialize([root]);

        var changing = 0;
        var unfixable = 0;
        var failed = 0;
        foreach (var file in files)
        {
            var opened = await host.OpenAsync(file, text: null, unsavedDocuments: null, CancellationToken.None).ConfigureAwait(false);
            var document = opened.Document;
            var settings = defaultSettings();
            var outcome = await engine.CleanupAsync(document, new CleanupRequest(settings, [], null), CancellationToken.None).ConfigureAwait(false);
            var result = await ResultMapper.MapAsync(document, outcome, [], [], CancellationToken.None).ConfigureAwait(false);
            var shown = Path.GetRelativePath(root, file).Replace(Path.DirectorySeparatorChar, '/');

            lines.AddRange(opened.Issues.Concat(opened.Warnings).Concat(outcome.Issues).Select(issue => $"{shown}: note: {issue}"));
            var failures = opened.Failures.Concat(outcome.Failures).ToList();
            lines.AddRange(failures.Select(failure => $"{shown}: error: {failure}"));
            var originalText = await document.GetTextAsync().ConfigureAwait(false);
            var before = TextConventions.ToProtocolText(originalText, originalText);
            var findings = before == result.Text ? [] : await ChangeFindingsAsync(document, settings, before, result.Text, outcome.Rules, engine).ConfigureAwait(false);
            lines.AddRange(findings.Select(finding => $"{shown}:{finding.Line + 1}: {finding.Rule}: {finding.Message}"));
            lines.AddRange(result.Unresolved.Select(diagnostic => $"{shown}:{diagnostic.Line}: {Label(diagnostic.Id, diagnostic.Severity)}: {Message(diagnostic)}"));

            changing += before != result.Text || result.OtherFiles.Count > 0 || result.NewFiles.Count > 0 ? 1 : 0;
            unfixable += result.Unresolved.Count;
            failed += failures.Count;
        }

        if (changing == 0 && unfixable == 0 && failed == 0)
        {
            lines.Add($"Code Janitor check: {files.Count} file(s) checked, all clean.");

            return 0;
        }

        var summary = $"Code Janitor check: {files.Count} file(s) checked, {changing} would change, {unfixable} violation(s) cleanup cannot fix";
        lines.Add(failed == 0 ? summary + "." : summary + $", {failed} failure(s): the check is incomplete.");

        return failed == 0 ? 1 : 2;
    }

    /// <summary>
    /// The places each changing rule changes the file: the whole change for one rule (or
    /// none named), else each rule's change alone (<see cref="ICleanupEngine.FixRuleAsync"/>). Code Janitor's own steps
    /// (<c>CJ</c> ids, setting keys) are named, diagnostics are shown with their id and severity.
    /// </summary>
    private static async Task<List<(int Line, string Rule, string Message)>> ChangeFindingsAsync(
        Document document,
        JsonObject settings,
        string before,
        string after,
        IReadOnlyList<RuleOutcome> rules,
        ICleanupEngine engine)
    {
        var changing = rules.Where(rule => rule.Included && rule.Changes > 0).ToList();
        if (changing.Count == 0)
        {
            return [.. Places(before, after).Select(place => (place.Line, "Cleanup", place.Message))];
        }

        IReadOnlyList<EngineDiagnostic>? diagnostics = null;
        var findings = new List<(int Line, string Rule, string Message)>();
        foreach (var rule in changing)
        {
            var ruleText = after;
            if (changing.Count > 1)
            {
                var alone = await engine.FixRuleAsync(document, settings, rule.Id, null, CancellationToken.None).ConfigureAwait(false);
                ruleText = (await ResultMapper.MapAsync(document, alone, [], [], CancellationToken.None).ConfigureAwait(false)).Text;
            }

            var places = Places(before, ruleText);
            if (places.Count == 0)
            {
                continue;
            }

            string label;
            if (rule.Id.StartsWith("CJ", StringComparison.Ordinal) || !DiagnosticId().IsMatch(rule.Id))
            {
                label = rule.Name;
            }
            else
            {
                diagnostics ??= await engine.AnalyzeAsync(document, settings, CancellationToken.None).ConfigureAwait(false);
                label = Label(rule.Id, diagnostics.FirstOrDefault(diagnostic => diagnostic.Id == rule.Id)?.Severity);
            }

            findings.AddRange(places.Select(place => (place.Line, label, place.Message)));
        }

        return findings;
    }

    /// <summary>One place per run of adjacent changed lines, at its first line of <paramref name="before"/>, with what it would become.</summary>
    private static List<(int Line, string Message)> Places(string before, string after)
    {
        var afterLines = after.Split('\n');
        var lastLine = before.Split('\n').Length - 1;
        var places = new List<(int Start, int End, List<LineHunk> Hunks)>();
        foreach (var hunk in LineDiff.Hunks(before, after))
        {
            var (start, end) = AnchorLines(hunk, lastLine);
            if (places.Count > 0 && start <= places[^1].End + 1)
            {
                var previous = places[^1];
                previous.Hunks.Add(hunk);
                places[^1] = (previous.Start, Math.Max(previous.End, end), previous.Hunks);
            }
            else
            {
                places.Add((start, end, [hunk]));
            }
        }

        return [.. places.Select(place =>
        {
            var writtenLines = place.Hunks.SelectMany(hunk => afterLines[hunk.AfterStart..hunk.AfterEnd]).ToList();
            var written = writtenLines.Select(Trim).FirstOrDefault(line => line.Length > 0);
            var removed = place.Hunks.Sum(hunk => hunk.BeforeEnd - hunk.BeforeStart);
            var change = written is not null
                ? $"would change this to: {Abbreviate(written)}"
                : removed == 0
                    ? $"would insert {writtenLines.Count} blank line(s)"
                    : $"would remove {removed} line(s)";

            return (place.Start, $"Code Janitor {change}");
        })];
    }

    private static (int Start, int End) AnchorLines(LineHunk hunk, int lastLine)
    {
        if (hunk.BeforeEnd > hunk.BeforeStart)
        {
            return (Math.Min(hunk.BeforeStart, lastLine), Math.Min(hunk.BeforeEnd - 1, lastLine));
        }

        var line = Math.Min(Math.Max(hunk.BeforeStart - 1, 0), lastLine);

        return (line, line);
    }

    private static string Label(string id, string? severity) => string.IsNullOrEmpty(severity) ? id : $"{id} ({severity})";

    private static string Message(UnresolvedDiagnostic diagnostic) =>
        string.IsNullOrEmpty(diagnostic.Reason) ? diagnostic.Message
        : string.IsNullOrEmpty(diagnostic.Message) ? diagnostic.Reason
        : $"{diagnostic.Message}; {diagnostic.Reason}";

    /// <summary>Trims white space and the byte order mark.</summary>
    private static string Trim(string line) => line.Trim().Trim('\uFEFF').Trim();

    private static string Abbreviate(string text) => text.Length > 80 ? $"{text[..77]}..." : text;

    /// <summary>A diagnostic id such as <c>IDE0011</c>, <c>CA1822</c> or <c>SA1402</c>.</summary>
    [GeneratedRegex("^[A-Z]+[0-9]+$")]
    private static partial Regex DiagnosticId();

    /// <summary><paramref name="target"/> itself when it is a <c>.cs</c> file, or the <c>.cs</c> files under it outside build and tool folders.</summary>
    private static IEnumerable<string> CSharpFiles(string target)
    {
        if (File.Exists(target))
        {
            return target.EndsWith(".cs", StringComparison.OrdinalIgnoreCase) ? [target] : [];
        }

        if (!Directory.Exists(target))
        {
            throw new FileNotFoundException($"no such file or directory: {target}", target);
        }

        return Directory.EnumerateFileSystemEntries(target).SelectMany(entry => Directory.Exists(entry)
            ? SkippedFolders.Contains(Path.GetFileName(entry)) ? [] : CSharpFiles(entry)
            : entry.EndsWith(".cs", StringComparison.OrdinalIgnoreCase) ? [entry] : []);
    }
}
