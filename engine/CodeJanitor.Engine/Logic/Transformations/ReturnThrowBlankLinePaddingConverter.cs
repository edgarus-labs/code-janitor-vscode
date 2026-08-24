using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using System;
using System.Collections.Generic;
using System.Linq;

namespace CodeJanitor.Logic.Transformations;

/// <summary>
/// Inserts a blank line before a <c>return</c> or <c>throw</c> statement when it is preceded
/// by at least one other statement within the same block (i.e. the block contains more
/// instructions than just this return/throw), visually separating the exit/failure path from
/// the preceding logic. Idempotent - does nothing when a blank line already precedes it, or
/// when the return/throw is the first (or only) statement in its block.
/// </summary>
/// <remarks>
/// This is a pure text transformation with no dependency on Visual Studio / EnvDTE,
/// which keeps it unit-testable in isolation (see ADR-0005 / ADR-0006).
/// </remarks>

public sealed class ReturnThrowBlankLinePaddingConverter : ISourceTransformation
{
    /// <inheritdoc />
    public string Name => "Blank Line Before Return/Throw";

    /// <inheritdoc />

    public string Apply(string source)
    {
        if (string.IsNullOrEmpty(source))
        {
            return source;
        }

        var tree = CSharpSyntaxTree.ParseText(source);
        var root = tree.GetRoot();

        var newline = source.Contains("\r\n") ? "\r\n" : "\n";
        var lines = source.Split(new[] { newline }, StringSplitOptions.None).ToList();

        var candidateLineIndexes = new SortedSet<int>();

        foreach (var statement in root.DescendantNodes().OfType<StatementSyntax>())
        {
            if (!(statement is ReturnStatementSyntax) && !(statement is ThrowStatementSyntax))
            {
                continue;
            }

            if (!(statement.Parent is BlockSyntax block))
            {
                continue;
            }

            var index = block.Statements.IndexOf(statement);
            if (index <= 0)
            {
                // Either the only statement in the block, or the first one - there is
                // nothing preceding it to separate it from.
                continue;
            }

            var lineIndex = tree.GetLineSpan(statement.Span).StartLinePosition.Line;
            candidateLineIndexes.Add(lineIndex);
        }

        if (candidateLineIndexes.Count == 0)
        {
            return source;
        }

        // Insert from the bottom of the file upward so earlier line indexes stay valid.
        foreach (var lineIndex in candidateLineIndexes.OrderByDescending(i => i))
        {
            if (lineIndex <= 0 || lineIndex > lines.Count - 1)
            {
                continue;
            }

            var previousLine = lines[lineIndex - 1];
            if (string.IsNullOrWhiteSpace(previousLine))
            {
                // Already has a blank line before it.
                continue;
            }

            lines.Insert(lineIndex, string.Empty);
        }

        return string.Join(newline, lines);
    }
}
