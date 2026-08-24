namespace CodeJanitor.Logic.Transformations;

/// <summary>
/// Applies C# class-sealing rules to source text (see ADR-0007).
/// </summary>

public interface IClassSealingConverter
{
    /// <summary>
    /// Adds the <c>sealed</c> modifier to top-level classes that are provably safe to seal
    /// from a single syntax tree: not public/protected, not already
    /// sealed/abstract/static/partial, and not derived from by any other type declared in the
    /// same file.
    /// </summary>
    /// <param name="source">The full C# source text.</param>
    /// <returns>The transformed source, or the original when nothing applies.</returns>

    string SealWhenSafe(string source);
}
