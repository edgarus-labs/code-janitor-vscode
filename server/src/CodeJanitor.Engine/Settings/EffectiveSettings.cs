using System.Collections.Immutable;
using System.Text.Json;
using System.Text.Json.Nodes;
using CodeJanitor.Engine.CodeStyle;
using CodeJanitor.Engine.Contracts;
using Microsoft.CodeAnalysis;

namespace CodeJanitor.Engine.Settings;

/// <summary>
/// The cleanup settings of one file: a setting <c>.editorconfig</c> decides wins, otherwise the nearest <c>.codejanitor</c>,
/// otherwise the user's setting (then the extension's default). A plain option (<c>trim_trailing_whitespace</c>) with a
/// <c>:none</c>/<c>:silent</c> suffix or an unrecognized value is ignored, so the next source decides. A Roslyn rule is
/// enforced as Roslyn reports it (see <see cref="TryReadRule"/>), which also resolves the Code Style rules.
/// </summary>
public sealed class EffectiveSettings : IEffectiveSettings
{
    /// <summary>The setting key of the C# file header.</summary>
    public const string FileHeaderKey = "fileHeaderCSharp";

    private const string NoWarnKey = "NoWarn";

    private static readonly Dictionary<string, string> AnalyzerCategories = new(StringComparer.OrdinalIgnoreCase)
    {
        ["CA1507"] = "Maintainability",
        ["CA1852"] = "Performance",
        ["CA1869"] = "Performance",
    };

    /// <summary>Diagnostics disabled by default: only <c>dotnet_diagnostic.&lt;id&gt;.severity</c> enables them, as in Roslyn.</summary>
    private static readonly HashSet<string> DisabledByDefaultDiagnostics = new(StringComparer.OrdinalIgnoreCase) { "CA1852" };

    /// <summary>The settings whose step has a Roslyn rule counterpart (<c>docs/features.md</c>, "Settings precedence").</summary>
    private static readonly RuleLink[] RuleLinks =
    [
        new(["convertToVarWhenApparent"], "csharp_style_var_when_type_is_apparent", ["IDE0007", "IDE0008"], ParseBoolean, false, "false"),
        new(["inlineOutVariableDeclarations"], "csharp_style_inlined_variable_declaration", ["IDE0018"], ParseBoolean, true),
        new(["convertToCollectionExpressions"], "dotnet_style_prefer_collection_expression", ["IDE0300", "IDE0301", "IDE0302", "IDE0303", "IDE0304", "IDE0305", "IDE0306"], ParseCollectionExpressionPreference, true),
        new(["makeFieldsReadonlyWhenSafe"], "dotnet_style_readonly_field", ["IDE0044"], ParseBoolean, true),
        new(RepositoryPolicy.InsertExplicitAccessModifierKeys, "dotnet_style_require_accessibility_modifiers", ["IDE0040"], ParseAccessibilityModifiersPreference, true),
        new(["simplifySingleStatementLambdas"], "csharp_style_expression_bodied_lambdas", ["IDE0053"], ParseExpressionBodyPreference, true),
        new(["sealClassesWhenSafe"], null, ["CA1852"], null, true),
        new(["convertToStringNameOf"], null, ["CA1507"], null, true),
        new(["reuseJsonSerializerOptionsForCA1869"], null, ["CA1869"], null, true),
        new(["removeMultipleConsecutiveBlankLines"], "dotnet_style_allow_multiple_blank_lines_experimental", ["IDE2000"], ParseInvertedBoolean, false),
        new(["removeBlankLinesAfterOpeningBrace", "removeBlankLinesBeforeClosingBrace"], "csharp_style_allow_blank_lines_between_consecutive_braces_experimental", ["IDE2002"], ParseInvertedBoolean, false),
        new(["convertToFileScopedNamespace"], "csharp_style_namespace_declarations", ["IDE0160", "IDE0161"], ParseNamespaceDeclarations, false, "block_scoped"),
        new(["moveUsingsOutsideNamespace"], "csharp_using_directive_placement", ["IDE0065"], ParseUsingDirectivePlacement, true),
    ];

