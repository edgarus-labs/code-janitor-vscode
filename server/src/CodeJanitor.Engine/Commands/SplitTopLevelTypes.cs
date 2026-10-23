using System.Text;
using System.Text.Json.Nodes;
using CodeJanitor.Engine.Contracts;
using CodeJanitor.Engine.Pipeline;
using CodeJanitor.Engine.Steps;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace CodeJanitor.Engine.Commands;

/// <summary>
/// Moves every top-level type of the document but the one named like the file (else the first) to a file of its own
/// in the same folder and project. Classes, records, structs, interfaces, enums and delegates move; partial types stay.
/// </summary>
public sealed class SplitTopLevelTypesCommand : IDocumentCommand
{
    public string Name => "splitTopLevelTypes";

    public async Task<Solution> ExecuteAsync(Document document, IEffectiveSettings settings, JsonObject? arguments, CancellationToken cancellationToken)
    {
        var text = await document.GetTextAsync(cancellationToken).ConfigureAwait(false);
        var filePath = TopLevelTypeSplit.FilePathOf(document);
        var plan = new TopLevelTypeToFileSplitPlanner().CreatePlan(text.ToString(), filePath, TopLevelTypeSplit.ReservedFileNames(document, filePath), null, refuseFileNameCollisions: false);

        return TopLevelTypeSplit.Apply(document, text, plan, settings);
    }
}

/// <summary>
/// One type per file, as the analyzer rules the file's <c>.editorconfig</c> enforces ask: <c>SA1402</c> moves the extra
/// classes to their own files, <c>MA0048</c> every type not named like the file, <c>SA1649</c> is only reported. A rule
/// counts only when <c>dotnet_diagnostic.&lt;id&gt;.severity</c> is set to suggestion, warning or error. Files are never
/// renamed or overwritten.
/// </summary>
public sealed class OneTypePerFileStep : IIssueReportingStep, IFileCreatingStep
{
    public string Name => "One type per file (SA1402, MA0048)";

    public string? RuleId => "oneTypePerFile";

    public CleanupStage Stage => CleanupStage.Text;

    public int Order => 5;

    public bool IsEnabled(IEffectiveSettings settings) =>
        StepSettings.IsDiagnosticEnforced(settings, "SA1402") || StepSettings.IsDiagnosticEnforced(settings, "MA0048") || StepSettings.IsDiagnosticEnforced(settings, "SA1649");

    public async Task<Solution> ApplyAsync(Document document, IEffectiveSettings settings, CancellationToken cancellationToken) =>
        (await ApplyWithIssuesAsync(document, settings, cancellationToken).ConfigureAwait(false)).Solution;

    /// <summary>Splits the file as the rules ask and reports the violations left (SA1649, types that cannot move).</summary>
    public async Task<(Solution Solution, IReadOnlyList<string> Issues)> ApplyWithIssuesAsync(Document document, IEffectiveSettings settings, CancellationToken cancellationToken)
    {
        var text = await document.GetTextAsync(cancellationToken).ConfigureAwait(false);
        var filePath = TopLevelTypeSplit.FilePathOf(document);
        var outcome = OneTypePerFile.Plan(text.ToString(), filePath, settings, TopLevelTypeSplit.ReservedFileNames(document, filePath));

        return (TopLevelTypeSplit.Apply(document, text, outcome.Plan, settings), outcome.Issues);
    }

    /// <summary>Reports the types the split would move, and the other violations, without moving any.</summary>
    async Task<IReadOnlyList<string>> IFileCreatingStep.ReportWithoutCreatingAsync(Document document, IEffectiveSettings settings, string reason, CancellationToken cancellationToken)
    {
        var text = await document.GetTextAsync(cancellationToken).ConfigureAwait(false);
        var filePath = TopLevelTypeSplit.FilePathOf(document);

        return OneTypePerFile.Plan(text.ToString(), filePath, settings, TopLevelTypeSplit.ReservedFileNames(document, filePath), reason).Issues;
    }
}

/// <summary>The one-type-per-file split the <c>.editorconfig</c> rules ask for, with the violations it leaves.</summary>
internal static class OneTypePerFile
{
    public sealed record Outcome(TopLevelTypeToFileSplitPlanner.SplitPlan Plan, IReadOnlyList<string> Issues);

