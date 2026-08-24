namespace CodeJanitor.Logic.Transformations;

/// <summary>
/// Applies C# field mutability rules to source text (see ADR-0007).
/// </summary>

public interface IFieldMutabilityConverter
{
    /// <summary>
    /// Adds the <c>readonly</c> modifier to fields that are provably never written outside of
    /// their declaring class's own constructor (or static constructor / initializer, for
    /// static fields). Fields that are not private, are already readonly/const/volatile, have
    /// multiple declarators, or belong to a partial type are left unchanged.
    /// </summary>
    /// <param name="source">The full C# source text.</param>
    /// <returns>The transformed source, or the original when nothing applies.</returns>

    string AddReadonlyWhenSafe(string source);
}
