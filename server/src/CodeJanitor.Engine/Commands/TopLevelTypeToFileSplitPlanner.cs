#nullable disable
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace CodeJanitor.Engine.Commands;

/// <summary>
/// Planner that determines how to split a top-level type into separate files by identifying and relocating its contained types while handling naming, partial declarations, and file uniqueness.
/// </summary>
internal sealed class TopLevelTypeToFileSplitPlanner
{
    /// <summary>
    /// PlannedFile represents a file intended for creation or processing, encapsulating its destination path along with the content to be written.
    /// </summary>
    internal sealed class PlannedFile
    {
        internal PlannedFile(string filePath, string content)
        {
            FilePath = filePath;
            Content = content;
        }

        /// <summary>
        /// Gets the file path.
        /// </summary>
        internal string FilePath { get; }

        /// <summary>
        /// Gets the content.
        /// </summary>
        internal string Content { get; }
    }

    /// <summary>
    /// SplitPlan represents a proposed plan for splitting an existing source into updated source and new files, indicating whether changes are present and providing a reason if the operation is skipped.
    /// </summary>
    internal sealed class SplitPlan
    {
        internal SplitPlan(
            string updatedSource,
            IReadOnlyList<PlannedFile> newFiles,
            TopLevelTypeSplitSkipReason skipReason = TopLevelTypeSplitSkipReason.None)
        {
            UpdatedSource = updatedSource;
            NewFiles = newFiles;
            SkipReason = skipReason;
        }

        /// <summary>
        /// Gets the updated source.
        /// </summary>
        internal string UpdatedSource { get; }

        /// <summary>
        /// Gets the new files.
        /// </summary>
        internal IReadOnlyList<PlannedFile> NewFiles { get; }

        /// <summary>
        /// Gets the skip reason.
        /// </summary>
        internal TopLevelTypeSplitSkipReason SkipReason { get; }

        /// <summary>
        /// Gets the has changes.
        /// </summary>
        internal bool HasChanges => NewFiles.Count > 0;
    }

    /// <summary>
    /// Creates a SplitPlan by parsing the C# source, identifying multiple eligible top-level types, keeping one in the original file while generating new planned .cs files for the others with unique file names based on existing files in the target directory, and returns empty plans with skip reasons for empty input, unsupported structures, or fewer than two eligible types.
    /// </summary>
    /// <param name="source">The source.</param>
    /// <param name="filePath">The file path.</param>
    /// <returns>A SplitPlan value produced by this method.</returns>
    internal SplitPlan CreatePlan(string source, string filePath) => CreatePlan(source, filePath, ReadDirectoryFileNames(filePath), null, refuseFileNameCollisions: false);

