#nullable disable
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace CodeJanitor.Engine.Steps.Transformations;

/// <summary>
/// Spreads single-line method declarations onto multiple lines by placing the opening brace
/// on a new line, method body content on separate lines, and closing brace on its own line.
/// </summary>
/// <remarks>
/// Only trivia is rewritten: comments are kept and the line break is the one ending the opening
/// brace's line (or the first one of the file), so the file's line endings are preserved. The
/// indentation follows the declaration's first line when the brace is on the header line, and the
/// brace's own line otherwise (one extra tab or four spaces for the statements).
/// </remarks>
internal sealed class UpdateSingleLineMethodsConverter : ISourceTransformation
{
    private readonly Func<string, bool> _isEnabled;

    /// <summary>
    /// Initializes a new instance of the <see cref="UpdateSingleLineMethodsConverter" /> class.
    /// </summary>
    /// <param name="isEnabled">The effective cleanup settings of the file, which decide whether single-line methods are updated.</param>
    internal UpdateSingleLineMethodsConverter(Func<string, bool> isEnabled)
    {
        _isEnabled = isEnabled;
    }

    /// <summary>
    /// Gets the name.
    /// </summary>
    public string Name => "Update single-line methods";

    /// <summary>
    /// Returns the original source unchanged if it is null/empty or the effective setting is disabled, otherwise parses the source as a C# syntax tree, applies SingleLineMethodRewriter to rewrite single-line methods, and returns the resulting full string.
    /// </summary>
    /// <param name="source">The source.</param>
    /// <returns>A string value produced by this method.</returns>
    public string Apply(string source)
    {
        if (string.IsNullOrEmpty(source) || !_isEnabled("updateSingleLineMethods"))
        {
            return source;
        }

        var tree = CSharpSyntaxTree.ParseText(source);
        var root = tree.GetRoot();
        var rewriter = new SingleLineMethodRewriter(tree.GetText());
        var newRoot = rewriter.Visit(root);

        return newRoot.ToFullString();
    }

    /// <summary>
    /// A rewriter that processes single-line method declarations and reformats them across multiple lines.
    /// </summary>
    private sealed class SingleLineMethodRewriter : CSharpSyntaxRewriter
    {
        private readonly SourceText _text;

        /// <summary>
        /// Initializes a rewriter for the given source text, which supplies indentation and line breaks.
        /// </summary>
        public SingleLineMethodRewriter(SourceText text)
        {
            _text = text;
        }

        /// <summary>
        /// Visits a method declaration and, if it has a non-abstract single-line body, rewrites it across multiple lines, otherwise returns the visited node unchanged.
        /// </summary>
        /// <param name="node">The node.</param>
        /// <returns>A SyntaxNode value produced by this method.</returns>
        public override SyntaxNode VisitMethodDeclaration(MethodDeclarationSyntax node)
        {
            // First visit children
            var visited = (MethodDeclarationSyntax)base.VisitMethodDeclaration(node);

            // Don't process abstract methods or methods in interfaces
            if (visited.Body is null || visited.Modifiers.Any(SyntaxKind.AbstractKeyword))
            {
                return visited;
            }

            // Check if it's a single-line method (return statement or throw)
            if (!IsSingleLineMethodBody(node.Body))
            {
                return visited;
            }

            // Spread it onto multiple lines; positions are taken from the original node.

            return SpreadMethodOntoMultipleLines(visited, node.Body.OpenBraceToken.SpanStart, node.SpanStart);
        }

        /// <summary>
        /// Returns true when the body has at least one statement and its braces are on the same line
        /// of the original source.
        /// </summary>
        /// <param name="body">The body, from the original tree.</param>
        /// <returns>A bool value produced by this method.</returns>
        private bool IsSingleLineMethodBody(BlockSyntax body) => body.Statements.Count > 0
                && _text.Lines.GetLineFromPosition(body.OpenBraceToken.SpanStart).LineNumber
                    == _text.Lines.GetLineFromPosition(body.CloseBraceToken.SpanStart).LineNumber;

