using System.Globalization;
using Microsoft.CodeAnalysis;

namespace CodeJanitor.Engine.Diagnostics;

/// <summary>
/// Matches the compiler errors after a change with those before it by id, file path and message, counting duplicates:
/// an error of code that only moves keeps its message while its position shifts.
/// </summary>
internal static class CompilerErrorMatching
{
    /// <summary>
    /// Matches every error of <paramref name="after" /> with a remaining error of <paramref name="before" /> that has
    /// the same id, file path and message, counting duplicates: of such equal errors, the last remaining one is
    /// consumed.
    /// </summary>
    /// <param name="before">The errors before the change.</param>
    /// <param name="after">The errors after the change.</param>
    /// <returns>
    /// The errors of <paramref name="after" /> that matched none, in their order, and the errors of
    /// <paramref name="before" /> that none matched.
    /// </returns>
    internal static (List<Diagnostic> New, IEnumerable<Diagnostic> Remaining) MatchByMessage(IEnumerable<Diagnostic> before, IEnumerable<Diagnostic> after)
    {
        var remainingByMessage = before
            .GroupBy(GetMessageKey)
            .ToDictionary(group => group.Key, group => group.ToList());
        var unmatched = new List<Diagnostic>();

        foreach (var error in after)
        {
            if (remainingByMessage.TryGetValue(GetMessageKey(error), out var candidates) && candidates.Count > 0)
            {
                candidates.RemoveAt(candidates.Count - 1);
            }
            else
            {
                unmatched.Add(error);
            }
        }

        return (unmatched, remainingByMessage.Values.SelectMany(candidates => candidates));
    }

    private static (string Id, string? FilePath, string Message) GetMessageKey(Diagnostic diagnostic) =>
        (diagnostic.Id, diagnostic.Location.SourceTree?.FilePath, diagnostic.GetMessage(CultureInfo.InvariantCulture));
}
