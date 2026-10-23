using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using CodeJanitor.Engine.CodeStyle;

namespace CodeJanitor.Engine.Settings;

/// <summary>
/// What the repository policy file (<c>.codejanitor</c>, or <c>.code-janitor.json</c>) decides for a file: the nearest
/// file of the file's directory and its ancestors wins as a whole. An unreadable file, invalid JSON, a missing <c>cleanup</c>
/// section, unknown keys and wrong value types yield nothing for the entry.
/// </summary>
public sealed class RepositoryPolicy
{
    /// <summary>The policy file names, in the order they are looked for in each directory.</summary>
    public static readonly IReadOnlyList<string> ConfigNames = [".codejanitor", ".code-janitor.json"];

    /// <summary>No policy.</summary>
    public static readonly RepositoryPolicy None = new(null, new JsonObject(), new Dictionary<string, string?>(), []);

    /// <summary>The keys of the Visual Studio extension that VS Code ignores, with the reason.</summary>
    private static readonly Dictionary<string, string> VisualStudioOnlyKeys = new(StringComparer.Ordinal)
    {
        ["applyEditorConfigFormatting"] = ".editorconfig rules always apply",
        ["applyEditorConfigNaming"] = ".editorconfig rules always apply",
        ["applyEditorConfigCodeStyle"] = ".editorconfig rules always apply",
        ["applyAnalyzerCodeFixes"] = "the fixes of every enforced analyzer rule always apply",
    };

    private static readonly Dictionary<string, string> KeyAliases = new(StringComparer.Ordinal)
    {
        ["insertBlankLineBeforeReturnAndThrow"] = "insertBlankLineBeforeReturnAndThrowStatements",
    };

    private static readonly Dictionary<string, string[]> HeaderEnumValues = new(StringComparer.Ordinal)
    {
        ["fileHeaderPosition"] = ["afterUsings", "documentStart"],
        ["fileHeaderUpdateMode"] = ["replace", "insert"],
    };

    private static readonly string[] InsertBlankLinePaddingKeys =
    [
        "insertBlankLinePaddingBeforeClasses", "insertBlankLinePaddingAfterClasses",
        "insertBlankLinePaddingBeforeDelegates", "insertBlankLinePaddingAfterDelegates",
        "insertBlankLinePaddingBeforeEnumerations", "insertBlankLinePaddingAfterEnumerations",
        "insertBlankLinePaddingBeforeEvents", "insertBlankLinePaddingAfterEvents",
        "insertBlankLinePaddingBeforeFieldsMultiLine", "insertBlankLinePaddingAfterFieldsMultiLine",
        "insertBlankLinePaddingBeforeInterfaces", "insertBlankLinePaddingAfterInterfaces",
        "insertBlankLinePaddingBeforeMethods", "insertBlankLinePaddingAfterMethods",
        "insertBlankLinePaddingBeforeNamespaces", "insertBlankLinePaddingAfterNamespaces",
        "insertBlankLinePaddingBeforePropertiesMultiLine", "insertBlankLinePaddingAfterPropertiesMultiLine",
        "insertBlankLinePaddingBeforeStructs", "insertBlankLinePaddingAfterStructs",
        "insertBlankLinePaddingBeforeRegionTags", "insertBlankLinePaddingAfterRegionTags",
        "insertBlankLinePaddingBeforeEndRegionTags", "insertBlankLinePaddingAfterEndRegionTags",
        "insertBlankLinePaddingBeforeUsingStatementBlocks", "insertBlankLinePaddingAfterUsingStatementBlocks",
        "insertBlankLinePaddingBeforeCaseStatements",
    ];

    /// <summary>The per-kind settings the <c>insertExplicitAccessModifiers</c> alias sets.</summary>
    internal static readonly string[] InsertExplicitAccessModifierKeys =
    [
        "insertExplicitAccessModifiersOnClasses", "insertExplicitAccessModifiersOnDelegates",
        "insertExplicitAccessModifiersOnEnumerations", "insertExplicitAccessModifiersOnEvents",
        "insertExplicitAccessModifiersOnFields", "insertExplicitAccessModifiersOnInterfaces",
        "insertExplicitAccessModifiersOnMethods", "insertExplicitAccessModifiersOnProperties",
        "insertExplicitAccessModifiersOnStructs",
    ];

