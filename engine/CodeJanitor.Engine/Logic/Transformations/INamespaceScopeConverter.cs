namespace CodeJanitor.Logic.Transformations;

/// <summary>
/// Converts C# namespace declarations between block-scoped and file-scoped forms.
/// </summary>

public interface INamespaceScopeConverter
{
    /// <summary>
    /// Converts a single top-level block-scoped namespace to a file-scoped namespace.
    /// </summary>
    /// <param name="source">The full C# source text.</param>
    /// <returns>
    /// The converted source, or the original source unchanged when conversion is not
    /// applicable (no namespace, multiple namespaces, nested namespaces, or already file-scoped).
    /// </returns>

    string ConvertToFileScoped(string source);

    /// <summary>
    /// Determines whether the specified source contains more than one namespace declaration
    /// (multiple top-level namespaces, and/or a namespace nested inside another), which makes
    /// conversion to a file-scoped namespace inapplicable.
    /// </summary>
    /// <param name="source">The full C# source text.</param>
    /// <returns>True if the source contains more than one namespace declaration.</returns>

    bool HasMultipleNamespaces(string source);
}
