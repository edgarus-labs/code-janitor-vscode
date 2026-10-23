#nullable disable
namespace CodeJanitor.Engine.Steps.Transformations;

/// <summary>
/// A single composable source-text transformation. It takes C# source text and returns the transformed source,
/// returning its input unchanged when it does not apply. Transformations are pure and unit-testable, so any subset
/// of them can be composed in any order.
/// </summary>
internal interface ISourceTransformation
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
