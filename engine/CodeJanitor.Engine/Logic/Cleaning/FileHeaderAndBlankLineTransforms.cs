using CodeJanitor.Properties;
using CodeJanitor.UI.Enumerations;
using System;
using System.Linq;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis.CSharp;

namespace CodeJanitor.Logic.Cleaning;

/// <summary>
/// File header and blank-line regex transforms, ported unchanged from the private static
/// methods in CodeJanitorShared/Logic/Cleaning/CodeCleanupManager.cs (Visual Studio extension) -
/// these had no EnvDTE dependency, only Settings.Default and plain string/regex work.
/// </summary>
internal static class FileHeaderAndBlankLineTransforms
{
    internal static string ApplyConfiguredCSharpFileHeader(string source)
    {
        var settingsFileHeader = Settings.Default.Cleaning_UpdateFileHeaderCSharp;
        if (string.IsNullOrWhiteSpace(settingsFileHeader))
        {
            return source;
        }

        var newline = source.Contains("\r\n") ? "\r\n" : Environment.NewLine;
        settingsFileHeader = NormalizeLineEndings(settingsFileHeader, newline);
        if (!settingsFileHeader.EndsWith(newline, StringComparison.Ordinal))
        {
            settingsFileHeader += newline;
        }

        var headerPosition = (HeaderPosition)Settings.Default.Cleaning_UpdateFileHeader_HeaderPosition;
        var headerUpdateMode = (HeaderUpdateMode)Settings.Default.Cleaning_UpdateFileHeader_HeaderUpdateMode;

        switch (headerPosition)
        {
            case HeaderPosition.DocumentStart:
                return headerUpdateMode == HeaderUpdateMode.Insert
                    ? InsertHeaderAtDocumentStart(source, settingsFileHeader)
                    : ReplaceHeaderAtDocumentStart(source, settingsFileHeader);

            case HeaderPosition.AfterUsings:
                return headerUpdateMode == HeaderUpdateMode.Insert
                    ? InsertHeaderAfterUsings(source, settingsFileHeader)
                    : ReplaceHeaderAfterUsings(source, settingsFileHeader);

            default:
                return source;
        }
    }

    private static string InsertHeaderAtDocumentStart(string source, string settingsFileHeader)
    {
        return source.StartsWith(settingsFileHeader.Trim(), StringComparison.Ordinal)
            ? source
            : settingsFileHeader + source;
    }

    private static string ReplaceHeaderAtDocumentStart(string source, string settingsFileHeader)
    {
        TryExtractLeadingHeaderSegment(source, out var currentHeaderLength, out var currentHeader);

        return string.Equals(currentHeader, settingsFileHeader.Trim(), StringComparison.Ordinal)
            ? source
            : settingsFileHeader + source.Substring(currentHeaderLength);
    }

    private static string InsertHeaderAfterUsings(string source, string settingsFileHeader)
    {
        var insertionIndex = GetTopLevelUsingInsertionIndex(source);
        TryExtractLeadingHeaderSegment(source.Substring(insertionIndex), out _, out var currentHeader);

        if (currentHeader.StartsWith(settingsFileHeader.Trim(), StringComparison.Ordinal))
        {
            return source;
        }

        var headerWithLeadingNewline = EnsureHeaderStartsOnNewLine(settingsFileHeader);

        return source.Insert(insertionIndex, headerWithLeadingNewline);
    }

    private static string ReplaceHeaderAfterUsings(string source, string settingsFileHeader)
    {
        var insertionIndex = GetTopLevelUsingInsertionIndex(source);
        var suffix = source.Substring(insertionIndex);

        TryExtractLeadingHeaderSegment(suffix, out var currentHeaderLength, out var currentHeader);
        if (string.Equals(currentHeader, settingsFileHeader.Trim(), StringComparison.Ordinal))
        {
            return source;
        }

        var headerWithLeadingNewline = EnsureHeaderStartsOnNewLine(settingsFileHeader);

        return source.Substring(0, insertionIndex) +
               headerWithLeadingNewline +
               suffix.Substring(currentHeaderLength);
    }

    private static string EnsureHeaderStartsOnNewLine(string header)
    {
        var newline = header.Contains("\r\n") ? "\r\n" : Environment.NewLine;

        return header.StartsWith(newline, StringComparison.Ordinal) ? header : newline + header;
    }

    private static int GetTopLevelUsingInsertionIndex(string source)
    {
        var root = CSharpSyntaxTree.ParseText(source).GetCompilationUnitRoot();

        return root.Usings.Count == 0 ? 0 : root.Usings.Last().FullSpan.End;
    }

    private static bool TryExtractLeadingHeaderSegment(string source, out int segmentLength, out string trimmedHeader)
    {
        var lineHeaderMatch = Regex.Match(
            source,
            @"\A(?<segment>(?:[ \t]*\r?\n)*(?://[^\r\n]*(?:\r?\n//[^\r\n]*)*(?:\r?\n)?))",
            RegexOptions.Multiline);

        if (lineHeaderMatch.Success)
        {
            var segment = lineHeaderMatch.Groups["segment"].Value;
            segmentLength = segment.Length;
            trimmedHeader = segment.Trim();

            return true;
        }

        var blockHeaderMatch = Regex.Match(
            source,
            @"\A(?<segment>(?:[ \t]*\r?\n)*/\*.*?\*/(?:\r?\n)?)",
            RegexOptions.Singleline);

        if (blockHeaderMatch.Success)
        {
            var segment = blockHeaderMatch.Groups["segment"].Value;
            segmentLength = segment.Length;
            trimmedHeader = segment.Trim();

            return true;
        }

        segmentLength = 0;
        trimmedHeader = string.Empty;

        return false;
    }

    private static string NormalizeLineEndings(string value, string newline)
    {
        return value.Replace("\r\n", "\n").Replace("\r", "\n").Replace("\n", newline);
    }

    internal static string RemoveBlankLinesAtTop(string source)
    {
        return Regex.Replace(source, @"\A(?:[ \t]*\r?\n)+", string.Empty);
    }

    internal static string RemoveBlankLinesAtBottom(string source)
    {
        return Regex.Replace(source, @"(?:\r?\n[ \t]*)+\z", string.Empty);
    }

    internal static string RemoveBlankLinesAfterAttributes(string source)
    {
        return ReplaceUsingFileLineEnding(source, @"(^[ \t]*\[[^\]]+\][ \t]*(//[^\r\n]*)*)(\r?\n){2}(?![ \t]*//)", "$1{NL}");
    }

    internal static string RemoveBlankLinesAfterOpeningBrace(string source)
    {
        return ReplaceUsingFileLineEnding(source, @"\{([ \t]*(//[^\r\n]*)*)(\r?\n){2,}", "{$1{NL}");
    }

    internal static string RemoveBlankLinesBeforeClosingBrace(string source)
    {
        return ReplaceUsingFileLineEnding(source, @"(\r?\n){2,}([ \t]*)\}", "{NL}$2}");
    }

    internal static string RemoveBlankLinesBetweenChainedStatements(string source)
    {
        return ReplaceUsingFileLineEnding(source, @"(\r?\n){2,}([ \t]*)(else|catch|finally)( |\t|\r?\n)", "{NL}$2$3$4");
    }

    private static string ReplaceUsingFileLineEnding(string source, string pattern, string replacement)
    {
        var newline = source.Contains("\r\n") ? "\r\n" : "\n";

        return Regex.Replace(source, pattern, replacement.Replace("{NL}", newline), RegexOptions.Multiline);
    }
}