    /// <summary>
    /// The settings applied through a Roslyn analyzer and code fix in the diagnostic cleanup, each the way the Microsoft
    /// Learn page of its rule documents it (<c>docs/features.md</c>, "Steps applied through Roslyn rules").
    /// </summary>
    internal static readonly RoslynStep[] RoslynSteps =
    [
        new("convertToVarWhenApparent", "csharp_style_var_when_type_is_apparent", "true", ["IDE0007"], [], "csharp_style_var_for_built_in_types", "csharp_style_var_elsewhere"),
        new("inlineOutVariableDeclarations", "csharp_style_inlined_variable_declaration", "true", ["IDE0018"], []),
        new("convertToCollectionExpressions", "dotnet_style_prefer_collection_expression", "true", ["IDE0300", "IDE0301", "IDE0302", "IDE0303", "IDE0304", "IDE0305", "IDE0306"], []),
        new("makeFieldsReadonlyWhenSafe", "dotnet_style_readonly_field", "true", ["IDE0044"], []),
        new(RepositoryPolicy.InsertExplicitAccessModifierKeys, "dotnet_style_require_accessibility_modifiers", "for_non_interface_members", ["IDE0040"], []),
        new("simplifySingleStatementLambdas", "csharp_style_expression_bodied_lambdas", "true", ["IDE0053"], []),
        new("convertToFileScopedNamespace", "csharp_style_namespace_declarations", "file_scoped", ["IDE0161"], ["IDE0160"]),
        new("moveUsingsOutsideNamespace", "csharp_using_directive_placement", "outside_namespace", ["IDE0065"], ["IDE0065"]),
        new("removeMultipleConsecutiveBlankLines", "dotnet_style_allow_multiple_blank_lines_experimental", "false", ["IDE2000"], []),
    ];

    /// <summary>Options whose value selects one of two diagnostics: (value that selects the first, first, otherwise).</summary>
    private static readonly Dictionary<string, (string Value, string WhenValue, string Otherwise)> SelectiveOptions = new(StringComparer.Ordinal)
    {
        ["csharp_style_var_for_built_in_types"] = ("true", "IDE0007", "IDE0008"),
        ["csharp_style_var_when_type_is_apparent"] = ("true", "IDE0007", "IDE0008"),
        ["csharp_style_var_elsewhere"] = ("true", "IDE0007", "IDE0008"),
        ["dotnet_style_qualification_for_field"] = ("true", "IDE0009", "IDE0003"),
        ["dotnet_style_qualification_for_property"] = ("true", "IDE0009", "IDE0003"),
        ["dotnet_style_qualification_for_method"] = ("true", "IDE0009", "IDE0003"),
        ["dotnet_style_qualification_for_event"] = ("true", "IDE0009", "IDE0003"),
        ["csharp_style_namespace_declarations"] = ("block_scoped", "IDE0160", "IDE0161"),
        ["csharp_style_prefer_top_level_statements"] = ("true", "IDE0210", "IDE0211"),
    };

    private static readonly string[] ParenthesesKeys =
    [
        "dotnet_style_parentheses_in_arithmetic_binary_operators",
        "dotnet_style_parentheses_in_relational_binary_operators",
        "dotnet_style_parentheses_in_other_binary_operators",
        "dotnet_style_parentheses_in_other_operators",
    ];

    private readonly JsonObject _settings;
    private readonly IReadOnlyDictionary<string, string> _editorConfig;
    private readonly Func<string, bool> _isSuppressedByProject;
    private readonly Dictionary<string, JsonNode?> _editorConfigValues = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> _editorConfigKeys = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> _codeStyleValues = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> _codeStyleEditorConfigKeys = new(StringComparer.Ordinal);

    private EffectiveSettings(string? filePath, JsonObject userSettings, IReadOnlyDictionary<string, string> editorConfig, RepositoryPolicy policy, Func<string, bool>? isSuppressedByProject)
    {
        _editorConfig = editorConfig;
        _isSuppressedByProject = isSuppressedByProject ?? (_ => false);
        Policy = policy;
        UserSettings = userSettings;
        _settings = policy.ApplyTo(userSettings);

        ApplyPlainOptions();
        ApplyRuleLinks();
        ApplyNullCheckRules();
        ApplyFileHeader(filePath);
        ApplyOrganizeUsings();
        ResolveCodeStyleRules();
        AnalyzerConfigOverrides = BuildAnalyzerConfigOverrides();
    }

    /// <summary>The user's settings as the extension sent them.</summary>
    public JsonObject UserSettings { get; }

    /// <summary>The repository policy that applies to the file.</summary>
    public RepositoryPolicy Policy { get; }

