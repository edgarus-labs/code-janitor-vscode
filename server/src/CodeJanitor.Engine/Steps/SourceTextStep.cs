using CodeJanitor.Engine.Contracts;
using CodeJanitor.Engine.Diagnostics;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;

namespace CodeJanitor.Engine.Steps;

/// <summary>
/// A Code Janitor step that rewrites the text of one document.
/// </summary>
public abstract class SourceTextStep : ICleanupStep
{
    public abstract string Name { get; }

    /// <summary>The settings key of the step, which is also its rule id.</summary>
    public abstract string? RuleId { get; }

    public abstract CleanupStage Stage { get; }

    public abstract int Order { get; }

    /// <summary>
    /// When true, a result that adds compiler errors to the document's project is rejected and the document is left
    /// unchanged.
    /// </summary>
    protected virtual bool RejectsNewCompilerErrors => false;

    public virtual bool IsEnabled(IEffectiveSettings settings) => RuleId is not null && settings.GetBool(RuleId);

    public async Task<Solution> ApplyAsync(Document document, IEffectiveSettings settings, CancellationToken cancellationToken)
    {
        var text = await document.GetTextAsync(cancellationToken).ConfigureAwait(false);
        var source = text.ToString();
        var result = await TransformAsync(source, document, settings, cancellationToken).ConfigureAwait(false);

        return await WithResultAsync(document, text, source, result, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// The solution with the <paramref name="text" /> of the document (<paramref name="source" /> as a string) replaced by
    /// <paramref name="result" />; the document's solution when the text is unchanged or, with
    /// <see cref="RejectsNewCompilerErrors" />, when the result adds compiler errors.
    /// </summary>
    protected async Task<Solution> WithResultAsync(Document document, SourceText text, string source, string result, CancellationToken cancellationToken)
    {
        if (string.Equals(result, source, StringComparison.Ordinal))
        {
            return document.Project.Solution;
        }

        var changed = document.WithText(SourceText.From(result, text.Encoding, text.ChecksumAlgorithm));
        if (RejectsNewCompilerErrors && await AddsCompilerErrorsAsync(document, changed, cancellationToken).ConfigureAwait(false))
        {
            return document.Project.Solution;
        }

        return changed.Project.Solution;
    }

    /// <summary>Transforms the text of the document.</summary>
    protected virtual Task<string> TransformAsync(string source, Document document, IEffectiveSettings settings, CancellationToken cancellationToken) =>
        Task.FromResult(Transform(source, document, settings));

    /// <summary>Transforms the text of the document.</summary>
    protected virtual string Transform(string source, Document document, IEffectiveSettings settings) => source;

    /// <summary>Whether <paramref name="after" /> has compiler errors in its project that <paramref name="before" /> had not.</summary>
    internal static async Task<bool> AddsCompilerErrorsAsync(Document before, Document after, CancellationToken cancellationToken)
    {
        var beforeErrors = await CompilerErrorsAsync(before, cancellationToken).ConfigureAwait(false);
        var afterErrors = await CompilerErrorsAsync(after, cancellationToken).ConfigureAwait(false);

        return CompilerErrorMatching.MatchByMessage(beforeErrors, afterErrors).New.Count > 0;
    }

    private static async Task<IEnumerable<Diagnostic>> CompilerErrorsAsync(Document document, CancellationToken cancellationToken)
    {
        var compilation = await document.Project.GetCompilationAsync(cancellationToken).ConfigureAwait(false);

        return compilation is null ? [] : compilation.GetDiagnostics(cancellationToken).Where(d => d.Severity == DiagnosticSeverity.Error);
    }
}
