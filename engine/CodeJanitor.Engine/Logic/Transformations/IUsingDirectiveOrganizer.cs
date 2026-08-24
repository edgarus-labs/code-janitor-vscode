namespace CodeJanitor.Logic.Transformations;

/// <summary>
/// Sorts C# <c>using</c> directives in source text (see ADR-0007). This is the first purely
/// syntactic building block of the headless-Roslyn cleanup path (BL-018): it operates on raw
/// source text without opening a document in the IDE and without EnvDTE.
/// </summary>

public interface IUsingDirectiveOrganizer
{
    /// <summary>
    /// Sorts the <c>using</c> directives at the compilation-unit level and within each
    /// namespace: <c>System</c> namespaces first, then ordinal alphabetical, with regular
    /// usings before <c>using static</c> before alias usings.
    /// </summary>
    /// <remarks>
    /// This is intentionally conservative and formatting-preserving. A block of usings is left
    /// completely untouched when it contains comments, preprocessor directives (e.g.
    /// <c>#if</c>), or <c>global using</c> directives, so no trivia or conditional structure is
    /// ever lost. Unused-using removal is a semantic operation and is out of scope here.
    /// </remarks>
    /// <param name="source">The full C# source text.</param>
    /// <returns>The transformed source, or the original when nothing needs reordering.</returns>

    string Organize(string source);
}