    /// <summary>The raw <c>.editorconfig</c> options of the file.</summary>
    public IReadOnlyDictionary<string, string> EditorConfig => _editorConfig;

    /// <summary>The settings <c>.editorconfig</c> decides for the file, each mapped to the option (or severity entry) deciding it.</summary>
    public IReadOnlyDictionary<string, string> EditorConfigKeys => _editorConfigKeys;

    /// <summary>The Code Style rules that apply because <c>.editorconfig</c> does not enforce them, with their values.</summary>
    public IReadOnlyDictionary<string, string> CodeStyleValues => _codeStyleValues;

    /// <summary>The Code Style rules <c>.editorconfig</c> enforces, each mapped to the option (or severity entry) enforcing it.</summary>
    public IReadOnlyDictionary<string, string> CodeStyleEditorConfigKeys => _codeStyleEditorConfigKeys;

    /// <summary>
    /// The analyzer configuration the diagnostic cleanup applies over <c>.editorconfig</c> so that Roslyn reports, and
    /// fixes, exactly the rules of <see cref="CodeStyleValues"/> and the enabled steps applied through Roslyn rules. A Code
    /// Style rule gets its value with <c>suggestion</c> and its diagnostics raised to <c>suggestion</c>; the other rules
    /// reported through those diagnostics that <c>.editorconfig</c> does not enforce are switched off with <c>none</c>. A
    /// Roslyn step <c>.editorconfig</c> does not decide gets the value it applies, raised to <c>suggestion</c>; one it
    /// decides by its option keeps that value, and the diagnostics of the decided direction no severity configures are raised.
    /// </summary>
    public IReadOnlyDictionary<string, string> AnalyzerConfigOverrides { get; }

    /// <summary>The settings of a document: its <c>.editorconfig</c> from its project's analyzer config documents, the nearest <c>.codejanitor</c>.</summary>
    public static async Task<EffectiveSettings> ForDocumentAsync(Document document, JsonObject userSettings, CancellationToken cancellationToken)
    {
        var editorConfig = await EditorConfigOptions.ForDocumentAsync(document, cancellationToken).ConfigureAwait(false);
        var policy = RepositoryPolicy.ForDirectory(Path.GetDirectoryName(document.FilePath));
        var specific = document.Project.CompilationOptions?.SpecificDiagnosticOptions ?? ImmutableDictionary<string, ReportDiagnostic>.Empty;

        return new EffectiveSettings(document.FilePath, userSettings, editorConfig, policy, id => specific.TryGetValue(id, out var report) && report == ReportDiagnostic.Suppress);
    }

    /// <summary>The settings of a file from the given sources.</summary>
    public static EffectiveSettings Create(string? filePath, JsonObject userSettings, IReadOnlyDictionary<string, string> editorConfig, RepositoryPolicy policy, Func<string, bool>? isSuppressedByProject = null) =>
        new(filePath, userSettings, editorConfig, policy, isSuppressedByProject);

    /// <summary>The settings of a file on disk: its <c>.editorconfig</c> files and nearest <c>.codejanitor</c>.</summary>
    public static EffectiveSettings ForFile(string filePath, JsonObject userSettings) =>
        new(filePath, userSettings, EditorConfigOptions.Load(filePath), RepositoryPolicy.ForDirectory(Path.GetDirectoryName(filePath)), null);

    /// <inheritdoc/>
    public bool GetBool(string key) => Resolve(key) is { } node && node.GetValueKind() is JsonValueKind.True or JsonValueKind.False && node.GetValue<bool>();

    /// <inheritdoc/>
    public string GetString(string key) => Resolve(key) switch
    {
        JsonValue value when value.GetValueKind() == JsonValueKind.String => value.GetValue<string>(),
        JsonValue value when value.GetValueKind() == JsonValueKind.Number && key == "fileHeaderPosition" => value.GetValue<int>() == 1 ? "afterUsings" : "documentStart",
        JsonValue value when value.GetValueKind() == JsonValueKind.Number && key == "fileHeaderUpdateMode" => value.GetValue<int>() == 1 ? "replace" : "insert",
        JsonValue value => value.ToJsonString(),
        _ => string.Empty,
    };

    /// <inheritdoc/>
    public int GetInt(string key) => Resolve(key) is JsonValue value && value.GetValueKind() == JsonValueKind.Number ? value.GetValue<int>() : 0;

