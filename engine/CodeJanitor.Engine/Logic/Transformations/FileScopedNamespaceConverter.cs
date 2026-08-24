using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;

namespace CodeJanitor.Logic.Transformations;

/// <summary>
/// Converts a single top-level block-scoped namespace to a file-scoped namespace.
/// Uses Roslyn to safely detect applicability (ignoring comments and strings) and to
/// locate the namespace braces precisely, then dedents the body by one indentation level.
/// </summary>
/// <remarks>
/// This is a pure text transformation with no dependency on Visual Studio / EnvDTE,
/// which keeps it unit-testable in isolation (see ADR-0005 / ADR-0006).
/// </remarks>

public sealed class FileScopedNamespaceConverter : INamespaceScopeConverter, ISourceTransformation
{
    /// <inheritdoc />
    public string Name => "File-Scoped Namespace";

    /// <inheritdoc />

    public string Apply(string source) => ConvertToFileScoped(source);

    /// <inheritdoc />

    public string ConvertToFileScoped(string source)
    {
        if (string.IsNullOrEmpty(source))
        {
            return source;
        }

        var tree = CSharpSyntaxTree.ParseText(source);
        if (!(tree.GetRoot() is CompilationUnitSyntax root))
        {
            return source;
        }

        var blockNamespaces = root.DescendantNodes().OfType<NamespaceDeclarationSyntax>().ToList();
        var fileScopedNamespaces = root.DescendantNodes().OfType<FileScopedNamespaceDeclarationSyntax>().ToList();

        // Only applicable when there is exactly one block namespace, it is top-level (not
        // nested), and there is no existing file-scoped namespace in the file.
        if (fileScopedNamespaces.Count > 0 || blockNamespaces.Count != 1)
        {
            return source;
        }

        var ns = blockNamespaces[0];
        if (!(ns.Parent is CompilationUnitSyntax))
        {
            return source;
        }

        if (ns.Usings.Count > 0)
        {
            var movedSource = new MoveUsingsOutsideNamespaceConverter().MoveUsingsOutside(source);
            if (movedSource != source)
            {
                source = movedSource;
                tree = CSharpSyntaxTree.ParseText(source);
                if (!(tree.GetRoot() is CompilationUnitSyntax newRoot))
                {
                    return source;
                }

                root = newRoot;
                blockNamespaces = root.DescendantNodes().OfType<NamespaceDeclarationSyntax>().ToList();
                if (blockNamespaces.Count != 1)
                {
                    return source;
                }

                ns = blockNamespaces[0];
            }
        }

        var openBrace = ns.OpenBraceToken;
        var closeBrace = ns.CloseBraceToken;
        if (openBrace.IsMissing || closeBrace.IsMissing)
        {
            return source;
        }

        var name = ns.Name.ToString();

        // Everything before the 'namespace' keyword (file header, outer usings, leading trivia).
        var header = source.Substring(0, ns.NamespaceKeyword.SpanStart);

        // The text strictly between the namespace braces.
        var bodyStart = openBrace.Span.End;
        var bodyEnd = closeBrace.Span.Start;
        var body = source.Substring(bodyStart, bodyEnd - bodyStart);

        var newline = body.Contains("\r\n") ? "\r\n" : "\n";
        var dedentedBody = Dedent(body, newline);

        var builder = new StringBuilder();
        builder.Append(header);
        builder.Append("namespace ").Append(name).Append(";");
        if (!string.IsNullOrWhiteSpace(dedentedBody))
        {
            builder.Append(newline).Append(newline);
            builder.Append(dedentedBody);
        }

        builder.Append(newline);

        return builder.ToString();
    }

    /// <inheritdoc />

    public bool HasMultipleNamespaces(string source)
    {
        if (string.IsNullOrEmpty(source))
        {
            return false;
        }

        var tree = CSharpSyntaxTree.ParseText(source);
        if (!(tree.GetRoot() is CompilationUnitSyntax root))
        {
            return false;
        }

        var namespaceCount = root.DescendantNodes().OfType<NamespaceDeclarationSyntax>().Count()
            + root.DescendantNodes().OfType<FileScopedNamespaceDeclarationSyntax>().Count();

        return namespaceCount > 1;
    }

    /// <summary>
    /// Removes one indentation level (four spaces or a single tab) from the start of each
    /// line, after trimming surrounding blank lines.
    /// </summary>

    private static string Dedent(string body, string newline)
    {
        var trimmed = body.Trim('\r', '\n');
        var lines = trimmed.Split(new[] { newline }, StringSplitOptions.None);
        var result = new List<string>(lines.Length);

        foreach (var line in lines)
        {
            if (line.StartsWith("    ", StringComparison.Ordinal))
            {
                result.Add(line.Substring(4));
            }
            else if (line.StartsWith("\t", StringComparison.Ordinal))
            {
                result.Add(line.Substring(1));
            }
            else
            {
                result.Add(line);
            }
        }

        return string.Join(newline, result);
    }
}
