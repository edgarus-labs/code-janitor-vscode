#nullable disable
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace CodeJanitor.Engine.Steps.Transformations;

/// <summary>
/// Updates property and event accessors to either both be single-line or both be multi-line,
/// ensuring consistency and readability.
/// </summary>
/// <remarks>
/// Only trivia is rewritten. Expanding follows the indentation of the accessor's line (one extra
/// tab or four spaces for the statements) and uses the line break ending that line (or the first
/// one of the file). Compressing is skipped when the body holds comments or directives, or its
/// statement spans several lines, because a single line cannot keep that layout.
/// </remarks>
internal sealed class UpdateAccessorsToBothBeSingleLineOrMultiLineConverter : ISourceTransformation
{
    private readonly Func<string, bool> _isEnabled;

    /// <summary>
    /// Initializes a new instance of the <see cref="UpdateAccessorsToBothBeSingleLineOrMultiLineConverter" /> class.
    /// </summary>
    /// <param name="isEnabled">The effective cleanup settings of the file, which decide whether accessors are updated.</param>
    internal UpdateAccessorsToBothBeSingleLineOrMultiLineConverter(Func<string, bool> isEnabled)
    {
        _isEnabled = isEnabled;
    }

    /// <summary>
    /// Gets the name.
    /// </summary>
    public string Name => "Update accessors to both be single line or multi-line";

    /// <summary>
    /// Parses the input C# source with Roslyn and, if the source is non-empty and the effective cleaning setting is enabled, applies AccessorFormatRewriter to normalize accessor formatting, returning the rewritten source; otherwise, it returns the original input unchanged with no side effects.
    /// </summary>
    /// <param name="source">The source.</param>
    /// <returns>A string value produced by this method.</returns>
    public string Apply(string source)
    {
        if (string.IsNullOrEmpty(source) || !_isEnabled("updateAccessorsToBothBeSingleLineOrMultiLine"))
        {
            return source;
        }

        var tree = CSharpSyntaxTree.ParseText(source);
        var root = tree.GetRoot();
        var rewriter = new AccessorFormatRewriter(tree.GetText());
        var newRoot = rewriter.Visit(root);

        return newRoot.ToFullString();
    }

    /// <summary>
    /// A syntax rewriter that standardizes and formats the accessor blocks of property and event declarations to ensure consistent single-line or multi-line presentation.
    /// </summary>
    private sealed class AccessorFormatRewriter : CSharpSyntaxRewriter
    {
        private readonly SourceText _text;

        /// <summary>
        /// Initializes a rewriter for the given source text, which supplies indentation and line breaks.
        /// </summary>
        public AccessorFormatRewriter(SourceText text)
        {
            _text = text;
        }

        /// <summary>
        /// Overrides property declaration visiting to normalize accessor formatting only for properties with at least two body-bearing accessors, otherwise returning the visited node unchanged.
        /// </summary>
        /// <param name="node">The node.</param>
        /// <returns>A SyntaxNode value produced by this method.</returns>
        public override SyntaxNode VisitPropertyDeclaration(PropertyDeclarationSyntax node)
        {
            // First visit children
            var visited = (PropertyDeclarationSyntax)base.VisitPropertyDeclaration(node);

            if (visited.AccessorList is null || visited.AccessorList.Accessors.Count < 2)
            {
                return visited;
            }

            // Get first two accessors (get/set or set/get)
            var first = visited.AccessorList.Accessors[0];
            var second = visited.AccessorList.Accessors[1];

            // Check if they have bodies (can't format property shorthand or abstract properties)
            if (first.Body is null || second.Body is null)
            {
                return visited;
            }

            return UpdateAccessorConsistency(visited, first, second);
        }

        /// <summary>
        /// This method visits an event declaration, returns it unchanged if it lacks at least two accessors with bodies, otherwise transforms it via UpdateEventAccessorConsistency to enforce accessor consistency, with no side effects or exceptions.
        /// </summary>
        /// <param name="node">The node.</param>
        /// <returns>A SyntaxNode value produced by this method.</returns>
        public override SyntaxNode VisitEventDeclaration(EventDeclarationSyntax node)
        {
            // First visit children
            var visited = (EventDeclarationSyntax)base.VisitEventDeclaration(node);

            if (visited.AccessorList is null || visited.AccessorList.Accessors.Count < 2)
            {
                return visited;
            }

            // Get first two accessors (add/remove)
            var first = visited.AccessorList.Accessors[0];
            var second = visited.AccessorList.Accessors[1];

            // Check if they have bodies
            if (first.Body is null || second.Body is null)
            {
                return visited;
            }

            return UpdateEventAccessorConsistency(visited, first, second);
        }

