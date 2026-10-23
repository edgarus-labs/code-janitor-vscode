using System.Text.Json.Nodes;
using CodeJanitor.Engine.Contracts;

namespace CodeJanitor.Server;

/// <summary>The parameters of <c>initialize</c>.</summary>
public sealed record InitializeParams(IReadOnlyList<string>? WorkspaceFolders);

/// <summary>The result of <c>initialize</c>.</summary>
public sealed record InitializeResult(string ServerVersion, string RoslynVersion);

/// <summary>The editor text of a file with unsaved changes.</summary>
public sealed record UnsavedDocument(string Path, string Text);

/// <summary>The parameters of <c>cleanup</c>; <c>onSave</c> and <c>partial</c> are those of <see cref="CleanupRequest"/>.</summary>
public sealed record CleanupParams(
    string FilePath,
    string? Text,
    JsonObject? Settings,
    IReadOnlyList<string>? ExcludedRules,
    IReadOnlyList<LineRange>? ChangedLines,
    IReadOnlyList<UnsavedDocument>? UnsavedDocuments,
    bool? OnSave = null,
    bool? Partial = null);

/// <summary>The parameters of <c>analyze</c>.</summary>
public sealed record AnalyzeParams(string FilePath, string? Text, JsonObject? Settings, IReadOnlyList<UnsavedDocument>? UnsavedDocuments);

/// <summary>The result of <c>analyze</c>.</summary>
public sealed record AnalyzeResult(IReadOnlyList<EngineDiagnostic> Diagnostics);

/// <summary>The parameters of <c>query</c>.</summary>
public sealed record QueryParams(
    string FilePath,
    string? Text,
    JsonObject? Settings,
    string Query,
    JsonObject? Arguments,
    IReadOnlyList<UnsavedDocument>? UnsavedDocuments);

/// <summary>The parameters of <c>fixRule</c>.</summary>
public sealed record FixRuleParams(
    string FilePath,
    string? Text,
    JsonObject? Settings,
    string RuleId,
    int? Line,
    IReadOnlyList<UnsavedDocument>? UnsavedDocuments);

/// <summary>The parameters of <c>command</c>.</summary>
public sealed record CommandParams(
    string FilePath,
    string? Text,
    JsonObject? Settings,
    string Command,
    JsonObject? Arguments,
    IReadOnlyList<UnsavedDocument>? UnsavedDocuments);

/// <summary>The parameters of <c>overrideNotes</c>.</summary>
public sealed record OverrideNotesParams(string Directory, JsonObject? Settings);

/// <summary>The result of <c>overrideNotes</c>.</summary>
public sealed record OverrideNotesResult(IReadOnlyDictionary<string, string> Notes);

/// <summary>
/// The parameters of <c>formatCommentText</c>: the text of a file that is not C#, its single-line comment prefix and
/// the 0-based lines whose comments are formatted (all when absent).
/// </summary>
public sealed record FormatCommentTextParams(string Text, string CommentPrefix, int? StartLine, int? EndLine, JsonObject? Settings);

/// <summary>The result of <c>formatCommentText</c>.</summary>
public sealed record FormatCommentTextResult(string Text);

/// <summary>The parameters of the <c>fileChanged</c> notification.</summary>
public sealed record FileChangedParams(string Path);

/// <summary>The new text of a file; it starts with U+FEFF when the file has a UTF-8 byte order mark.</summary>
public sealed record FileText(string Path, string Text);

/// <summary>
/// The result of <c>cleanup</c>, <c>fixRule</c> and <c>command</c>: <see cref="Issues"/> are notes, <see cref="Failures"/> are
/// steps that failed and were undone, <see cref="Warnings"/> are why the file was not cleaned in its own project.
/// </summary>
public sealed record CleanupResult(
    string Text,
    IReadOnlyList<FileText> OtherFiles,
    IReadOnlyList<FileText> NewFiles,
    IReadOnlyList<RuleOutcome> Rules,
    IReadOnlyList<UnresolvedDiagnostic> Unresolved,
    IReadOnlyList<string> Issues,
    IReadOnlyList<string> Failures,
    IReadOnlyList<string> Warnings);
