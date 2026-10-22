namespace CodeJanitor.Engine.CodeStyle;

/// <summary>
/// A Roslyn code-style option Code Janitor applies when <c>.editorconfig</c> does not enforce it, through the
/// existing Roslyn analyzers and code fixes of its diagnostic IDs.
/// </summary>
public sealed class CodeStyleRule
{
    private readonly Func<string, bool> _isValidValue;

    internal CodeStyleRule(string group, string key, string description, string[] diagnosticIds, string[] values, string defaultValue, Func<string, bool>? isValidValue = null)
    {
        Group = group;
        Key = key;
        Description = description;
        DiagnosticIds = diagnosticIds;
        Values = values;
        DefaultValue = defaultValue;
        _isValidValue = isValidValue ?? (value => values.Contains(value, StringComparer.OrdinalIgnoreCase));
    }

    /// <summary>The group shown in the settings panel.</summary>
    public string Group { get; }

    /// <summary>The <c>.editorconfig</c> option name.</summary>
    public string Key { get; }

    /// <summary>The description shown in the settings panel.</summary>
    public string Description { get; }

    /// <summary>The IDs of the diagnostics reported for the option.</summary>
    public IReadOnlyList<string> DiagnosticIds { get; }

    /// <summary>The accepted values, or empty when the value is free text.</summary>
    public IReadOnlyList<string> Values { get; }

    /// <summary>The value proposed when the rule is enabled.</summary>
    public string DefaultValue { get; }

    /// <summary>Whether <paramref name="value"/> is a valid value of the option (listed values match ignoring case).</summary>
    public bool IsValidValue(string? value) => value is not null && _isValidValue(value);

    /// <summary>The matching listed value ignoring case, or the trimmed value for free text.</summary>
    public string Normalize(string value)
    {
        var trimmed = value.Trim();

        return Values.FirstOrDefault(entry => string.Equals(entry, trimmed, StringComparison.OrdinalIgnoreCase)) ?? trimmed;
    }
}
