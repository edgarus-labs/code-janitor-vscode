using System.Text.Json.Nodes;

namespace CodeJanitor.Engine.Settings;

/// <summary>
/// The settings panel notes for settings the workspace's <c>.editorconfig</c> or <c>.codejanitor</c> overrides. Settings are global while <c>.editorconfig</c> applies
/// per directory, so the notes describe a C# file in the workspace folder: nested <c>.editorconfig</c> files below it are not
/// considered, and a key that is not enforced (or has an unrecognized value) gives no note.
/// </summary>
internal static class OverrideNotes
{
    /// <summary>
    /// The note of each overridden setting, keyed by setting name (or the option name of a Code Style rule):
    /// <c>Overridden by .editorconfig: &lt;key&gt; in &lt;path&gt;</c> for what <c>.editorconfig</c> decides, otherwise
    /// <c>Overridden by .codejanitor: &lt;key&gt; in &lt;path&gt;</c> for what the policy lists.
    /// </summary>
    public static IReadOnlyDictionary<string, string> For(string probePath, JsonObject userSettings, Func<string, string, string?>? findDefiningConfigPath = null)
    {
        findDefiningConfigPath ??= EditorConfigOptions.FindDefiningConfigPath;
        var settings = EffectiveSettings.ForFile(probePath, userSettings);
        var keys = settings.EditorConfigKeys.Concat(settings.CodeStyleEditorConfigKeys).ToDictionary(entry => entry.Key, entry => entry.Value, StringComparer.Ordinal);
        var keyNotes = keys.Values.Distinct(StringComparer.Ordinal).ToDictionary(
            key => key,
            key => findDefiningConfigPath(probePath, key) is { } definingPath
                ? $"Overridden by .editorconfig: {key} in {definingPath}"
                : $"Overridden by .editorconfig: {key}",
            StringComparer.Ordinal);
        var notes = keys.ToDictionary(entry => entry.Key, entry => keyNotes[entry.Value], StringComparer.Ordinal);

        var policy = settings.Policy;
        if (policy.ConfigPath is not null)
        {
            foreach (var key in policy.Overrides.Select(entry => entry.Key).Concat(policy.CodeStyle.Keys))
            {
                notes.TryAdd(key, $"Overridden by .codejanitor: {key} in {policy.ConfigPath}");
            }
        }

        return notes;
    }
}
