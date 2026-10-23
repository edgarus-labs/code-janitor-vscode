using System.Text.Json;
using System.Text.Json.Nodes;
using CodeJanitor.Engine.Contracts;
using CodeJanitor.Engine.Pipeline;
using CodeJanitor.Engine.Settings;
using CodeJanitor.Engine.Steps.Transformations;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;

namespace CodeJanitor.Engine.Steps;

/// <summary>
/// Seals the classes the solution proves safe to seal (CA1852 semantics). An enforced CA1852 turns the step on; when it
/// alone does (the setting itself is off), only the classes not visible outside the assembly are sealed, as CA1852
/// reports only those.
/// </summary>
public sealed class SealClassesStep : SourceTextStep
{
    private const string SettingKey = "sealClassesWhenSafe";

    private static readonly ClassSealingConverter Converter = new();

    public override string Name => "Seal classes when safe";

    public override string? RuleId => SettingKey;

    public override CleanupStage Stage => CleanupStage.Semantic;

    public override int Order => 10;

    protected override bool RejectsNewCompilerErrors => true;

    protected override async Task<string> TransformAsync(string source, Document document, IEffectiveSettings settings, CancellationToken cancellationToken) =>
        await Converter.SealWhenSafeAsync(
            await SemanticDocuments.OfAsync(document, cancellationToken).ConfigureAwait(false),
            [],
            keepExternallyVisibleClasses: IsOnOnlyByEditorConfig(settings),
            cancellationToken).ConfigureAwait(false);

    /// <summary>
    /// Whether <c>.editorconfig</c> (an enforced CA1852) decides the step is on while neither the repository policy nor the
    /// user's setting turns it on.
    /// </summary>
    private static bool IsOnOnlyByEditorConfig(IEffectiveSettings settings)
    {
        if (settings is not EffectiveSettings effective || !effective.EditorConfigKeys.ContainsKey(SettingKey))
        {
            return false;
        }

        var own = effective.Policy.Overrides.TryGetPropertyValue(SettingKey, out var policy) ? policy : effective.UserSettings[SettingKey];

        return own is not JsonValue value || value.GetValueKind() != JsonValueKind.True;
    }
}

/// <summary>
/// Converts the null checks proven safe to <c>is null</c> / <c>is not null</c>, and reports the <c>!= null</c> checks left
/// unchanged because a project compiling the file uses a language version older than C# 9.
/// </summary>
public sealed class PatternMatchingNullChecksStep : SourceTextStep, IIssueReportingStep
{
    public override string Name => "Convert to pattern-matching null checks";

    public override string? RuleId => "convertToPatternMatchingNullChecks";

    public override CleanupStage Stage => CleanupStage.Semantic;

    public override int Order => 20;

    protected override bool RejectsNewCompilerErrors => true;

    public async Task<(Solution Solution, IReadOnlyList<string> Issues)> ApplyWithIssuesAsync(Document document, IEffectiveSettings settings, CancellationToken cancellationToken)
    {
        var issues = new List<string>();
        var text = await document.GetTextAsync(cancellationToken).ConfigureAwait(false);
        var result = await ConvertAsync(document, issues.Add, cancellationToken).ConfigureAwait(false);

        return (await WithResultAsync(document, text, text.ToString(), result, cancellationToken).ConfigureAwait(false), issues);
    }

    protected override Task<string> TransformAsync(string source, Document document, IEffectiveSettings settings, CancellationToken cancellationToken) =>
        ConvertAsync(document, null, cancellationToken);

    private static async Task<string> ConvertAsync(Document document, Action<string>? reportSkipped, CancellationToken cancellationToken) =>
        await new NullCheckPatternMatchingConverter(reportSkipped).ConvertAsync(await SemanticDocuments.OfAsync(document, cancellationToken).ConfigureAwait(false), cancellationToken).ConfigureAwait(false);
}

/// <summary>
/// CA1869: a new <c>JsonSerializerOptions()</c> passed to a <c>JsonSerializer</c> call becomes <c>default</c>, and options built
/// from constants for one serializer call are cached in a <c>private static readonly</c> field.
/// </summary>
public sealed class ReuseJsonSerializerOptionsStep : SourceTextStep
{
    public override string Name => "Reuse JsonSerializerOptions (CA1869)";

    public override string? RuleId => "reuseJsonSerializerOptionsForCA1869";

    public override CleanupStage Stage => CleanupStage.Semantic;

    public override int Order => 30;

    protected override bool RejectsNewCompilerErrors => true;

    protected override async Task<string> TransformAsync(string source, Document document, IEffectiveSettings settings, CancellationToken cancellationToken)
    {
        var reused = new JsonSerializerOptionsReuseConverter().Apply(source);
        var text = await document.GetTextAsync(cancellationToken).ConfigureAwait(false);
        var current = reused == source ? document : document.WithText(SourceText.From(reused, text.Encoding, text.ChecksumAlgorithm));

        return await new JsonSerializerOptionsCachingConverter().CacheAsync(current, cancellationToken).ConfigureAwait(false);
    }
}

/// <summary>Converts <c>string.Format</c> calls to interpolated strings.</summary>
public sealed class StringFormatToInterpolationStep : SourceTextStep
{
    public override string Name => "Convert string.Format to interpolation";

    public override string? RuleId => "convertStringFormatToInterpolation";

    public override CleanupStage Stage => CleanupStage.Semantic;

    public override int Order => 40;

    protected override bool RejectsNewCompilerErrors => true;

    protected override async Task<string> TransformAsync(string source, Document document, IEffectiveSettings settings, CancellationToken cancellationToken)
    {
        var root = await document.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false);
        var model = await document.GetSemanticModelAsync(cancellationToken).ConfigureAwait(false);

        return root is null || model is null ? source : new StringInterpolationConverter().Apply(root, model);
    }
}

/// <summary>Replaces string literals naming a parameter or member with <c>nameof</c> (CA1507).</summary>
public sealed class NameOfStep : SourceTextStep
{
    public override string Name => "Convert to nameof (CA1507)";

    public override string? RuleId => "convertToStringNameOf";

    public override CleanupStage Stage => CleanupStage.Semantic;

    public override int Order => 50;

    protected override bool RejectsNewCompilerErrors => true;

    protected override string Transform(string source, Document document, IEffectiveSettings settings) => new NameOfOperatorConverter().Apply(source);
}

/// <summary>The documents of one file in every project compiling it.</summary>
internal static class SemanticDocuments
{
    /// <summary>
    /// The document first, then the documents of the same file in the other projects, given the document's text (an
    /// earlier step may have changed only this document).
    /// </summary>
    public static async Task<IReadOnlyList<Document>> OfAsync(Document document, CancellationToken cancellationToken)
    {
        if (string.IsNullOrEmpty(document.FilePath))
        {
            return [document];
        }

        var text = await document.GetTextAsync(cancellationToken).ConfigureAwait(false);
        var solution = document.Project.Solution;
        var others = solution.GetDocumentIdsWithFilePath(document.FilePath).Where(id => id != document.Id).ToList();
        foreach (var id in others)
        {
            solution = solution.WithDocumentText(id, text);
        }

        var documents = new List<Document> { solution.GetDocument(document.Id)! };
        documents.AddRange(others.Select(solution.GetDocument).OfType<Document>());

        return documents;
    }
}