        /// <summary>
        /// If the two accessors have inconsistent single- or multi-line formatting, this method returns a new PropertyDeclarationSyntax with every accessor reformatted to match.
        /// </summary>
        /// <param name="prop">The prop.</param>
        /// <param name="first">The first.</param>
        /// <param name="second">The second.</param>
        /// <returns>A PropertyDeclarationSyntax value produced by this method.</returns>
        private PropertyDeclarationSyntax UpdateAccessorConsistency(PropertyDeclarationSyntax prop, AccessorDeclarationSyntax first, AccessorDeclarationSyntax second)
        {
            bool isFirstSingleLine = IsSingleLine(first);
            bool isSecondSingleLine = IsSingleLine(second);

            // If they're already consistent, no change needed
            if (isFirstSingleLine == isSecondSingleLine)
            {
                return prop;
            }

            // Make every accessor match the format of the first one
            var newAccessors = new SyntaxList<AccessorDeclarationSyntax>();

            foreach (var accessor in prop.AccessorList.Accessors)
            {
                if (isFirstSingleLine != IsSingleLine(accessor))
                {
                    // This accessor needs to be reformatted
                    newAccessors = newAccessors.Add(FormatAccessor(accessor, !isFirstSingleLine));
                }
                else
                {
                    newAccessors = newAccessors.Add(accessor);
                }
            }

            var newAccessorList = prop.AccessorList.WithAccessors(newAccessors);

            return prop.WithAccessorList(newAccessorList);
        }

        /// <summary>
        /// Updates the event declaration&apos;s accessors to match the first accessor&apos;s line format (single-line or multi-line), returning the original node if already consistent or a new node with reformatted accessors otherwise, without mutating the input.
        /// </summary>
        /// <param name="evt">The evt.</param>
        /// <param name="first">The first.</param>
        /// <param name="second">The second.</param>
        /// <returns>A EventDeclarationSyntax value produced by this method.</returns>
        private EventDeclarationSyntax UpdateEventAccessorConsistency(EventDeclarationSyntax evt, AccessorDeclarationSyntax first, AccessorDeclarationSyntax second)
        {
            bool isFirstSingleLine = IsSingleLine(first);
            bool isSecondSingleLine = IsSingleLine(second);

            // If they're already consistent, no change needed
            if (isFirstSingleLine == isSecondSingleLine)
            {
                return evt;
            }

            // Make both accessors the same format
            var newAccessors = new SyntaxList<AccessorDeclarationSyntax>();

            foreach (var accessor in evt.AccessorList.Accessors)
            {
                if (isFirstSingleLine != IsSingleLine(accessor))
                {
                    // This accessor needs to be reformatted
                    newAccessors = newAccessors.Add(FormatAccessor(accessor, !isFirstSingleLine));
                }
                else
                {
                    newAccessors = newAccessors.Add(accessor);
                }
            }

            var newAccessorList = evt.AccessorList.WithAccessors(newAccessors);

            return evt.WithAccessorList(newAccessorList);
        }

        /// <summary>
        /// Determines whether the accessor counts as single-line: it has no block body, or the full text of its body,
        /// trivia included, holds at most one line feed (such as the one ending the closing brace's line).
        /// </summary>
        /// <param name="accessor">The accessor.</param>
        /// <returns><see langword="true" /> when the accessor counts as single-line.</returns>
        private bool IsSingleLine(AccessorDeclarationSyntax accessor)
        {
            if (accessor.Body is null)
            {
                return true; // Expression-bodied accessors are considered single-line
            }

            // At most one line feed in the body's text, trivia included
            var bodyText = accessor.Body.ToFullString();
            var lines = bodyText.Split('\n');

            return lines.Length <= 2;
        }

        /// <summary>
        /// Expands the accessor body to a multi-line layout when makeMultiLine is true, otherwise compresses it to a single line when that is safe; accessors without a block body are returned unchanged.
        /// </summary>
        /// <param name="accessor">The accessor.</param>
        /// <param name="makeMultiLine">The make multi line.</param>
        /// <returns>A AccessorDeclarationSyntax value produced by this method.</returns>
        private AccessorDeclarationSyntax FormatAccessor(AccessorDeclarationSyntax accessor, bool makeMultiLine)
        {
            if (accessor.Body is null)
            {
                return accessor;
            }

            return makeMultiLine ? Expand(accessor) : Compress(accessor);
        }

