using System.Text.Json;
using System.Text.Json.Nodes;
using CodeJanitor.Engine.Contracts;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;

namespace CodeJanitor.Engine.Queries;

/// <summary>
/// <c>branches</c>: the decision points of the member at a position, what Generate Tests to Target Coverage aims its
/// tests at (the Visual Studio extension's <c>RoslynCodeBranchAnalyzer</c> and <c>BranchCoverageEvaluator</c>).
/// Arguments: <c>{ line, character, testCode? }</c>, 0-based. Result:
/// <code>
/// { "target": { "name", "kind", "startLine", "endLine", "text", "signature" } | null,
///   "branches": [{ "id": string, "type": string, "description": string, "condition": string, "line": int }],
///   "coverage": { "totalBranches": int, "coveredBranches": int, "percentage": int, "covered": string[],
///                 "uncovered": string[], "scenarios": string[] } | null }
/// </code>
/// <c>target</c> is the <c>memberAtPosition</c> result, or outside every member the whole file (<c>kind</c>
/// <c>file</c>, the file name, an empty signature); null for an empty file. <c>type</c> is the camelCase
/// <see cref="CodeBranchType" />, <c>line</c> 0-based. <c>coverage</c>, with <c>testCode</c> only, gives the ids of
/// the branches the tests cover and the names of the test methods (see <see cref="BranchCoverage" />).
/// </summary>
public sealed class BranchesQuery : IDocumentQuery
{
    public string Name => "branches";

    public async Task<JsonNode?> QueryAsync(Document document, IEffectiveSettings settings, JsonObject? arguments, CancellationToken cancellationToken)
    {
        var root = await document.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false);
        var text = await document.GetTextAsync(cancellationToken).ConfigureAwait(false);
        if (root is null || string.IsNullOrWhiteSpace(text.ToString()))
        {
            return new JsonObject { ["target"] = null, ["branches"] = new JsonArray(), ["coverage"] = null };
        }

        var member = MemberAtPositionQuery.Find(root, PositionIn(text, arguments));
        var target = member is null
            ? new JsonObject
            {
                ["name"] = Path.GetFileName(document.FilePath ?? document.Name),
                ["kind"] = "file",
                ["startLine"] = 0,
                ["endLine"] = text.Lines.Count - 1,
                ["text"] = text.ToString(),
                ["signature"] = string.Empty,
            }
            : await new MemberAtPositionQuery().QueryAsync(document, settings, arguments, cancellationToken).ConfigureAwait(false);
        var branches = BranchesAnalyzer.Analyze((SyntaxNode?)member ?? root, target!["startLine"]!.GetValue<int>());

        return new JsonObject
        {
            ["target"] = target,
            ["branches"] = new JsonArray([.. branches.Select(branch => (JsonNode?)new JsonObject
            {
                ["id"] = branch.Id,
                ["type"] = JsonNamingPolicy.CamelCase.ConvertName(branch.Type.ToString()),
                ["description"] = branch.Description,
                ["condition"] = branch.Condition,
                ["line"] = branch.Line,
            })]),
            ["coverage"] = arguments?["testCode"] is JsonValue testCode ? Coverage(branches, testCode.GetValue<string>()) : null,
        };
    }

    /// <summary>The position of <c>{ line, character }</c>, as <c>memberAtPosition</c> reads it; -1 for a line beyond the file.</summary>
    private static int PositionIn(SourceText text, JsonObject? arguments)
    {
        var number = arguments?["line"]?.GetValue<int>() ?? 0;
        if (number < 0 || number >= text.Lines.Count)
        {
            return -1;
        }

        var line = text.Lines[number];

        return line.Start + Math.Clamp(arguments?["character"]?.GetValue<int>() ?? 0, 0, line.Span.Length);
    }

    private static JsonObject Coverage(IReadOnlyList<CodeBranch> branches, string testCode)
    {
        var evaluation = BranchCoverage.Evaluate(branches, testCode);

        return new JsonObject
        {
            ["totalBranches"] = branches.Count,
            ["coveredBranches"] = evaluation.Covered.Count,
            ["percentage"] = evaluation.Percentage,
            ["covered"] = QuerySyntax.Strings(evaluation.Covered.Select(branch => branch.Id)),
            ["uncovered"] = QuerySyntax.Strings(evaluation.Uncovered.Select(branch => branch.Id)),
            ["scenarios"] = QuerySyntax.Strings(evaluation.Scenarios),
        };
    }
}
