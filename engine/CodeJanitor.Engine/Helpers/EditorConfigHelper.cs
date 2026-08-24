using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace CodeJanitor.Helpers;

/// <summary>
/// utility class that reads .editorconfig files and applies their C# formatting settings to source text.
/// </summary>
internal static class EditorConfigHelper
{
    /// <summary>
    /// Loads EditorConfig-based C# options for the given file path, returning default options if the path is blank, otherwise enumerating and applying each relevant config file to the options object.
    /// </summary>
    /// <param name="filePath">The file path.</param>
    /// <returns>A EditorConfigCSharpOptions value produced by this method.</returns>

    internal static EditorConfigCSharpOptions LoadCSharpOptions(string filePath)
    {
        var options = new EditorConfigCSharpOptions();
        if (string.IsNullOrWhiteSpace(filePath))
        {
            return options;
        }

        var configFiles = EnumerateEditorConfigFiles(filePath).ToList();
        foreach (var configFile in configFiles)
        {
            ApplyFile(configFile, filePath, options);
        }

        return options;
    }

    /// <summary>
    /// This method parses an EditorConfig-style text, ignoring blank lines and comments, toggling active state based on C# section headers, and mutating the provided options object by applying each matching key-value setting, with no exceptions thrown.
    /// </summary>
    /// <param name="editorConfigText">The editor config text.</param>
    /// <param name="filePath">The file path.</param>
    /// <param name="options">The options.</param>

    internal static void ApplyText(string editorConfigText, string filePath, EditorConfigCSharpOptions options)
    {
        if (string.IsNullOrWhiteSpace(editorConfigText) || options is null || string.IsNullOrWhiteSpace(filePath))
        {
            return;
        }

        var active = true;
        using (var reader = new StringReader(editorConfigText))
        {
            string line;
            while ((line = reader.ReadLine()) is not null)
            {
                var trimmed = line.Trim();
                if (string.IsNullOrWhiteSpace(trimmed) || trimmed.StartsWith(";", StringComparison.Ordinal))
                {
                    continue;
                }

                if (trimmed.StartsWith("[", StringComparison.Ordinal) && trimmed.EndsWith("]", StringComparison.Ordinal))
                {
                    var section = trimmed.Substring(1, trimmed.Length - 2).Trim();
                    active = MatchesCSharpSection(section, filePath);
                    continue;
                }

                if (!active)
                {
                    continue;
                }

                var separatorIndex = trimmed.IndexOf('=');
                if (separatorIndex <= 0)
                {
                    continue;
                }

                var key = trimmed.Substring(0, separatorIndex).Trim();
                var value = trimmed.Substring(separatorIndex + 1).Trim();
                ApplySetting(options, key, value);
            }
        }
    }

    /// <summary>
    /// Walks from the file&apos;s directory up through parent directories, pushing each found .editorconfig onto a stack and reading its text to break early if it contains &quot;root = true&quot; (case-insensitive), returning the collected configs nearest-first without throwing exceptions.
    /// </summary>
    /// <param name="filePath">The file path.</param>
    /// <returns>A IEnumerable&lt;string&gt; value produced by this method.</returns>

    private static IEnumerable<string> EnumerateEditorConfigFiles(string filePath)
    {
        var directory = Path.GetDirectoryName(filePath);
        var found = new Stack<string>();

        while (!string.IsNullOrWhiteSpace(directory) && Directory.Exists(directory))
        {
            var configPath = Path.Combine(directory, ".editorconfig");
            if (File.Exists(configPath))
            {
                found.Push(configPath);
                var text = File.ReadAllText(configPath);
                if (text.IndexOf("root = true", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    break;
                }
            }

            directory = Path.GetDirectoryName(directory);
        }

        return found;
    }

    /// <summary>
    /// Reads the entire content of the specified config file and delegates it along with the target file path and options to ApplyText, which applies the formatting logic and may modify the target file.
    /// </summary>
    /// <param name="configPath">The config path.</param>
    /// <param name="filePath">The file path.</param>
    /// <param name="options">The options.</param>

    private static void ApplyFile(string configPath, string filePath, EditorConfigCSharpOptions options)
    {
        ApplyText(File.ReadAllText(configPath), filePath, options);
    }

    /// <summary>
    /// Returns true if the section is non-empty and either equals &quot;*&quot; or contains &quot;cs&quot; (case-insensitive) while the filePath has a &quot;.cs&quot; extension, with no side effects or exceptions.
    /// </summary>
    /// <param name="section">The section.</param>
    /// <param name="filePath">The file path.</param>
    /// <returns>A bool value produced by this method.</returns>

    private static bool MatchesCSharpSection(string section, string filePath)
    {
        if (string.IsNullOrWhiteSpace(section))
        {
            return false;
        }

        var normalized = section.Replace(" ", string.Empty);
        if (normalized == "*")
        {
            return true;
        }

        if (normalized.IndexOf("cs", StringComparison.OrdinalIgnoreCase) < 0)
        {
            return false;
        }

        return string.Equals(Path.GetExtension(filePath), ".cs", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Applies recognized EditorConfig key-value pairs to the provided EditorConfigCSharpOptions by mutating its properties, parsing boolean or integer values where appropriate via TryParseBool and TryParseInt, and silently ignoring unrecognized keys.
    /// </summary>
    /// <param name="options">The options.</param>
    /// <param name="key">The key.</param>
    /// <param name="value">The value.</param>

    private static void ApplySetting(EditorConfigCSharpOptions options, string key, string value)
    {
        switch (key)
        {
            case "trim_trailing_whitespace":
                options.TrimTrailingWhitespace = TryParseBool(value);
                break;

            case "dotnet_sort_system_directives_first":
                options.SortSystemDirectivesFirst = TryParseBool(value);
                break;

            case "dotnet_separate_import_directive_groups":
                options.SeparateImportDirectiveGroups = TryParseBool(value);
                break;

            case "insert_final_newline":
                options.InsertFinalNewline = TryParseBool(value);
                break;

            case "indent_style":
                options.IndentStyle = value;
                break;

            case "indent_size":
                options.IndentSize = TryParseInt(value);
                break;

            case "tab_width":
                options.TabWidth = TryParseInt(value);
                break;
        }
    }

    /// <summary>
    /// Attempts to parse the input string as a Boolean using bool.TryParse, returning the parsed value on success or null on failure without throwing exceptions or producing side effects.
    /// </summary>
    /// <param name="value">The value.</param>
    /// <returns>A bool? value produced by this method.</returns>

    private static bool? TryParseBool(string value)
    {
        if (bool.TryParse(value, out var parsed))
        {
            return parsed;
        }

        return null;
    }

    /// <summary>
    /// Attempts to parse the string as an int using int.TryParse and returns the parsed value on success or null on failure without throwing exceptions or causing side effects.
    /// </summary>
    /// <param name="value">The value.</param>
    /// <returns>A int? value produced by this method.</returns>

    private static int? TryParseInt(string value)
    {
        if (int.TryParse(value, out var parsed))
        {
            return parsed;
        }

        return null;
    }
}