        /// <summary>
        /// Puts the opening brace, every statement and the closing brace of the accessor body on their
        /// own lines by rewriting only the whitespace trivia between them.
        /// </summary>
        private AccessorDeclarationSyntax Expand(AccessorDeclarationSyntax accessor)
        {
            var body = accessor.Body;
            var line = _text.Lines.GetLineFromPosition(body.OpenBraceToken.SpanStart);
            var newline = SyntaxFactory.EndOfLine(GetLineBreak(line));
            var indentText = GetIndentation(line);
            var indent = SyntaxFactory.Whitespace(indentText);
            var statementIndent = SyntaxFactory.Whitespace(indentText + (indentText.Length > 0 && indentText[0] == '\t' ? "\t" : "    "));

            var openBrace = body.OpenBraceToken;
            var previous = openBrace.GetPreviousToken();
            var braceIsOnHeaderLine = !previous.TrailingTrivia.Any(SyntaxKind.EndOfLineTrivia)
                && !openBrace.LeadingTrivia.Any(SyntaxKind.EndOfLineTrivia);

            if (braceIsOnHeaderLine)
            {
                openBrace = openBrace.WithLeadingTrivia(openBrace.LeadingTrivia.Insert(0, indent));
            }

            var statements = body.Statements.Select(statement => statement
                .WithLeadingTrivia(TrimStart(statement.GetLeadingTrivia()).Insert(0, statementIndent))
                .WithTrailingTrivia(EndWithLineBreak(statement.GetTrailingTrivia(), newline)));

            var newBody = body
                .WithOpenBraceToken(openBrace.WithTrailingTrivia(EndWithLineBreak(openBrace.TrailingTrivia, newline)))
                .WithStatements(SyntaxFactory.List(statements))
                .WithCloseBraceToken(body.CloseBraceToken.WithLeadingTrivia(TrimStart(body.CloseBraceToken.LeadingTrivia).Insert(0, indent)));

            if (braceIsOnHeaderLine)
            {
                accessor = accessor.ReplaceToken(previous, previous.WithTrailingTrivia(TrimEnd(previous.TrailingTrivia).Add(newline)));
            }

            return accessor.WithBody(newBody);
        }

        /// <summary>
        /// Puts an accessor with a single one-line statement on one line (<c>set { statement; }</c>)
        /// by replacing the whitespace and line breaks between its tokens with single spaces; leaves
        /// it unchanged when that would lose comments, directives or the statement's own layout.
        /// </summary>
        private static AccessorDeclarationSyntax Compress(AccessorDeclarationSyntax accessor)
        {
            var body = accessor.Body;
            if (body.Statements.Count != 1)
            {
                return accessor;
            }

            var statement = body.Statements[0];
            var previous = body.OpenBraceToken.GetPreviousToken();
            var layoutTrivia = previous.TrailingTrivia
                .Concat(body.OpenBraceToken.LeadingTrivia)
                .Concat(body.OpenBraceToken.TrailingTrivia)
                .Concat(statement.DescendantTrivia(descendIntoTrivia: true))
                .Concat(body.CloseBraceToken.LeadingTrivia);

            if (layoutTrivia.Any(t => !t.IsKind(SyntaxKind.WhitespaceTrivia) && !t.IsKind(SyntaxKind.EndOfLineTrivia))
                || statement.ToString().IndexOfAny(new[] { '\r', '\n' }) >= 0)
            {
                return accessor;
            }

            var space = SyntaxFactory.TriviaList(SyntaxFactory.Space);
            var newBody = body
                .WithOpenBraceToken(body.OpenBraceToken.WithLeadingTrivia().WithTrailingTrivia(space))
                .WithStatements(SyntaxFactory.SingletonList(statement.WithLeadingTrivia().WithTrailingTrivia(space)))
                .WithCloseBraceToken(body.CloseBraceToken.WithLeadingTrivia());

            return accessor
                .ReplaceToken(previous, previous.WithTrailingTrivia(space))
                .WithBody(newBody);
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

        /// <summary>
        /// Removes the whitespace trivia at the start of <paramref name="trivia" />, the indentation that
        /// the expanded layout replaces.
        /// </summary>
        private static SyntaxTriviaList TrimStart(SyntaxTriviaList trivia)
        {
            while (trivia.Count > 0 && trivia[0].IsKind(SyntaxKind.WhitespaceTrivia))
            {
                trivia = trivia.RemoveAt(0);
            }

            return trivia;
        }

        /// <summary>
        /// Removes the trailing whitespace of <paramref name="trivia" /> and ends it with one line break,
        /// adding <paramref name="lineBreak" /> only when the trivia does not end its line already.
        /// </summary>
        private static SyntaxTriviaList EndWithLineBreak(SyntaxTriviaList trivia, SyntaxTrivia lineBreak)
        {
            trivia = TrimEnd(trivia);

            return trivia.Count > 0 && trivia[trivia.Count - 1].IsKind(SyntaxKind.EndOfLineTrivia) ? trivia : trivia.Add(lineBreak);
        }
    }
}
