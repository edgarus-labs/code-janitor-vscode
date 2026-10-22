using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis;

namespace CodeJanitor.Engine.Contracts;

/// <summary>
/// The cleanup settings in effect for one file, keyed by the camelCase names of the extension's
/// <c>CleanupSettings</c> (for example <c>removeRegions</c>, <c>fileHeaderCSharp</c>, <c>codeStyleRules</c>):
/// the user's settings with the nearest <c>.codejanitor</c> and the file's <c>.editorconfig</c> applied over them.
/// </summary>
public interface IEffectiveSettings
{
    /// <summary>The value of a boolean setting.</summary>
    bool GetBool(string key);

    /// <summary>The value of a string setting.</summary>
    string GetString(string key);

    /// <summary>The value of a number setting.</summary>
    int GetInt(string key);

    /// <summary>The value of a string list setting.</summary>
    IReadOnlyList<string> GetList(string key);

    /// <summary>The raw value of an object setting (for example <c>reorganize</c>, <c>commentFormat</c>), or null.</summary>
    JsonNode? GetNode(string key);

    /// <summary>The <c>.editorconfig</c> value of an option for the file, or null when it does not set it.</summary>
    string? EditorConfigValue(string key);
}

/// <summary>Where a cleanup step runs; steps run by stage, then by <see cref="ICleanupStep.Order"/>.</summary>
public enum CleanupStage
{
    /// <summary>Member reorganization, before anything else when it runs at the start of cleanup.</summary>
    Reorganize = 0,

    /// <summary>Steps that need the semantic model of the solution (sealing classes, null checks).</summary>
    Semantic = 100,

    /// <summary>Code Janitor's own syntax and text steps.</summary>
    Text = 200,

    /// <summary>The Roslyn analyzers and code fixes the settings and <c>.editorconfig</c> enable.</summary>
    Diagnostics = 300,

    /// <summary>Layout steps that must see the final text (trailing whitespace, final newline).</summary>
    Final = 400,
}

/// <summary>
/// One Code Janitor cleanup step. Steps are discovered by reflection: every non-abstract implementation with a
/// public parameterless constructor in the engine assembly runs, ordered by <see cref="Stage"/> then <see cref="Order"/>.
/// </summary>
public interface ICleanupStep
{
    /// <summary>The name shown in the preview and the output channel.</summary>
    string Name { get; }

    /// <summary>The rule id a preview can exclude (for example <c>CJ0001</c> or <c>IDE0161</c>), or null.</summary>
    string? RuleId { get; }

    CleanupStage Stage { get; }

    int Order { get; }

    bool IsEnabled(IEffectiveSettings settings);

    /// <summary>
    /// Applies the step to the document and returns the changed solution (usually only this document's text;
    /// renames may change other documents, type splits add documents).
    /// </summary>
    Task<Solution> ApplyAsync(Document document, IEffectiveSettings settings, CancellationToken cancellationToken);
}

/// <summary>
/// An explicit command on one document (Reorganize, Split Top-Level Types, Fix Namespace, Remove XML Documentation,
/// ...), discovered by reflection like <see cref="ICleanupStep"/> and invoked by <see cref="Name"/>.
/// </summary>
public interface IDocumentCommand
{
    /// <summary>The protocol name, for example <c>reorganize</c>.</summary>
    string Name { get; }

    Task<Solution> ExecuteAsync(Document document, IEffectiveSettings settings, JsonObject? arguments, CancellationToken cancellationToken);
}

/// <summary>
/// A read-only question about one document (for example the member at a position, or the members lacking XML
/// documentation), discovered by reflection like <see cref="ICleanupStep"/> and invoked by <see cref="Name"/>.
/// </summary>
public interface IDocumentQuery
{
    /// <summary>The protocol name, for example <c>memberAtPosition</c>.</summary>
    string Name { get; }