    /// <summary>
    /// The split the rules ask for and the violations it leaves. With <paramref name="notMovedBecause"/> nothing is moved:
    /// the types the split would move are reported with that reason.
    /// </summary>
    public static Outcome Plan(string source, string filePath, IEffectiveSettings settings, IEnumerable<string> reservedFileNames, string? notMovedBecause = null)
    {
        var sa1402 = Severity(settings, "SA1402");
        var ma0048 = Severity(settings, "MA0048");
        var sa1649 = Severity(settings, "SA1649");
        Func<MemberDeclarationSyntax, bool>? movable = ma0048 is not null ? _ => true : sa1402 is not null ? IsClass : null;
        var planner = new TopLevelTypeToFileSplitPlanner();
        var planned = movable is null
            ? new TopLevelTypeToFileSplitPlanner.SplitPlan(source, [], TopLevelTypeSplitSkipReason.NotMultipleEligibleTypes)
            : planner.CreatePlan(source, filePath, reservedFileNames, movable, refuseFileNameCollisions: true);
        var plan = notMovedBecause is null ? planned : new TopLevelTypeToFileSplitPlanner.SplitPlan(source, [], planned.SkipReason);
        var why = planned.HasChanges ? notMovedBecause : null;

        var remaining = TopLevelTypes(plan.HasChanges ? plan.UpdatedSource : source);
        var stem = FileStem(filePath);
        var issues = new List<string>();
        var named = remaining.FirstOrDefault(type => string.Equals(TopLevelTypeToFileSplitPlanner.BuildTypeFileStem(type.Member), stem, StringComparison.OrdinalIgnoreCase))
            ?? remaining.FirstOrDefault(type => MatchesFileName(type, stem));

        if (sa1402 is not null)
        {
            var classes = remaining.Where(type => IsClass(type.Member)).ToList();
            var kept = named ?? classes.FirstOrDefault();
            foreach (var type in classes.Where(type => type != kept))
            {
                issues.Add(NotMoved("SA1402", sa1402, type, plan, why));
            }
        }

        if (ma0048 is not null)
        {
            foreach (var type in remaining.Where(type => !MatchesFileName(type, stem)))
            {
                issues.Add(remaining.Count > 1 ? NotMoved("MA0048", ma0048, type, plan, why) : NameMismatch("MA0048", ma0048, type));
            }
        }

        if (sa1649 is not null && remaining.Count > 0 && !MatchesFileName(remaining[0], stem))
        {
            issues.Add(NameMismatch("SA1649", sa1649, remaining[0]));
        }

        return new Outcome(plan, issues);
    }

    private static string? Severity(IEffectiveSettings settings, string id) =>
        StepSettings.IsDiagnosticEnforced(settings, id) ? StepSettings.EditorConfig(settings, "dotnet_diagnostic." + id.ToLowerInvariant() + ".severity") : null;

    private static bool IsClass(MemberDeclarationSyntax member) =>
        member is ClassDeclarationSyntax || (member is RecordDeclarationSyntax record && !record.ClassOrStructKeyword.IsKind(SyntaxKind.StructKeyword));

    private static string NotMoved(string id, string severity, TypeInfo type, TopLevelTypeToFileSplitPlanner.SplitPlan plan, string? notMovedBecause)
    {
        var reason = type.IsPartial
            ? "it is partial"
            : notMovedBecause ?? plan.SkipReason switch
            {
                TopLevelTypeSplitSkipReason.FileNameCollision => $"'{type.FileName}' or the file of another type already exists",
                TopLevelTypeSplitSkipReason.UnsupportedStructure => "the file uses preprocessor directives, assembly attributes or several namespaces",
                _ => "the other types of the file cannot be moved, so it stays as the main type of the file",
            };

        return $"{id} ({severity}) line {type.Line}: type '{type.Name}' was not moved to its own file because {reason}.";
    }

    private static string NameMismatch(string id, string severity, TypeInfo type) =>
        $"{id} ({severity}) line {type.Line}: the file name does not match type '{type.Name}' (expected '{type.FileName}'); files are not renamed.";