    /// <inheritdoc/>
    public IReadOnlyList<string> GetList(string key) => Resolve(key) is JsonArray array
        ? array.Where(item => item is JsonValue value && value.GetValueKind() == JsonValueKind.String).Select(item => item!.GetValue<string>()).ToList()
        : [];

    /// <inheritdoc/>
    public JsonNode? GetNode(string key)
    {
        if (key == "codeStyleRules")
        {
            var rules = new JsonObject();
            foreach (var (rule, value) in _codeStyleValues)
            {
                rules[rule] = value;
            }

            return rules;
        }

        return Resolve(key)?.DeepClone();
    }

    /// <inheritdoc/>
    public string? EditorConfigValue(string key) => _editorConfig.TryGetValue(key.ToLowerInvariant(), out var value) ? value : null;

    /// <summary>
    /// Whether <c>.editorconfig</c> (or the project) enforces a diagnostic: its severity resolves to <c>suggestion</c> or higher,
    /// through <c>dotnet_diagnostic.&lt;id&gt;.severity</c>, the category or global severity. Option suffixes are not read.
    /// </summary>
    public bool IsDiagnosticEnforced(string diagnosticId) => TryReadDiagnosticSeverity(diagnosticId, out _, out var enforced) && enforced;

    private JsonNode? Resolve(string key)
    {
        if (_editorConfigValues.TryGetValue(key, out var decided))
        {
            return decided;
        }

        return _settings.TryGetPropertyValue(key, out var value) && value is not null ? value : CleanupSettingsDefaults.Get(key);
    }

    private void Decide(string setting, string key, JsonNode? value)
    {
        _editorConfigValues[setting] = value;
        _editorConfigKeys[setting] = key;
    }

    private void ApplyPlainOptions()
    {
        if (TryReadOption("trim_trailing_whitespace", ParseBoolean, out var trim))
        {
            Decide("removeEndOfLineWhitespace", "trim_trailing_whitespace", trim);
        }
    }

    private void ApplyRuleLinks()
    {
        foreach (var link in RuleLinks)
        {
            var parse = link.Parse;
            if (TryReadRule(link.Key, link.DiagnosticIds, value => parse?.Invoke(value) is not null, out var value, out var decidingKey, link.OptionDefault))
            {
                var decided = value is null || parse is null ? link.DefaultValue : parse(value)!.Value;
                foreach (var setting in link.Settings)
                {
                    Decide(setting, decidingKey!, decided);
                }
            }
        }
    }

    private void ApplyNullCheckRules()
    {
        (string Key, string DiagnosticId)[] rules =
        [
            ("csharp_style_prefer_null_check_over_type_check", "IDE0150"),
            ("dotnet_style_prefer_is_null_check_over_reference_equality_method", "IDE0041"),
        ];
        bool? convert = null;
        string? decidingKey = null;

        foreach (var (key, diagnosticId) in rules)
        {
            if (!TryReadRule(key, [diagnosticId], value => ParseBoolean(value).HasValue, out var value, out var ruleKey))
            {
                continue;
            }

            var prefersNullCheck = value is null || ParseBoolean(value) == true;
            if (convert is null || (convert == true && !prefersNullCheck))
            {
                decidingKey = ruleKey;
            }

            convert = (convert ?? true) && prefersNullCheck;
        }

        if (convert.HasValue)
        {
            Decide("convertToPatternMatchingNullChecks", decidingKey!, convert.Value);
        }
    }

    /// <summary>
    /// <c>file_header_template</c> decides the C# header: each template line becomes a <c>//</c> line, <c>\n</c> escapes
    /// separate lines and <c>{fileName}</c> is the file name; <c>unset</c> or an empty template means no header.
    /// </summary>
    private void ApplyFileHeader(string? filePath)
    {
        const string key = "file_header_template";
        if (!_editorConfig.TryGetValue(key, out var raw))
        {
            return;
        }

        var template = raw?.Trim() ?? string.Empty;
        if (template.Length == 0 || string.Equals(template, "unset", StringComparison.OrdinalIgnoreCase))
        {
            Decide(FileHeaderKey, key, string.Empty);

            return;
        }

        var lines = template
            .Replace("{fileName}", filePath is null ? string.Empty : Path.GetFileName(filePath), StringComparison.Ordinal)
            .Split("\\n")
            .Select(line => line.Length == 0 ? "//" : "// " + line);
        Decide(FileHeaderKey, key, string.Join("\n", lines));
    }

