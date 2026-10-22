using CodeJanitor.Engine.Contracts;
using CodeJanitor.Engine.Steps.Transformations;

namespace CodeJanitor.Engine.Steps;

/// <summary>
/// Reads the settings and <c>.editorconfig</c> options the Code Janitor steps share.
/// </summary>
internal static class StepSettings
{
    private const int DefaultTabSize = 4;

    /// <summary>A plain <c>.editorconfig</c> value (severity suffix removed, lower case), or null when unset.</summary>
    public static string? EditorConfig(IEffectiveSettings settings, string key)
    {
        var value = settings.EditorConfigValue(key);
        if (value is null)
        {
            return null;
        }

        var colon = value.IndexOf(':', StringComparison.Ordinal);
        value = (colon >= 0 ? value[..colon] : value).Trim().ToLowerInvariant();

        return value.Length == 0 || value == "unset" ? null : value;
    }

    /// <summary>A boolean <c>.editorconfig</c> option, or null when it is unset or not a boolean.</summary>
    public static bool? EditorConfigBool(IEffectiveSettings settings, string key) => EditorConfig(settings, key) switch
    {
        "true" => true,
        "false" => false,
        _ => null,
    };

    /// <summary>Whether <c>.editorconfig</c> enforces a diagnostic (severity suggestion, warning or error).</summary>
    public static bool IsDiagnosticEnforced(IEffectiveSettings settings, string diagnosticId) =>
        EditorConfig(settings, "dotnet_diagnostic." + diagnosticId.ToLowerInvariant() + ".severity") is "suggestion" or "warning" or "error";

    /// <summary>Whether the file keeps (or gets) a final newline: unless <c>insert_final_newline = false</c>.</summary>
    public static bool InsertFinalNewline(IEffectiveSettings settings) => EditorConfigBool(settings, "insert_final_newline") != false;

    /// <summary>Whether end-of-line whitespace is removed: <c>trim_trailing_whitespace</c>, else the setting.</summary>
    public static bool TrimTrailingWhitespace(IEffectiveSettings settings) =>
        EditorConfigBool(settings, "trim_trailing_whitespace") ?? settings.GetBool("removeEndOfLineWhitespace");

    /// <summary>The tab size: <c>tab_width</c>, else a numeric <c>indent_size</c>, else 4.</summary>
    public static int TabSize(IEffectiveSettings settings)
    {
        foreach (var key in new[] { "tab_width", "indent_size" })
        {
            if (int.TryParse(EditorConfig(settings, key), System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out var size) && size > 0)
            {
                return size;
            }
        }

        return DefaultTabSize;
    }

    /// <summary>
    /// The C# file header: from <c>file_header_template</c> when <c>.editorconfig</c> sets it, else <c>fileHeaderCSharp</c>.
    /// </summary>
    public static string? FileHeader(IEffectiveSettings settings, string? filePath)
    {
        var template = settings.EditorConfigValue("file_header_template");
        if (template is not null)
        {
            return FileHeaderAndBlankLines.HeaderFromTemplate(template, filePath);
        }

        var header = settings.GetString("fileHeaderCSharp");

        return string.IsNullOrWhiteSpace(header) ? null : header;
    }

    /// <summary>The header position: <c>fileHeaderPosition</c> is <c>afterUsings</c> (or 1) or <c>documentStart</c>.</summary>
    public static HeaderPosition FileHeaderPosition(IEffectiveSettings settings) =>
        IsNamed(settings, "fileHeaderPosition", "afterUsings") ? HeaderPosition.AfterUsings : HeaderPosition.DocumentStart;

    /// <summary>The header update mode: <c>fileHeaderUpdateMode</c> is <c>replace</c> (or 1) or <c>insert</c>.</summary>
    public static HeaderUpdateMode FileHeaderUpdateMode(IEffectiveSettings settings) =>
        IsNamed(settings, "fileHeaderUpdateMode", "replace") ? HeaderUpdateMode.Replace : HeaderUpdateMode.Insert;

    private static bool IsNamed(IEffectiveSettings settings, string key, string name)
    {
        var value = settings.GetString(key);

        return string.Equals(value, name, StringComparison.OrdinalIgnoreCase) || value == "1";
    }
}