    /// <summary>The file name up to its first dot (<c>Form.Designer.cs</c>: <c>Form</c>), as both analyzers compare.</summary>
    private static string FileStem(string filePath)
    {
        var name = Path.GetFileName(filePath);
        var dot = name.IndexOf('.', StringComparison.Ordinal);

        return dot < 0 ? name : name[..dot];
    }

    /// <summary>Whether the type is named like the file: its name, or its name with <c>{T}</c>/<c>`1</c> type parameters.</summary>
    private static bool MatchesFileName(TypeInfo type, string stem) =>
        string.Equals(type.Name, stem, StringComparison.OrdinalIgnoreCase) ||
        string.Equals(TopLevelTypeToFileSplitPlanner.BuildTypeFileStem(type.Member), stem, StringComparison.OrdinalIgnoreCase) ||
        (type.TypeParameterCount > 0 && string.Equals($"{type.Name}`{type.TypeParameterCount}", stem, StringComparison.OrdinalIgnoreCase));

    private static List<TypeInfo> TopLevelTypes(string source)
    {
        var root = CSharpSyntaxTree.ParseText(source).GetCompilationUnitRoot();
        var members = root.Members.Count == 1 && root.Members[0] is BaseNamespaceDeclarationSyntax ns ? ns.Members : root.Members;

        return members
            .Where(member => member is BaseTypeDeclarationSyntax or DelegateDeclarationSyntax)
            .Select(member => new TypeInfo(
                member,
                member is BaseTypeDeclarationSyntax type ? type.Identifier.ValueText : ((DelegateDeclarationSyntax)member).Identifier.ValueText,
                TopLevelTypeToFileSplitPlanner.BuildTypeFileName(member),
                member.Modifiers.Any(SyntaxKind.PartialKeyword),
                (member as TypeDeclarationSyntax)?.TypeParameterList?.Parameters.Count ?? (member as DelegateDeclarationSyntax)?.TypeParameterList?.Parameters.Count ?? 0,
                member.GetLocation().GetLineSpan().StartLinePosition.Line + 1))
            .ToList();
    }

    private sealed record TypeInfo(MemberDeclarationSyntax Member, string Name, string FileName, bool IsPartial, int TypeParameterCount, int Line);
}

/// <summary>Applies a top-level type split plan to the solution.</summary>
internal static class TopLevelTypeSplit
{
    public static string FilePathOf(Document document) => document.FilePath ?? Path.Combine(Directory.GetCurrentDirectory(), document.Name);

    /// <summary>The <c>.cs</c> files of the folder on disk and in the solution, which a split never overwrites.</summary>
    public static IEnumerable<string> ReservedFileNames(Document document, string filePath)
    {
        var directory = Path.GetDirectoryName(filePath);
        var inSolution = document.Project.Solution.Projects
            .SelectMany(project => project.Documents)
            .Where(other => other.FilePath is not null && string.Equals(Path.GetDirectoryName(other.FilePath), directory, StringComparison.OrdinalIgnoreCase))
            .Select(other => Path.GetFileName(other.FilePath!));

        return TopLevelTypeToFileSplitPlanner.ReadDirectoryFileNames(filePath).Concat(inSolution);
    }

    /// <summary>
    /// The document with the updated source and the project with the new files (UTF-8, with a byte order mark only
    /// when the document has one and <c>removeByteOrderMark</c> is off).
    /// </summary>
    public static Solution Apply(Document document, SourceText text, TopLevelTypeToFileSplitPlanner.SplitPlan plan, IEffectiveSettings settings)
    {
        if (!plan.HasChanges)
        {
            return document.Project.Solution;
        }

        var keepsBom = text.Encoding?.GetPreamble().Length > 0 && !settings.GetBool("removeByteOrderMark");
        var encoding = text.Encoding is null && !keepsBom ? null : new UTF8Encoding(keepsBom);
        var project = document.WithText(SourceText.From(plan.UpdatedSource, text.Encoding, text.ChecksumAlgorithm)).Project;
        foreach (var planned in plan.NewFiles)
        {
            project = project.AddDocument(Path.GetFileName(planned.FilePath), SourceText.From(planned.Content, encoding ?? new UTF8Encoding(false), text.ChecksumAlgorithm), document.Folders, planned.FilePath).Project;
        }

        return project.Solution;
    }
}