    /// <summary>
    /// <c>organizeUsings</c>: <c>.editorconfig</c> turns it off when it contradicts the organizer (System directives not first,
    /// or groups separated) and on when System directives first is set; <c>dotnet_diagnostic.IDE0005.severity</c> enforced
    /// turns it on (the Roslyn Remove and Sort Usings); otherwise the policy or the user's setting decides.
    /// </summary>
    private void ApplyOrganizeUsings()
    {
        const string sortKey = "dotnet_sort_system_directives_first";
        const string separateKey = "dotnet_separate_import_directive_groups";
        var sortDefined = TryReadOption(sortKey, ParseBoolean, out var sortSystemFirst);
        var separateDefined = TryReadOption(separateKey, ParseBoolean, out var separateGroups);
        var decidingKey = sortDefined && sortSystemFirst == false ? sortKey
            : separateDefined && separateGroups == true ? separateKey
            : sortDefined && sortSystemFirst == true ? sortKey
            : null;
        if (decidingKey is not null)
        {
            Decide("organizeUsings", decidingKey, decidingKey == sortKey && sortSystemFirst == true);

            return;
        }

        if (TryReadDiagnosticSeverity("IDE0005", out var severityKey, out var enforced) && enforced)
        {
            Decide("organizeUsings", severityKey!, true);
        }
    }

    private void ResolveCodeStyleRules()
    {
        var configured = _settings["codeStyleRules"] as JsonObject;

        foreach (var rule in CodeStyleRules.All)
        {
            var configuredValue = configured?[rule.Key] is JsonValue value && value.GetValueKind() == JsonValueKind.String ? value.GetValue<string>() : null;
            var enabled = rule.IsValidValue(configuredValue?.Trim());
            if (TryReadRule(rule.Key, rule.DiagnosticIds, rule.IsValidValue, out _, out var decidingKey, rule.DefaultValue))
            {
                _codeStyleEditorConfigKeys[rule.Key] = decidingKey!;
            }
            else if (enabled)
            {
                _codeStyleValues[rule.Key] = rule.Normalize(configuredValue!);
            }
        }
    }

    private Dictionary<string, string> BuildAnalyzerConfigOverrides()
    {
        var overrides = new Dictionary<string, string>(StringComparer.Ordinal);
        var raisedDiagnosticIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var rule in CodeStyleRules.All.Where(rule => _codeStyleValues.ContainsKey(rule.Key)))
        {
            overrides[rule.Key] = _codeStyleValues[rule.Key] + ":suggestion";
            foreach (var diagnosticId in rule.DiagnosticIds)
            {
                overrides["dotnet_diagnostic." + diagnosticId + ".severity"] = "suggestion";
                raisedDiagnosticIds.Add(diagnosticId);
            }
        }

        foreach (var rule in CodeStyleRules.All)
        {
            if (_codeStyleValues.ContainsKey(rule.Key) || _codeStyleEditorConfigKeys.ContainsKey(rule.Key) || !rule.DiagnosticIds.Any(raisedDiagnosticIds.Contains))
            {
                continue;
            }

            var value = TryReadRawOption(rule.Key, out var configuredValue, out _) && rule.IsValidValue(configuredValue) ? rule.Normalize(configuredValue!) : rule.DefaultValue;
            overrides[rule.Key] = value + ":none";
        }

        foreach (var step in RoslynSteps)
        {
            var enabled = step.Settings.Any(GetBool);
            var decidingKey = step.Settings.Select(setting => _editorConfigKeys.GetValueOrDefault(setting)).FirstOrDefault(key => key is not null);
            if (decidingKey is not null)
            {
                var unconfiguredIds = (enabled ? step.DiagnosticIds : step.ReverseDiagnosticIds)
                    .Where(diagnosticId => !TryReadDiagnosticSeverity(diagnosticId, out _, out _))
                    .ToList();
                if (decidingKey != step.Key || unconfiguredIds.Count == 0 || !TryReadRawOption(step.Key, out var decidedValue, out _))
                {
                    continue;
                }

                overrides[step.Key] = decidedValue!.ToLowerInvariant() + ":suggestion";
                RaiseSeverities(unconfiguredIds);
            }
            else if (enabled)
            {
                overrides[step.Key] = step.Value + ":suggestion";
                RaiseSeverities(step.DiagnosticIds);
            }
            else
            {
                continue;
            }

            if (enabled)
            {
                foreach (var key in step.OtherOptions)
                {
                    if (TryReadRawOption(key, out var configuredValue, out _)
                        && ParseBoolean(configuredValue!) == true
                        && !TryReadRule(key, step.DiagnosticIds, value => ParseBoolean(value).HasValue, out _, out _))
                    {
                        overrides[key] = "true:none";
                    }
                }
            }
        }