    private static readonly ConcurrentDictionary<string, byte> ReportedIssues = new(StringComparer.Ordinal);

    private RepositoryPolicy(string? configPath, JsonObject overrides, IReadOnlyDictionary<string, string?> codeStyle, IReadOnlyList<string> issues)
    {
        ConfigPath = configPath;
        Overrides = overrides;
        CodeStyle = codeStyle;
        Issues = issues;
    }

    /// <summary>The file the policy was read from; null when none applies or it could not be read.</summary>
    public string? ConfigPath { get; }

    /// <summary>The settings the file lists, keyed by setting name (aliases expanded); the rest follow the user's settings.</summary>
    public JsonObject Overrides { get; }

    /// <summary>The <c>cleanup.codeStyle</c> rules: a normalized value enables the rule, null disables it.</summary>
    public IReadOnlyDictionary<string, string?> CodeStyle { get; }

    /// <summary>Messages about the file: the Visual Studio-only keys VS Code ignores, invalid JSON and an unreadable file; each is reported once per process.</summary>
    public IReadOnlyList<string> Issues { get; }

    /// <summary>The nearest policy file of the directory and its ancestors, or null.</summary>
    public static string? FindConfigFile(string startDirectory)
    {
        for (var directory = Path.GetFullPath(startDirectory); !string.IsNullOrEmpty(directory); directory = Path.GetDirectoryName(directory))
        {
            foreach (var name in ConfigNames)
            {
                var candidate = Path.Combine(directory, name);
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
        }

        return null;
    }

    /// <summary>The policy that applies to files in <paramref name="startDirectory"/>; never throws.</summary>
    public static RepositoryPolicy ForDirectory(string? startDirectory) => ForDirectory(startDirectory, File.ReadAllText);

    internal static RepositoryPolicy ForDirectory(string? startDirectory, Func<string, string> readAllText)
    {
        if (string.IsNullOrEmpty(startDirectory))
        {
            return None;
        }

        try
        {
            var configPath = FindConfigFile(startDirectory);
            if (configPath is null)
            {
                return None;
            }

            string text;
            try
            {
                text = readAllText(configPath);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                return Unreadable(configPath, exception.Message);
            }

            var issues = new List<string>();
            var policy = Parse(
                text,
                configPath,
                (key, reason) =>
                {
                    if (ReportedIssues.TryAdd(configPath + "\n" + key, 0))
                    {
                        issues.Add($"'.codejanitor' key {key} is ignored by VS Code: {reason}.");
                    }
                },
                message =>
                {
                    if (ReportedIssues.TryAdd(configPath + "\ninvalid\n" + message, 0))
                    {
                        issues.Add($"{Path.GetFileName(configPath)} is not valid JSON and is ignored: {message}");
                    }
                });

            return new RepositoryPolicy(configPath, policy.Overrides, policy.CodeStyle, issues);
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException)
        {
            return None;
        }
    }

    private static RepositoryPolicy Unreadable(string configPath, string message)
    {
        var issues = new List<string>();
        if (ReportedIssues.TryAdd(configPath + "\nunreadable\n" + message, 0))
        {
            issues.Add($"{Path.GetFileName(configPath)} could not be read and is ignored: {message}");
        }

        return new RepositoryPolicy(null, new JsonObject(), new Dictionary<string, string?>(), issues);
    }

    /// <summary>Parses the text of a policy file.</summary>
    public static RepositoryPolicy Parse(string text, string? configPath = null, Action<string, string>? onIgnoredKey = null, Action<string>? onInvalid = null)
    {
        JsonNode? file;
        try
        {
            file = JsonNode.Parse(text, documentOptions: new JsonDocumentOptions { AllowTrailingCommas = false });
        }
        catch (JsonException exception)
        {
            onInvalid?.Invoke(exception.Message);

            return None;
        }

        if (file is not JsonObject root || root["cleanup"] is not JsonObject section)
        {
            return None;
        }

        foreach (var (key, reason) in VisualStudioOnlyKeys)
        {
            if (section.ContainsKey(key))
            {
                onIgnoredKey?.Invoke(key, reason);
            }
        }

        var overrides = new JsonObject();
        ApplyBooleanAlias(section, overrides, "insertBlankLinePadding", InsertBlankLinePaddingKeys);
        ApplyBooleanAlias(section, overrides, "insertExplicitAccessModifiers", InsertExplicitAccessModifierKeys);

        var defaults = CleanupSettingsDefaults.Create();
        var readers = defaults
            .Select(entry => entry.Key)
            .Where(key => key is not "codeStyleRules" and not "reorganize")
            .Select(key => (Name: key, Key: key))
            .Concat(KeyAliases.Select(alias => (Name: alias.Key, Key: alias.Value)));

        foreach (var (name, key) in readers)
        {
            var value = section[name];
            if (value is null)
            {
                continue;
            }

            if (HeaderEnumValues.TryGetValue(key, out var names))
            {
                if (value.GetValueKind() == JsonValueKind.String && names.Contains(value.GetValue<string>(), StringComparer.Ordinal))
                {
                    overrides[key] = value.GetValue<string>();
                }

                continue;
            }

            if (HasSameType(value, defaults[key]))
            {
                overrides[key] = value.DeepClone();
            }
        }

        return new RepositoryPolicy(configPath, overrides, ParseCodeStyle(section["codeStyle"]), []);
    }

    /// <summary>The user's settings with the policy applied: a listed key wins, and <c>codeStyle</c> edits <c>codeStyleRules</c>.</summary>
    public JsonObject ApplyTo(JsonObject user)
    {
        var settings = (JsonObject)user.DeepClone();
        foreach (var (key, value) in Overrides)
        {
            settings[key] = value?.DeepClone();
        }

        if (CodeStyle.Count > 0)
        {
            var rules = settings["codeStyleRules"] as JsonObject ?? new JsonObject();
            rules = (JsonObject)rules.DeepClone();
            foreach (var (key, value) in CodeStyle)
            {
                if (value is null)
                {
                    rules.Remove(key);
                }
                else
                {
                    rules[key] = value;
                }
            }

            settings["codeStyleRules"] = rules;
        }

        return settings;
    }

    private static Dictionary<string, string?> ParseCodeStyle(JsonNode? codeStyle)
    {
        var rules = new Dictionary<string, string?>(StringComparer.Ordinal);
        if (codeStyle is not JsonObject section)
        {
            return rules;
        }

        foreach (var (key, value) in section)
        {
            var rule = CodeStyleRules.Find(key);
            if (rule is null)
            {
                continue;
            }

            if (value is null)
            {
                rules[key] = null;
            }
            else if (value.GetValueKind() == JsonValueKind.String && rule.IsValidValue(value.GetValue<string>().Trim()))
            {
                rules[key] = rule.Normalize(value.GetValue<string>());
            }
        }

        return rules;
    }

    private static bool HasSameType(JsonNode value, JsonNode? defaultValue)
    {
        if (defaultValue is null)
        {
            return false;
        }

        var expected = defaultValue.GetValueKind();
        var actual = value.GetValueKind();

        return expected switch
        {
            JsonValueKind.True or JsonValueKind.False => actual is JsonValueKind.True or JsonValueKind.False,
            JsonValueKind.Object => actual == JsonValueKind.Object,
            _ => actual == expected,
        };
    }

    private static void ApplyBooleanAlias(JsonObject section, JsonObject overrides, string key, IEnumerable<string> targetKeys)
    {
        if (section[key] is not { } value || value.GetValueKind() is not (JsonValueKind.True or JsonValueKind.False))
        {
            return;
        }

        foreach (var targetKey in targetKeys)
        {
            overrides[targetKey] = value.GetValue<bool>();
        }
    }
}
