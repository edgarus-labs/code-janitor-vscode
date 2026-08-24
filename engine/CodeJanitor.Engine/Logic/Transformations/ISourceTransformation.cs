namespace CodeJanitor.Logic.Transformations;

/// <summary>
/// A single composable, DTE-independent source-text transformation - a "block" in the headless
/// cleanup pipeline (BL-018). Each block takes C# source text and returns transformed source,
/// returning its input unchanged when it does not apply. Blocks are pure and unit-testable
/// without Visual Studio, so any subset of them can be composed in any order (see
/// <see cref="SourceTransformationPipeline" />).
/// </summary>

public interface ISourceTransformation
{
    /// <summary>
    /// Gets a short, human-readable name of the transformation (used for logging/diagnostics).
    /// </summary>
    string Name { get; }

    /// <summary>
    /// Applies the transformation to <paramref name="source" /> and returns the result, or the
    /// original text unchanged when the transformation does not apply.
    /// </summary>

    string Apply(string source);
}