    Task<JsonNode?> QueryAsync(Document document, IEffectiveSettings settings, JsonObject? arguments, CancellationToken cancellationToken);
}

/// <summary>A cleanup of one document.</summary>
/// <param name="UserSettings">The user's settings, as the extension sends them (no repository policy applied).</param>
/// <param name="ExcludedRules">Rule ids the preview left out.</param>
/// <param name="ChangedLines">With <c>onlyChangedLines</c>: the 1-based inclusive line ranges changed since HEAD; null means every line.</param>
/// <param name="OnSave">
/// A cleanup on save: no step changes or creates another file (types are reported, not moved; renames stay in the document),
/// and with <c>skipOrganizeUsingsDuringCleanupOnSave</c> the using directives are neither sorted nor removed.
/// </param>
/// <param name="Partial">
/// A partial cleanup of a file outside the workspace folders: like <paramref name="OnSave"/>, and the using directives are
/// never sorted, removed or moved.
/// </param>
public sealed record CleanupRequest(JsonObject UserSettings, IReadOnlyCollection<string> ExcludedRules, IReadOnlyList<LineRange>? ChangedLines, bool OnSave = false, bool Partial = false);

public sealed record LineRange(int Start, int End);

/// <summary>What a cleanup did.</summary>
/// <param name="Solution">The solution after the cleanup; the host diffs it against the original.</param>
/// <param name="Rules">Per rule or step: how many places it changed and whether it was included.</param>
/// <param name="Unresolved">The enforced diagnostics cleanup could not fix.</param>
/// <param name="Issues">Messages for the output channel (skipped rules, failed fixes).</param>
public sealed record CleanupOutcome(Solution Solution, IReadOnlyList<RuleOutcome> Rules, IReadOnlyList<UnresolvedDiagnostic> Unresolved, IReadOnlyList<string> Issues)
{
    /// <summary>What cleanup could not do because a step or an analyzer crashed; shown with the issues, but a failure of the cleanup rather than a note.</summary>
    public IReadOnlyList<string> Failures { get; init; } = [];
}

public sealed record RuleOutcome(string Id, string Name, int Changes, bool Included);

public sealed record UnresolvedDiagnostic(string Id, string Message, string Severity, int Line, int Column, string Reason);

/// <summary>One diagnostic for the Problems panel; positions are 0-based.</summary>
public sealed record EngineDiagnostic(
    string Id,
    string Message,
    string Severity,
    int StartLine,
    int StartColumn,
    int EndLine,
    int EndColumn,
    bool Fixable,
    string? HelpLink);

/// <summary>The cleanup engine the host calls; documents carry the editor's unsaved text.</summary>
public interface ICleanupEngine
{
    Task<CleanupOutcome> CleanupAsync(Document document, CleanupRequest request, CancellationToken cancellationToken);

    /// <summary>The enforced diagnostics of the document: what cleanup would fix and what it cannot.</summary>
    Task<IReadOnlyList<EngineDiagnostic>> AnalyzeAsync(Document document, JsonObject userSettings, CancellationToken cancellationToken);

    /// <summary>Fixes one rule in the document, or only its occurrence on <paramref name="line"/> (0-based) when given.</summary>
    Task<CleanupOutcome> FixRuleAsync(Document document, JsonObject userSettings, string ruleId, int? line, CancellationToken cancellationToken);

    /// <summary>For the settings panel: setting key to the note naming what overrides it for a C# file in <paramref name="directory"/>.</summary>
    Task<IReadOnlyDictionary<string, string>> OverrideNotesAsync(string directory, JsonObject userSettings, CancellationToken cancellationToken);

    Task<Solution> ExecuteCommandAsync(Document document, string command, JsonObject userSettings, JsonObject? arguments, CancellationToken cancellationToken);

    Task<JsonNode?> QueryAsync(Document document, string query, JsonObject userSettings, JsonObject? arguments, CancellationToken cancellationToken);
}