    /// <summary>
    /// Creates a split plan. <paramref name="reservedFileNames" /> are the names of the existing files the plan never
    /// overwrites; <paramref name="movable" /> limits the types that can move (null: every eligible type). With
    /// <paramref name="refuseFileNameCollisions" />, a type whose file exists makes the plan empty instead of taking
    /// the next free name.
    /// </summary>
    internal SplitPlan CreatePlan(string source, string filePath, IEnumerable<string> reservedFileNames, Func<MemberDeclarationSyntax, bool> movable, bool refuseFileNameCollisions)
    {
        if (string.IsNullOrWhiteSpace(source) || string.IsNullOrWhiteSpace(filePath))
        {
            return new SplitPlan(source, Array.Empty<PlannedFile>(), TopLevelTypeSplitSkipReason.EmptySource);
        }

        var root = CSharpSyntaxTree.ParseText(source).GetCompilationUnitRoot();
        if (HasUnsupportedStructure(root) ||
            !TryGetContainerMembers(root, out var members) ||
            members.Any(x => x is BaseNamespaceDeclarationSyntax || x is GlobalStatementSyntax) ||
            members.Any(x => x.Modifiers.Any(SyntaxKind.FileKeyword)) ||
            HasRegionAcrossMembers(root, members))
        {
            return new SplitPlan(source, Array.Empty<PlannedFile>(), TopLevelTypeSplitSkipReason.UnsupportedStructure);
        }

        root = AttachTrailingEndRegions(root, members);
        TryGetContainerMembers(root, out members);

        var eligibleMembers = members.Where(IsEligibleTopLevelType).ToList();
        if (movable is not null)
        {
            var named = ChooseMemberToKeep(eligibleMembers, Path.GetFileName(filePath));
            var movableMembers = eligibleMembers.Where(movable).ToList();
            eligibleMembers = named is not null && !movableMembers.Contains(named)
                ? movableMembers.Prepend(named).ToList()
                : movableMembers;
        }

        if (eligibleMembers.Count <= 1)
        {
            return new SplitPlan(source, Array.Empty<PlannedFile>(), TopLevelTypeSplitSkipReason.NotMultipleEligibleTypes);
        }

        var memberToKeep = ChooseMemberToKeep(eligibleMembers, Path.GetFileName(filePath)) ?? eligibleMembers[0];
        var movedMembers = eligibleMembers.Where(x => x != memberToKeep).ToList();
        if (movedMembers.Count == 0)
        {
            return new SplitPlan(source, Array.Empty<PlannedFile>(), TopLevelTypeSplitSkipReason.NotMultipleEligibleTypes);
        }

        var updatedMembers = members.Where(x => !movedMembers.Contains(x)).ToList();
        if (movedMembers.Contains(members[0]) && members[0].FullSpan.Start == 0)
        {
            updatedMembers[0] = WithFileHeaderOf(members[0], updatedMembers[0]);
        }

        var updatedRoot = ReplaceContainedMembers(root, updatedMembers);

        var directoryPath = Path.GetDirectoryName(filePath) ?? string.Empty;
        var reserved = new HashSet<string>(reservedFileNames, StringComparer.OrdinalIgnoreCase);
        if (refuseFileNameCollisions && movedMembers.Any(member => reserved.Contains(BuildTypeFileName(member))))
        {
            return new SplitPlan(source, Array.Empty<PlannedFile>(), TopLevelTypeSplitSkipReason.FileNameCollision);
        }

        var plannedFiles = new List<PlannedFile>();
        foreach (var movedMember in movedMembers)
        {
            var desiredFileName = BuildTypeFileName(movedMember);
            var finalFileName = MakeFileNameUnique(desiredFileName, reserved);
            reserved.Add(finalFileName);

            var newRoot = WithoutGlobalUsings(ReplaceContainedMembers(root, new[] { movedMember }));
            plannedFiles.Add(new PlannedFile(Path.Combine(directoryPath, finalFileName), newRoot.ToFullString()));
        }

        return new SplitPlan(updatedRoot.ToFullString(), plannedFiles);
    }

    /// <summary>
    /// Removes the <c>global using</c> directives: they apply to the whole compilation and stay in the original file,
    /// repeated in a split-out file they are reported as duplicates (CS8933). The leading trivia of a removed directive
    /// (the file header, which the parser attaches to the first directive, region and other preprocessor directives,
    /// comments) moves to the next token that is kept, so no directive loses its pair.
    /// </summary>
    /// <param name="root">The root of a generated file.</param>
    /// <returns>The root without global using directives.</returns>
    /// <summary>The names of the <c>.cs</c> files in the directory of <paramref name="filePath" />.</summary>
    internal static IEnumerable<string> ReadDirectoryFileNames(string filePath)
    {
        var directoryPath = Path.GetDirectoryName(filePath);

        return !string.IsNullOrEmpty(directoryPath) && Directory.Exists(directoryPath)
            ? Directory.GetFiles(directoryPath, "*.cs").Select(Path.GetFileName)
            : Array.Empty<string>();
    }