        /// <summary>
        /// Puts the opening brace, every statement and the closing brace of the method body on their
        /// own lines by rewriting only the whitespace trivia between them, so comments and the trivia
        /// after the closing brace are kept.
        /// </summary>
        /// <param name="method">The method.</param>
        /// <param name="openBracePosition">The position of the opening brace in the original source.</param>
        /// <param name="declarationPosition">The position of the declaration's first token in the original source.</param>
        /// <returns>A MethodDeclarationSyntax value produced by this method.</returns>
        private MethodDeclarationSyntax SpreadMethodOntoMultipleLines(MethodDeclarationSyntax method, int openBracePosition, int declarationPosition)
        {
            var line = _text.Lines.GetLineFromPosition(openBracePosition);
            var newline = SyntaxFactory.EndOfLine(GetLineBreak(line));
            var body = method.Body;
            var openBrace = body.OpenBraceToken;
            var previous = openBrace.GetPreviousToken();
            var braceIsOnHeaderLine = !previous.TrailingTrivia.Any(SyntaxKind.EndOfLineTrivia)
                && !openBrace.LeadingTrivia.Any(SyntaxKind.EndOfLineTrivia);

            // A brace on the header line may follow wrapped parameters or a where clause, whose
            // continuation indentation must not be used for the body.
            var indentText = GetIndentation(braceIsOnHeaderLine ? _text.Lines.GetLineFromPosition(declarationPosition) : line);
            var indent = SyntaxFactory.Whitespace(indentText);
            var statementIndent = SyntaxFactory.Whitespace(indentText + (indentText.Length > 0 && indentText[0] == '\t' ? "\t" : "    "));

            if (braceIsOnHeaderLine)
            {
                openBrace = openBrace.WithLeadingTrivia(openBrace.LeadingTrivia.Insert(0, indent));
            }

            var statements = body.Statements.Select(statement => statement
                .WithLeadingTrivia(statement.GetLeadingTrivia().Insert(0, statementIndent))
                .WithTrailingTrivia(TrimEnd(statement.GetTrailingTrivia()).Add(newline)));

            var newBody = body
                .WithOpenBraceToken(openBrace.WithTrailingTrivia(TrimEnd(openBrace.TrailingTrivia).Add(newline)))
                .WithStatements(SyntaxFactory.List(statements))
                .WithCloseBraceToken(body.CloseBraceToken.WithLeadingTrivia(body.CloseBraceToken.LeadingTrivia.Insert(0, indent)));

            if (braceIsOnHeaderLine)
            {
                method = method.ReplaceToken(previous, previous.WithTrailingTrivia(TrimEnd(previous.TrailingTrivia).Add(newline)));
            }

            return method.WithBody(newBody);
        }

        /// <summary>
        /// Returns the line break ending <paramref name="line" />, or the first line break of the
        /// file when the line has none, or <c>\n</c> for a file without line breaks.
        /// </summary>
        private string GetLineBreak(TextLine line)
        {
            if (line.EndIncludingLineBreak > line.End)
            {
                return _text.ToString(TextSpan.FromBounds(line.End, line.EndIncludingLineBreak));
            }

            foreach (var other in _text.Lines)
            {
                if (other.EndIncludingLineBreak > other.End)
                {
                    return _text.ToString(TextSpan.FromBounds(other.End, other.EndIncludingLineBreak));
                }
            }

            return "\n";
        }

        /// <summary>
        /// Returns the leading spaces and tabs of <paramref name="line" />.
        /// </summary>
        private string GetIndentation(TextLine line)
        {
            int end = line.Start;
            while (end < line.End && (_text[end] == ' ' || _text[end] == '\t'))
            {
                end++;
            }

            return _text.ToString(TextSpan.FromBounds(line.Start, end));
        }

        /// <summary>
        /// Removes the whitespace trivia at the end of <paramref name="trivia" />.
        /// </summary>
        private static SyntaxTriviaList TrimEnd(SyntaxTriviaList trivia)
        {
            while (trivia.Count > 0 && trivia[trivia.Count - 1].IsKind(SyntaxKind.WhitespaceTrivia))
            {
                trivia = trivia.RemoveAt(trivia.Count - 1);
            }

            return trivia;
        }
    }
}
