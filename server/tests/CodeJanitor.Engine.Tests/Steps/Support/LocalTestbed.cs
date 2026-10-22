using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace CodeJanitor.Engine.Tests.Steps.Support;

/// <summary>
/// The scenarios of the Code Janitor testbed (<c>scenarios.json</c>), found through <c>CODE_JANITOR_TESTBED</c> or the
/// repository's <c>.testbed</c>, and the checks of the scenarios.
/// </summary>
internal static class LocalTestbed
{
    private static readonly Lazy<string?> RootPath = new(Find);

    public static string? Root => RootPath.Value;

    public static IEnumerable<JsonObject> Scenarios() => JsonNode.Parse(File.ReadAllText(Path.Combine(RequiredRoot, "scenarios.json")))!["scenarios"]!.AsArray().OfType<JsonObject>();

    public static JsonObject Scenario(string id) => Scenarios().Single(scenario => (string?)scenario["id"] == id);

    /// <summary>The scenario file's text, with a byte order mark as "\uFEFF".</summary>
    public static string Text(JsonObject scenario)
    {
        var bytes = File.ReadAllBytes(FilePath(scenario));
        var bom = bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF;

        return (bom ? "\uFEFF" : string.Empty) + new UTF8Encoding(false).GetString(bytes, bom ? 3 : 0, bytes.Length - (bom ? 3 : 0));
    }

    public static string FilePath(JsonObject scenario) => Path.GetFullPath(Path.Combine(RequiredRoot, (string)scenario["file"]!));

    private static string RequiredRoot => Root ?? throw new InvalidOperationException(Testbed.TestbedHelp.Missing);

    /// <summary>Why <paramref name="output" /> fails <paramref name="check" />, or null when it passes.</summary>
    public static string? Failure(JsonObject check, string output, IReadOnlyList<string> issues)
    {
        var text = output.Replace("\r\n", "\n", StringComparison.Ordinal);
        string S(string key) => (string)check[key]!;
        switch ((string)check["t"]!)
        {
            case "contains":
                return text.Contains(S("s"), StringComparison.Ordinal) ? null : $"expected the output to contain '{S("s")}'";
            case "absent":
                return text.Contains(S("s"), StringComparison.Ordinal) ? $"expected the output NOT to contain '{S("s")}'" : null;
            case "startsWith":
                return text.StartsWith(S("s"), StringComparison.Ordinal) ? null : $"expected the output to start with '{S("s")}'";
            case "endsWith":
                return text.EndsWith(S("s"), StringComparison.Ordinal) ? null : $"expected the output to end with '{S("s")}'";
            case "noBom":
                return text.StartsWith('\uFEFF') ? "expected the byte order mark to be removed" : null;
            case "reported":
                return issues.Any(issue => Regex.IsMatch(issue, S("re"))) ? null : $"expected a reported issue matching /{S("re")}/, got: {string.Join(" | ", issues)}";
            case "order":
                {
                    var from = 0;
                    foreach (var part in check["s"]!.AsArray().Select(node => (string)node!))
                    {
                        var at = text.IndexOf(part, from, StringComparison.Ordinal);
                        if (at < 0)
                        {
                            return $"expected '{part}' after position {from}";
                        }

                        from = at + part.Length;
                    }

                    return null;
                }

            case "blankBetween":
            case "noBlankBetween":
                {
                    var first = text.IndexOf(S("a"), StringComparison.Ordinal);
                    var second = first < 0 ? -1 : text.IndexOf(S("b"), first + S("a").Length, StringComparison.Ordinal);
                    if (first < 0 || second < 0)
                    {
                        return $"could not find '{(first < 0 ? S("a") : S("b"))}' (in order) in the output";
                    }

                    var blank = Regex.IsMatch(text[(first + S("a").Length)..second], @"\n[ \t]*\n");
                    var wanted = (string)check["t"]! == "blankBetween";

                    return blank == wanted ? null : $"expected {(wanted ? "a" : "no")} blank line between '{S("a")}' and '{S("b")}'";
                }

            default:
                return $"unknown check type '{check["t"]}'";
        }
    }

    /// <summary>Every failing check of the scenario, one per line.</summary>
    public static string Failures(JsonObject scenario, string output, IReadOnlyList<string> issues) =>
        string.Join("\n", scenario["checks"]!.AsArray().OfType<JsonObject>().Select(check => Failure(check, output, issues)).OfType<string>());

    private static string? Find()
    {
        var configured = Environment.GetEnvironmentVariable("CODE_JANITOR_TESTBED");
        if (!string.IsNullOrEmpty(configured))
        {
            return File.Exists(Path.Combine(configured, "scenarios.json")) ? configured : null;
        }

        foreach (var start in new[] { AppContext.BaseDirectory, SourceDirectory() })
        {
            for (var directory = new DirectoryInfo(start); directory is not null; directory = directory.Parent)
            {
                var candidate = Path.Combine(directory.FullName, ".testbed");
                if (File.Exists(Path.Combine(candidate, "scenarios.json")))
                {
                    return candidate;
                }
            }
        }

        return null;
    }

    /// <summary>The directory of this source file, so a build into another artifacts folder still finds the repository.</summary>
    internal static string SourceDirectory([System.Runtime.CompilerServices.CallerFilePath] string path = "") => Path.GetDirectoryName(path)!;
}
