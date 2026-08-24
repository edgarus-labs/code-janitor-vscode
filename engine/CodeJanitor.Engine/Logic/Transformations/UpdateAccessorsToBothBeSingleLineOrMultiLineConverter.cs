using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using CodeJanitor.Properties;

namespace CodeJanitor.Logic.Transformations;

/// <summary>
/// Updates property and event accessors to either both be single-line or both be multi-line,
/// ensuring consistency and readability.
/// </summary>

public sealed class UpdateAccessorsToBothBeSingleLineOrMultiLineConverter : ISourceTransformation
{
    /// <summary>
    /// Gets the name.
    /// </summary>
    public string Name => "Update accessors to both be single line or multi-line";

    /// <summary>
    /// Parses the input C# source with Roslyn and, if the source is non-empty and the cleaning setting is enabled, applies AccessorFormatRewriter to normalize accessor formatting, returning the rewritten source; otherwise, it returns the original input unchanged with no side effects.
    /// </summary>
    /// <param name="source">The source.</param>
    /// <returns>A string value produced by this method.</returns>

    public string Apply(string source)
    {
        if (string.IsNullOrEmpty(source) || !Settings.Default.Cleaning_UpdateAccessorsToBothBeSingleLineOrMultiLine)
        {
            return source;
        }

        var tree = CSharpSyntaxTree.ParseText(source);
        var root = tree.GetRoot();
        var rewriter = new AccessorFormatRewriter();
        var newRoot = rewriter.Visit(root);

        return newRoot.ToFullString();
    }

    /// <summary>
    /// A syntax rewriter that standardizes and formats the accessor blocks of property and event declarations to ensure consistent single-line or multi-line presentation.
    /// </summary>
    private sealed class AccessorFormatRewriter : CSharpSyntaxRewriter
    {
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

            // Make both accessors the same format
            // Choose to make them both multi-line (preserves code style)
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
        /// We need to analyze the method. It checks if an accessor is single-line. If body null (expression-bodied) returns true. Else splits body text by newline and returns true if lines length &lt;=2. That means body with braces on separate lines but no content (or content on same line?) Actually split by &apos;\n&apos;, if body has opening and closing brace on separate lines, the string would be &quot;{\n}&quot; giving two lines after split: &quot;{&quot; and &quot;}&quot;? Let&apos;s see: &quot;{\n}&quot;.Split(&apos;\n&apos;) gives [&quot;{&quot;, &quot;}&quot;] length 2, so returns true. So it treats a body spanning exactly two lines (opening and closing brace) as single-line. Also if body has content on same line as braces maybe length 1. Side effects: none, just uses ToFullString which includes trivia? ToFullString returns full string including leading/trailing trivia? Actually for a node, ToFullString includes all trivia. Split by &apos;\n&apos; counts lines. Potential issue: if there are many lines but only two newline characters? Actually split includes trailing empty string if string ends with newline. For &quot;{\r\n}&quot; split on &apos;\n&apos; gives [&quot;{\r&quot;, &quot;}&quot;] length.
        /// </summary>
        /// <param name="accessor">The accessor.</param>
        /// <returns>A bool value produced by this method.</returns>

        private bool IsSingleLine(AccessorDeclarationSyntax accessor)
        {
            if (accessor.Body is null)
                return true; // Expression-bodied accessors are considered single-line

            // Check if body spans only 2 lines (opening and closing brace)
            var bodyText = accessor.Body.ToFullString();
            var lines = bodyText.Split('\n');

            return lines.Length <= 2;
        }

        /// <summary>
        /// Formats an accessor&apos;s body by expanding it to a multi-line layout when makeMultiLine is true, or compressing it to a single line only when it has exactly one statement, otherwise returning the original syntax node with fallback to the original body on parse failure and no thrown exceptions.
        /// </summary>
        /// <param name="accessor">The accessor.</param>
        /// <param name="makeMultiLine">The make multi line.</param>
        /// <returns>A AccessorDeclarationSyntax value produced by this method.</returns>

        private AccessorDeclarationSyntax FormatAccessor(AccessorDeclarationSyntax accessor, bool makeMultiLine)
        {
            if (accessor.Body is null)
                return accessor;

            if (makeMultiLine)
            {
                // Expand to multi-line format
                var newline = "\r\n";
                var bodyStatements = new System.Collections.Generic.List<string> { "{" };

                foreach (var statement in accessor.Body.Statements)
                {
                    bodyStatements.Add("    " + statement.ToString().Trim());
                }

                bodyStatements.Add("}");
                var formattedBody = string.Join(newline, bodyStatements);

                var newBodySyntax = SyntaxFactory.ParseStatement(formattedBody) as BlockSyntax;

                return accessor.WithBody(newBodySyntax ?? accessor.Body);
            }
            else
            {
                // Compress to single-line format
                var statements = accessor.Body.Statements;
                if (statements.Count != 1)
                    return accessor;

                var statement = statements[0];
                var statementText = statement.ToString().Trim();

                // Create single-line body: { statement; } or similar
                var singleLineBody = $"{{ {statementText} }}";
                try
                {
                    var newBodySyntax = SyntaxFactory.ParseStatement(singleLineBody) as BlockSyntax;

                    return accessor.WithBody(newBodySyntax ?? accessor.Body);
                }
                catch
                {
                    return accessor;
                }
            }
        }
    }
}
