namespace CodeJanitor.Logic.Transformations;

/// <summary>
/// Applies C# type-style rules to source text.
/// </summary>

public interface ITypeStyleConverter
{
    /// <summary>
    /// Replaces the explicit type of local variable declarations with <c>var</c> only when the
    /// right-hand side explicitly indicates the type (object creation, cast, array creation) and
    /// the declared type textually matches. Method invocations and literals are left unchanged.
    /// </summary>
    /// <param name="source">The full C# source text.</param>
    /// <returns>The transformed source, or the original when nothing applies.</returns>

    string UseVarWhenApparent(string source);
}