    private static CompilationUnitSyntax WithoutGlobalUsings(CompilationUnitSyntax root)
    {
        if (!root.Usings.Any(x => !x.GlobalKeyword.IsKind(SyntaxKind.None)))
        {
            return root;
        }

        var kept = new List<UsingDirectiveSyntax>();
        var carried = SyntaxTriviaList.Empty;
        foreach (var directive in root.Usings)
        {
            if (!directive.GlobalKeyword.IsKind(SyntaxKind.None))
            {
                carried = carried.AddRange(directive.GetLeadingTrivia());
                continue;
            }

            kept.Add(directive.WithLeadingTrivia(carried.AddRange(directive.GetLeadingTrivia())));
            carried = SyntaxTriviaList.Empty;
        }

        var stripped = root.WithUsings(SyntaxFactory.List(kept));
        if (carried.Count == 0)
        {
            return stripped;
        }

        var nextToken = stripped.AttributeLists.FirstOrDefault()?.GetFirstToken() ??
            stripped.Members.FirstOrDefault()?.GetFirstToken() ??
            stripped.EndOfFileToken;

        return stripped.ReplaceToken(nextToken, nextToken.WithLeadingTrivia(carried.AddRange(nextToken.LeadingTrivia)));
    }

    /// <summary>
    /// Builds a C# filename by appending the &quot;.cs&quot; extension to the type file stem derived from the given member declaration syntax, with no side effects or exceptions.
    /// </summary>
    /// <param name="member">The member.</param>
    /// <returns>A string value produced by this method.</returns>
    internal static string BuildTypeFileName(MemberDeclarationSyntax member) => BuildTypeFileStem(member) + ".cs";

    /// <summary>
    /// Constructs a file stem from a member&apos;s identifier, appending its type parameter names in curly braces when present, with no side effects.
    /// </summary>
    /// <param name="member">The member.</param>
    /// <returns>A string value produced by this method.</returns>
    internal static string BuildTypeFileStem(MemberDeclarationSyntax member)
    {
        var identifier = GetIdentifier(member);
        var typeParameters = GetTypeParameterNames(member);

        return typeParameters.Count == 0
            ? identifier
            : identifier + "{" + string.Join(",", typeParameters) + "}";
    }

    /// <summary>
    /// Returns true if the compilation unit contains attribute lists, non-region preprocessor directives, multiple namespaces, or a namespace with additional top-level members, otherwise false, with no side effects.
    /// </summary>
    /// <param name="root">The root.</param>
    /// <returns>A bool value produced by this method.</returns>
    private static bool HasUnsupportedStructure(CompilationUnitSyntax root)
    {
        if (root.AttributeLists.Count > 0)
        {
            return true;
        }

        foreach (var trivia in root.DescendantTrivia(descendIntoTrivia: true).Where(x => x.IsDirective))
        {
            var directive = trivia.GetStructure();
            if (!(directive is RegionDirectiveTriviaSyntax) && !(directive is EndRegionDirectiveTriviaSyntax))
            {
                return true;
            }
        }

        var namespaces = root.Members.OfType<BaseNamespaceDeclarationSyntax>().ToList();
        if (namespaces.Count > 1)
        {
            return true;
        }

        if (namespaces.Count == 1 && root.Members.Count != 1)
        {
            return true;
        }

        return false;
    }