        return overrides;

        void RaiseSeverities(IEnumerable<string> diagnosticIds)
        {
            foreach (var diagnosticId in diagnosticIds)
            {
                overrides["dotnet_diagnostic." + diagnosticId + ".severity"] = "suggestion";
            }
        }
    }

    private bool TryReadOption<T>(string key, Func<string, T?> parseValue, out T? value)
        where T : struct
    {
        value = null;
        if (!TryReadRawOption(key, out var rawValue, out var severity))
        {
            return false;
        }

        var parsed = parseValue(rawValue!);
        if (parsed is null || !IsEnforcing(severity))
        {
            return false;
        }

        value = parsed;

        return true;
    }

    private bool TryReadRawOption(string key, out string? value, out string? severity)
    {
        value = null;
        severity = null;
        if (!_editorConfig.TryGetValue(key, out var rawValue) || rawValue is null)
        {
            return false;
        }

        var separatorIndex = rawValue.IndexOf(':', StringComparison.Ordinal);
        if (separatorIndex >= 0)
        {
            var suffix = rawValue[(separatorIndex + 1)..].Trim().ToLowerInvariant();
            if (separatorIndex != rawValue.LastIndexOf(':') || !TryParseSeverity(suffix, out _))
            {
                return false;
            }

            severity = suffix;
            rawValue = rawValue[..separatorIndex];
        }

        value = rawValue.Trim();

        return true;
    }

    /// <summary>
    /// Reads a Roslyn rule configured by an option and the severities of its diagnostics, as Roslyn reports it. A <c>:none</c>
    /// suffix stops the rule. Only the diagnostics the option value (or Roslyn's default <paramref name="optionDefault"/>)
    /// reports count. Each diagnostic's severity is <c>dotnet_diagnostic.&lt;id&gt;.severity</c>, else the category, else the
    /// global severity, else the option's suffix (none enforces). The rule is enforced when one resolves to <c>suggestion</c>
    /// or higher; <c>value</c> is null when it is enforced with Roslyn's default value.
    /// </summary>
    private bool TryReadRule(string? key, IEnumerable<string> diagnosticIds, Func<string, bool> isValidValue, out string? value, out string? decidingKey, string? optionDefault = null)
    {
        value = null;
        decidingKey = null;

        string? optionSeverity = null;
        var optionDefined = key is not null && TryReadRawOption(key, out value, out optionSeverity) && isValidValue(value!);
        if (!optionDefined)
        {
            value = null;
        }
        else if (optionSeverity == "none")
        {
            value = null;

            return false;
        }

        var selected = key is null ? null : SelectedDiagnosticId(key, value ?? optionDefault);
        string? enforcingKey = null;
        foreach (var diagnosticId in diagnosticIds)
        {
            if (selected is not null && !string.Equals(diagnosticId, selected, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (TryReadDiagnosticSeverity(diagnosticId, out var severityKey, out var enforced))
            {
                enforcingKey ??= enforced ? severityKey : null;
            }
            else if (optionDefined && IsEnforcing(optionSeverity))
            {
                enforcingKey ??= key;
            }
        }

        if (enforcingKey is null)
        {
            value = null;

            return false;
        }

        decidingKey = optionDefined ? key : enforcingKey;

        return true;
    }

    private static string? SelectedDiagnosticId(string key, string? value)
    {
        if (value is null)
        {
            return null;
        }

        var normalized = value.Trim().ToLowerInvariant();
        if (SelectiveOptions.TryGetValue(key, out var selective))
        {
            return normalized == selective.Value ? selective.WhenValue : selective.Otherwise;
        }

        return ParenthesesKeys.Contains(key) && normalized == "never_if_unnecessary" ? "IDE0047" : null;
    }

    private bool TryReadDiagnosticSeverity(string diagnosticId, out string? severityKey, out bool enforced)
    {
        if (_isSuppressedByProject(diagnosticId))
        {
            severityKey = NoWarnKey;
            enforced = false;

            return true;
        }

        var bulkApplies = !DisabledByDefaultDiagnostics.Contains(diagnosticId);
        var category = GetDiagnosticCategory(diagnosticId);
        string?[] candidates =
        [
            EditorConfigOptions.DiagnosticSeverityKey(diagnosticId),
            !bulkApplies || category is null ? null : "dotnet_analyzer_diagnostic.category-" + category.ToLowerInvariant() + ".severity",
            bulkApplies ? "dotnet_analyzer_diagnostic.severity" : null,
        ];

        foreach (var candidate in candidates)
        {
            if (candidate is not null && _editorConfig.TryGetValue(candidate, out var severity) && severity is not null && TryParseSeverity(severity.Trim(), out enforced))
            {
                severityKey = candidate;

                return true;
            }
        }

        severityKey = null;
        enforced = false;

        return false;
    }

    private static string? GetDiagnosticCategory(string diagnosticId) => diagnosticId.StartsWith("IDE", StringComparison.OrdinalIgnoreCase)
        ? "Style"
        : AnalyzerCategories.GetValueOrDefault(diagnosticId);

    private static bool IsEnforcing(string? severity) => severity is null || (TryParseSeverity(severity, out var enforced) && enforced);

    /// <summary>Parses a severity: <c>none</c>, <c>silent</c> and <c>refactoring</c> do not enforce; <c>suggestion</c> and above do.</summary>
    internal static bool TryParseSeverity(string severity, out bool enforced)
    {
        enforced = true;
        switch (severity.ToLowerInvariant())
        {
            case "none":
            case "silent":
            case "refactoring":
                enforced = false;
                return true;

            case "suggestion":
            case "warning":
            case "error":
                return true;

            default:
                return false;
        }
    }

    private static bool? ParseBoolean(string value) => bool.TryParse(value, out var parsed) ? parsed : null;

    private static bool? ParseInvertedBoolean(string value) => bool.TryParse(value, out var parsed) ? !parsed : null;

    private static bool? ParseExpressionBodyPreference(string value) => string.Equals(value, "when_on_single_line", StringComparison.OrdinalIgnoreCase) ? true : ParseBoolean(value);

    private static bool? ParseCollectionExpressionPreference(string value) => value.ToLowerInvariant() switch
    {
        "true" or "when_types_exactly_match" or "when_types_loosely_match" => true,
        "false" or "never" => false,
        _ => null,
    };

    private static bool? ParseAccessibilityModifiersPreference(string value) => value.ToLowerInvariant() switch
    {
        "always" or "for_non_interface_members" => true,
        "never" or "omit_if_default" => false,
        _ => null,
    };

    private static bool? ParseNamespaceDeclarations(string value) => value.ToLowerInvariant() switch
    {
        "file_scoped" => true,
        "block_scoped" => false,
        _ => null,
    };

    private static bool? ParseUsingDirectivePlacement(string value) => value.ToLowerInvariant() switch
    {
        "outside_namespace" => true,
        "inside_namespace" => false,
        _ => null,
    };

    private sealed record RuleLink(string[] Settings, string? Key, string[] DiagnosticIds, Func<string, bool?>? Parse, bool DefaultValue, string? OptionDefault = null);

    /// <summary>A setting applied through a Roslyn analyzer and code fix.</summary>
    /// <param name="Settings">The settings that turn the step on (any of them).</param>
    /// <param name="Key">The <c>.editorconfig</c> option of the rule.</param>
    /// <param name="Value">The option value the step applies.</param>
    /// <param name="DiagnosticIds">The diagnostics the step fixes.</param>
    /// <param name="ReverseDiagnosticIds">The diagnostics applying the opposite value when <c>.editorconfig</c> decides it.</param>
    /// <param name="OtherOptions">The other boolean options reported through the same diagnostics.</param>
    internal sealed record RoslynStep(string[] Settings, string Key, string Value, string[] DiagnosticIds, string[] ReverseDiagnosticIds, params string[] OtherOptions)
    {
        public RoslynStep(string setting, string key, string value, string[] diagnosticIds, string[] reverseDiagnosticIds, params string[] otherOptions)
            : this([setting], key, value, diagnosticIds, reverseDiagnosticIds, otherOptions)
        {
        }
    }
}