    /// <summary>
    /// Returns true when a #region/#endregion pair is not owned by a single contained member (or by none of them),
    /// e.g. a region around several types: splitting the members would separate the two directives (CS1028).
    /// Unpaired region directives also return true.
    /// </summary>
    /// <param name="root">The root.</param>
    /// <param name="members">The contained members.</param>
    /// <returns>True when splitting could separate a region pair.</returns>
    private static bool HasRegionAcrossMembers(CompilationUnitSyntax root, IReadOnlyList<MemberDeclarationSyntax> members)
    {
        foreach (var region in root.DescendantTrivia(descendIntoTrivia: true)
            .Where(x => x.IsKind(SyntaxKind.RegionDirectiveTrivia) || x.IsKind(SyntaxKind.EndRegionDirectiveTrivia)))
        {
            var related = ((DirectiveTriviaSyntax)region.GetStructure()).GetRelatedDirectives();
            if (related.Count != 2 || FindOwner(members, related[0]) != FindOwner(members, related[1]))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Returns the member owning the directive: the member whose trailing #endregion it is (see
    /// <see cref="TryGetTrailingEndRegion"/>), otherwise the member whose full span (including its trivia)
    /// contains it, or null.
    /// </summary>
    /// <param name="members">The contained members.</param>
    /// <param name="directive">The directive.</param>
    /// <returns>The owning member, or null when the directive is outside every member.</returns>
    private static MemberDeclarationSyntax FindOwner(IReadOnlyList<MemberDeclarationSyntax> members, DirectiveTriviaSyntax directive) => members.FirstOrDefault(x => TryGetTrailingEndRegion(x, out var nextToken, out var triviaCount)
                                                                                                                                                      && nextToken.LeadingTrivia[triviaCount - 1].Span.Contains(directive.SpanStart))
            ?? members.FirstOrDefault(x => x.FullSpan.Contains(directive.SpanStart));

    /// <summary>
    /// Finds the #endregion closing a region opened inside <paramref name="member"/> when it is the first directive
    /// in the leading trivia of the token after the member (the next member, the closing brace of the namespace or
    /// the end of the file), where the parser puts it although it belongs to the member.
    /// </summary>
    /// <param name="member">The member.</param>
    /// <param name="nextToken">The token after the member.</param>
    /// <param name="triviaCount">The number of leading trivia of <paramref name="nextToken"/> up to and including the #endregion.</param>
    /// <returns>True when the member has such an #endregion.</returns>
    private static bool TryGetTrailingEndRegion(MemberDeclarationSyntax member, out SyntaxToken nextToken, out int triviaCount)
    {
        nextToken = member.GetLastToken().GetNextToken(includeZeroWidth: true);
        triviaCount = 0;
        var leadingTrivia = nextToken.LeadingTrivia;
        for (var i = 0; i < leadingTrivia.Count; i++)
        {
            if (!leadingTrivia[i].IsDirective)
            {
                continue;
            }

            if (!leadingTrivia[i].IsKind(SyntaxKind.EndRegionDirectiveTrivia))
            {
                return false;
            }

            var related = ((DirectiveTriviaSyntax)leadingTrivia[i].GetStructure()).GetRelatedDirectives();
            if (related.Count != 2 || !member.FullSpan.Contains(related[0].SpanStart))
            {
                return false;
            }

            triviaCount = i + 1;

            return true;
        }

        return false;
    }

    /// <summary>
    /// Moves every trailing #endregion of a member (see <see cref="TryGetTrailingEndRegion"/>), with the trivia
    /// before it, into the trailing trivia of that member so it is kept or moved together with the member.
    /// </summary>
    /// <param name="root">The root.</param>
    /// <param name="members">The contained members.</param>
    /// <returns>The root with the #endregion directives attached to their members.</returns>
    private static CompilationUnitSyntax AttachTrailingEndRegions(CompilationUnitSyntax root, IReadOnlyList<MemberDeclarationSyntax> members)
    {
        var replacements = new Dictionary<SyntaxToken, SyntaxToken>();
        foreach (var member in members)
        {
            if (!TryGetTrailingEndRegion(member, out var nextToken, out var triviaCount))
            {
                continue;
            }

            var lastToken = member.GetLastToken();
            replacements[lastToken] = lastToken.WithTrailingTrivia(lastToken.TrailingTrivia.AddRange(nextToken.LeadingTrivia.Take(triviaCount)));
            replacements[nextToken] = nextToken.WithLeadingTrivia(nextToken.LeadingTrivia.Skip(triviaCount));
        }

        return replacements.Count == 0
            ? root
            : root.ReplaceTokens(replacements.Keys, (original, _) => replacements[original]);
    }

    /// <summary>
    /// Gives <paramref name="keptMember"/> the file header (the comments and blank lines ending with a blank line at
    /// the start of the leading trivia) of <paramref name="movedFirstMember"/>, the first thing in the file, so the
    /// header stays in the original file; the kept member's own leading blank lines are dropped.
    /// </summary>
    /// <param name="movedFirstMember">The moved member that starts the file.</param>
    /// <param name="keptMember">The member that becomes the first member of the original file.</param>
    /// <returns>The kept member, with the header when there is one.</returns>
    private static MemberDeclarationSyntax WithFileHeaderOf(MemberDeclarationSyntax movedFirstMember, MemberDeclarationSyntax keptMember)
    {
        var trivia = movedFirstMember.GetLeadingTrivia();
        var headerLength = 0;
        var hasComment = false;
        var lineIsBlank = true;
        for (var i = 0; i < trivia.Count; i++)
        {
            var kind = trivia[i].Kind();
            if (kind == SyntaxKind.SingleLineCommentTrivia || kind == SyntaxKind.MultiLineCommentTrivia)
            {
                hasComment = true;
                lineIsBlank = false;
            }
            else if (kind == SyntaxKind.EndOfLineTrivia)
            {
                if (lineIsBlank && hasComment)
                {
                    headerLength = i + 1;
                }

                lineIsBlank = true;
            }
            else if (kind != SyntaxKind.WhitespaceTrivia)
            {
                break;
            }
        }

        if (headerLength == 0)
        {
            return keptMember;
        }

        var ownTrivia = keptMember.GetLeadingTrivia()
            .SkipWhile(x => x.IsKind(SyntaxKind.WhitespaceTrivia) || x.IsKind(SyntaxKind.EndOfLineTrivia));

        return keptMember.WithLeadingTrivia(trivia.Take(headerLength).Concat(ownTrivia));
    }

    /// <summary>
    /// If the compilation unit contains exactly one member that is a namespace declaration, returns its members via the out parameter; otherwise returns all root members, and always returns true while populating the out parameter.
    /// </summary>
    /// <param name="root">The root.</param>
    /// <param name="members">The members.</param>
    /// <returns>A bool value produced by this method.</returns>
    private static bool TryGetContainerMembers(CompilationUnitSyntax root, out IReadOnlyList<MemberDeclarationSyntax> members)
    {
        if (root.Members.Count == 1 && root.Members[0] is BaseNamespaceDeclarationSyntax namespaceDeclaration)
        {
            members = namespaceDeclaration.Members.ToList();

            return true;
        }

        members = root.Members.ToList();

        return true;
    }

    /// <summary>
    /// Returns true for every kind of top-level type that is not partial (class, struct, interface, record, record
    /// struct, enum) and for delegates.
    /// </summary>
    /// <param name="member">The member.</param>
    /// <returns>True when the member can be moved into its own file.</returns>
    private static bool IsEligibleTopLevelType(MemberDeclarationSyntax member) => member is BaseTypeDeclarationSyntax typeDeclaration
            ? !HasPartialModifier(typeDeclaration.Modifiers)
            : member is DelegateDeclarationSyntax;

    /// <summary>
    /// Returns true if the modifier list contains a partial keyword token, otherwise false, with no side effects or exceptions.
    /// </summary>
    /// <param name="modifiers">The modifiers.</param>
    /// <returns>A bool value produced by this method.</returns>
    private static bool HasPartialModifier(SyntaxTokenList modifiers) => modifiers.Any(x => x.IsKind(SyntaxKind.PartialKeyword));

    /// <summary>
    /// Returns the first eligible member whose generated type file name matches the original file name (case-insensitive), or null if no match is found.
    /// </summary>
    /// <param name="eligibleMembers">The eligible members.</param>
    /// <param name="originalFileName">The original file name.</param>
    /// <returns>A MemberDeclarationSyntax value produced by this method.</returns>
    private static MemberDeclarationSyntax ChooseMemberToKeep(IEnumerable<MemberDeclarationSyntax> eligibleMembers, string originalFileName) => eligibleMembers.FirstOrDefault(x => string.Equals(BuildTypeFileName(x), originalFileName, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// Replaces the compilation unit&apos;s members, or the members of a sole file-scoped or regular namespace, with the provided list and returns a new syntax tree without modifying the original.
    /// </summary>
    /// <param name="root">The root.</param>
    /// <param name="members">The members.</param>
    /// <returns>A CompilationUnitSyntax value produced by this method.</returns>
    private static CompilationUnitSyntax ReplaceContainedMembers(CompilationUnitSyntax root, IEnumerable<MemberDeclarationSyntax> members)
    {
        var memberList = SyntaxFactory.List(members);

        if (root.Members.Count == 1 && root.Members[0] is FileScopedNamespaceDeclarationSyntax fileScopedNamespace)
        {
            return root.WithMembers(SyntaxFactory.SingletonList<MemberDeclarationSyntax>(fileScopedNamespace.WithMembers(memberList)));
        }

        if (root.Members.Count == 1 && root.Members[0] is NamespaceDeclarationSyntax namespaceDeclaration)
        {
            return root.WithMembers(SyntaxFactory.SingletonList<MemberDeclarationSyntax>(namespaceDeclaration.WithMembers(memberList)));
        }

        return root.WithMembers(memberList);
    }

    /// <summary>
    /// If the desired filename is not reserved it returns it unchanged, otherwise it appends a numeric suffix with a tilde before the extension, incrementing until an unreserved candidate is found, with no side effects or exceptions.
    /// </summary>
    /// <param name="desiredFileName">The desired file name.</param>
    /// <param name="reservedFileNames">The reserved file names.</param>
    /// <returns>A string value produced by this method.</returns>
    internal static string MakeFileNameUnique(string desiredFileName, ISet<string> reservedFileNames)
    {
        if (!reservedFileNames.Contains(desiredFileName))
        {
            return desiredFileName;
        }

        var extension = Path.GetExtension(desiredFileName);
        var stem = Path.GetFileNameWithoutExtension(desiredFileName);
        var suffix = 1;

        string candidate;
        do
        {
            candidate = stem + "~" + suffix + extension;
            suffix++;
        }
        while (reservedFileNames.Contains(candidate));

        return candidate;
    }

    /// <summary>
    /// Returns the identifier text for base type and delegate declarations, throwing InvalidOperationException for unsupported member types.
    /// </summary>
    /// <param name="member">The member.</param>
    /// <returns>A string value produced by this method.</returns>
    /// <exception cref="InvalidOperationException">Thrown when method validation or execution fails for this exception type.</exception>
    private static string GetIdentifier(MemberDeclarationSyntax member)
    {
        switch (member)
        {
            case BaseTypeDeclarationSyntax baseTypeDeclaration:
                return baseTypeDeclaration.Identifier.ValueText;

            case DelegateDeclarationSyntax delegateDeclaration:
                return delegateDeclaration.Identifier.ValueText;

            default:
                throw new InvalidOperationException("Unsupported top-level type declaration.");
        }
    }

    /// <summary>
    /// Returns the list of type parameter names from a type or delegate declaration, or an empty array if none exist, with no side effects.
    /// </summary>
    /// <param name="member">The member.</param>
    /// <returns>A IReadOnlyList&lt;string&gt; value produced by this method.</returns>
    private static IReadOnlyList<string> GetTypeParameterNames(MemberDeclarationSyntax member)
    {
        switch (member)
        {
            case TypeDeclarationSyntax typeDeclaration when typeDeclaration.TypeParameterList is not null:
                return typeDeclaration.TypeParameterList.Parameters.Select(x => x.Identifier.ValueText).ToList();

            case DelegateDeclarationSyntax delegateDeclaration when delegateDeclaration.TypeParameterList is not null:
                return delegateDeclaration.TypeParameterList.Parameters.Select(x => x.Identifier.ValueText).ToList();

            default:
                return Array.Empty<string>();
        }
    }
}
