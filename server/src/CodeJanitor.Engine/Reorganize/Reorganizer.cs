using System.Text;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace CodeJanitor.Engine.Reorganize;

/// <summary>What reorganizing a file did.</summary>
/// <param name="Output">The reorganized text (the input when nothing changed).</param>
/// <param name="Skipped">Containers left alone, with the reason; reported to the user, never silently dropped.</param>
/// <param name="BlockedByPreprocessor">The file has preprocessor conditionals and the policy does not allow reorganizing it without asking.</param>
public sealed record ReorganizeResult(string Output, IReadOnlyList<string> Skipped, bool BlockedByPreprocessor);

/// <summary>
/// Reorganizes the members of every type in a C# file (Visual Studio <c>CodeReorganizationManager</c>): orders them by
/// member type, access level and name, moves their comments and attributes with them, and inserts or removes regions,
/// while never changing what the code does (initialization order, struct layout, partial parts, <c>#if</c> blocks).
/// </summary>
public static partial class Reorganizer
{
    /// <summary><c>CodeReorganizationAvailabilityLogic.HasPreprocessorConditionalCompilationDirectives</c>.</summary>
    public static bool HasPreprocessorConditionals(string source) => PreprocessorConditional().IsMatch(source);

    /// <summary>Reorganizes a document with the semantic model of its project.</summary>
    public static async Task<ReorganizeResult> ReorganizeAsync(Document document, ReorganizeSettings settings, ReorganizeCleanup cleanup, CancellationToken cancellationToken)
    {
        var tree = await document.GetSyntaxTreeAsync(cancellationToken).ConfigureAwait(false);
        if (tree is null)
        {
            return new ReorganizeResult(string.Empty, [], false);
        }

        var text = await tree.GetTextAsync(cancellationToken).ConfigureAwait(false);
        if (settings.PerformWhenPreprocessorConditionals != PreprocessorPolicy.Yes && HasPreprocessorConditionals(text.ToString()))
        {
            return new ReorganizeResult(text.ToString(), [], true);
        }

        var model = await document.GetSemanticModelAsync(cancellationToken).ConfigureAwait(false);

        return Reorganize(tree, model, settings, cleanup, cancellationToken);
    }

    /// <summary>
    /// Reorganizes the file of <paramref name="tree"/>; <paramref name="model"/> (of the same tree) makes the
    /// initializer analysis exact and lets the result be checked for new compiler errors.
    /// </summary>
    public static ReorganizeResult Reorganize(SyntaxTree tree, SemanticModel? model, ReorganizeSettings settings, ReorganizeCleanup cleanup, CancellationToken cancellationToken = default)
    {
        var source = tree.GetText(cancellationToken).ToString();
        if (source.Length == 0)
        {
            return new ReorganizeResult(source, [], false);
        }

        if (settings.PerformWhenPreprocessorConditionals != PreprocessorPolicy.Yes && HasPreprocessorConditionals(source))
        {
            return new ReorganizeResult(source, [], true);
        }

        var skipped = new List<string>();
        var output = new Session(tree, model, source, settings, cleanup, skipped).Run();
        if (output == source)
        {
            return new ReorganizeResult(source, skipped, false);
        }

        var newTree = tree.WithChangedText(SourceText.From(output, tree.GetText(cancellationToken).Encoding));
        if (ErrorCount(newTree.GetDiagnostics(cancellationToken)) > ErrorCount(tree.GetDiagnostics(cancellationToken))
            || (model is not null && CompilerErrors(model.Compilation.ReplaceSyntaxTree(tree, newTree), newTree, cancellationToken) > CompilerErrors(model.Compilation, tree, cancellationToken)))
        {
            skipped.Add("the reorganized file no longer compiles cleanly, so it was left unchanged");

            return new ReorganizeResult(source, skipped, false);
        }

        return new ReorganizeResult(output, skipped, false);
    }

    private static int ErrorCount(IEnumerable<Diagnostic> diagnostics) => diagnostics.Count(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error);

    private static int CompilerErrors(Compilation compilation, SyntaxTree tree, CancellationToken cancellationToken) =>
        ErrorCount(compilation.GetSemanticModel(tree).GetDiagnostics(cancellationToken: cancellationToken));

    [GeneratedRegex(@"^[ \t]*#[ \t]*(if|else|elif|endif|pragma)\b", RegexOptions.Multiline)]
    private static partial Regex PreprocessorConditional();

    private sealed record Rewrite(int Start, int End, string Text);

    private sealed record ContainerPlan(
        SyntaxNode Node,
        ContainerKind Kind,
        string TypeName,
        INamedTypeSymbol? Symbol,
        IReadOnlyList<Atom> Atoms,
        int BodyStart,
        int BodyEnd);

    private sealed partial class Session : IBuildEnvironment
    {
        private const string SemicolonAfterBlock = "CS1597";

        private static readonly HashSet<string> LayoutAttributes = ["StructLayout", "StructLayoutAttribute"];
        private static readonly HashSet<string> ComAttributes = ["ComImport", "ComImportAttribute", "InterfaceType", "InterfaceTypeAttribute", "GeneratedComInterface", "GeneratedComInterfaceAttribute"];

        private readonly SyntaxTree _tree;
        private readonly SemanticModel? _model;
        private readonly ReorganizeSettings _settings;
        private readonly ReorganizeCleanup _cleanup;
        private readonly List<string> _skipped;
        private readonly List<Rewrite> _rewrites = [];
        private readonly string _eol;
        private readonly RegionNamer _namer;
        private readonly MemberComparer _comparer;
        private ContainerPlan? _plan;
        private ContainerContext? _context;

        public Session(SyntaxTree tree, SemanticModel? model, string source, ReorganizeSettings settings, ReorganizeCleanup cleanup, List<string> skipped)
        {
            _tree = tree;
            _model = model;
            Source = source;
            _settings = settings;
            _cleanup = cleanup;
            _skipped = skipped;
            _eol = source.Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n";
            _namer = new RegionNamer(settings);
            _comparer = new MemberComparer(settings);
        }

        public string Source { get; }

        public string Run()
        {
            foreach (var plan in CollectContainers((CompilationUnitSyntax)_tree.GetRoot()))
            {
                Process(plan);
            }

            return SpanText(0, Source.Length);
        }

        // ------------------------------------------------------------------ containers

        /// <summary>The containers, every nested container before the one holding it.</summary>
        private List<ContainerPlan> CollectContainers(CompilationUnitSyntax root)
        {
            var plans = new List<ContainerPlan>();
            var end = root.EndOfFileToken;

            if (root.Members.OfType<FileScopedNamespaceDeclarationSyntax>().FirstOrDefault() is { } fileScoped)
            {
                var children = fileScoped.ChildNodes().Where(child => child != fileScoped.Name && child is not AttributeListSyntax).ToList();
                VisitBody(new ContainerPlan(fileScoped, ContainerKind.Namespace, fileScoped.Name.ToString(), null, AtomsOf(children, end), fileScoped.SemicolonToken.Span.End, Source.Length), children, plans);
            }
            else
            {
                var children = root.ChildNodes().ToList();
                VisitBody(new ContainerPlan(root, ContainerKind.Unit, string.Empty, null, AtomsOf(children, end), 0, Source.Length), children, plans);
            }

            return plans;
        }

        private void VisitBody(ContainerPlan plan, IEnumerable<SyntaxNode> children, List<ContainerPlan> plans)
        {
            foreach (var child in children)
            {
                switch (child)
                {
                    case NamespaceDeclarationSyntax @namespace:
                        VisitContainer(@namespace, @namespace.OpenBraceToken, @namespace.CloseBraceToken, @namespace.Name.ToString(), [.. @namespace.Externs, .. @namespace.Usings, .. @namespace.Members], plans);
                        break;
                    case TypeDeclarationSyntax type when !HasFixedLayout(type):
                        VisitContainer(type, type.OpenBraceToken, type.CloseBraceToken, type.Identifier.ValueText, [.. type.Members], plans);
                        break;
                }
            }

            plans.Add(plan);
        }

        private void VisitContainer(SyntaxNode node, SyntaxToken open, SyntaxToken close, string name, List<SyntaxNode> children, List<ContainerPlan> plans)
        {
            if (open.IsKind(SyntaxKind.None) || open.IsMissing || close.IsKind(SyntaxKind.None) || close.IsMissing)
            {
                return;
            }

            var symbol = node is TypeDeclarationSyntax && _model is not null ? _model.GetDeclaredSymbol(node) as INamedTypeSymbol : null;
            var plan = new ContainerPlan(node, MemberDescriber.ContainerKindOf(node), name, symbol, AtomsOf(children, close), open.Span.End, close.SpanStart);
            VisitBody(plan, children, plans);
        }

        /// <summary>The atoms of a container: its children and the comments, directives and inactive code around them.</summary>
        private List<Atom> AtomsOf(IReadOnlyList<SyntaxNode> children, SyntaxToken closing)
        {
            var atoms = new List<Atom>();
            foreach (var child in children)
            {
                AddTrivia(atoms, child.GetLeadingTrivia());
                atoms.Add(new Atom(AtomType.Member, child.SpanStart, child.Span.End, child, string.Empty));
                AddTrivia(atoms, child.GetTrailingTrivia());
            }

            AddTrivia(atoms, closing.LeadingTrivia);

            return atoms;
        }

        private void AddTrivia(List<Atom> atoms, SyntaxTriviaList trivia)
        {
            foreach (var item in trivia)
            {
                var type = item.Kind() switch
                {
                    SyntaxKind.SingleLineCommentTrivia or SyntaxKind.MultiLineCommentTrivia => AtomType.Comment,
                    SyntaxKind.SingleLineDocumentationCommentTrivia or SyntaxKind.MultiLineDocumentationCommentTrivia => AtomType.DocComment,
                    SyntaxKind.RegionDirectiveTrivia => AtomType.Region,
                    SyntaxKind.EndRegionDirectiveTrivia => AtomType.EndRegion,
                    SyntaxKind.IfDirectiveTrivia => AtomType.If,
                    SyntaxKind.ElifDirectiveTrivia => AtomType.Elif,
                    SyntaxKind.ElseDirectiveTrivia => AtomType.Else,
                    SyntaxKind.EndIfDirectiveTrivia => AtomType.EndIf,
                    SyntaxKind.DisabledTextTrivia => AtomType.DisabledText,
                    SyntaxKind.WhitespaceTrivia or SyntaxKind.EndOfLineTrivia => (AtomType?)null,
                    _ when item.IsDirective => AtomType.Directive,
                    _ => null,
                };

                if (type is null)
                {
                    continue;
                }

                var start = item.FullSpan.Start;
                var end = item.FullSpan.End;
                while (start < end && char.IsWhiteSpace(Source[start]))
                {
                    start++;
                }

                while (end > start && char.IsWhiteSpace(Source[end - 1]))
                {
                    end--;
                }

                if (end > start)
                {
                    atoms.Add(new Atom(type.Value, start, end, null, Source[start..end]));
                }
            }
        }

        private void Process(ContainerPlan plan)
        {
            var line = _tree.GetLineSpan(plan.Node.Span).StartLinePosition.Line + 1;
            var label = $"{(plan.Kind == ContainerKind.Unit ? "file" : plan.TypeName.Length > 0 ? plan.TypeName : plan.Kind.ToString().ToLowerInvariant())} (line {(plan.Kind == ContainerKind.Unit ? 1 : line)})";

            if (HasBrokenSyntax(plan.Node))
            {
                Skip(label, "syntax the parser does not understand");

                return;
            }

            try
            {
                if (ReorganizeBody(plan) is { } body)
                {
                    _rewrites.Add(new Rewrite(plan.BodyStart, plan.BodyEnd, body));
                }
            }
            catch (StructureException error)
            {
                // A one-line body holding one member (`class C { int F; }`) has nothing to order: not worth a report.
                var oneMember = error is SharedLineException && MemberCount(plan) <= 1;
                // A file with top-level statements keeps its order of types; the statements say why.
                var topLevelStatements = plan.Kind == ContainerKind.Unit && error.Message.StartsWith("unsupported syntax", StringComparison.Ordinal);
                if (!oneMember && !topLevelStatements)
                {
                    Skip(label, error.Message);
                }
            }
        }

        private bool HasBrokenSyntax(SyntaxNode node) =>
            _tree.GetDiagnostics(node).Any(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error && diagnostic.Id != SemicolonAfterBlock);

        private void Skip(string label, string reason) => _skipped.Add($"{label}: skipped because of {reason}");

        private static int MemberCount(ContainerPlan plan) =>
            plan.Atoms.Count(atom => atom.Node is not null && MemberDescriber.KindOf(atom.Node) is not null);

        private string? ReorganizeBody(ContainerPlan plan)
        {
            if (!HasAnythingToDo(plan))
            {
                return null;
            }

            _plan = plan;
            _context = new ContainerContext(
                plan.Kind,
                plan.Kind == ContainerKind.Struct && !HasAutoLayout(plan.Node),
                new InitializerAnalyzer(_model, plan.Symbol));
            var built = EntryBuilder.Build(plan.Atoms, this);
            var state = new State();

            var keep = _settings.KeepMembersWithinRegions;
            var remove = _settings.RegionsRemoveExistingRegions;
            var insert = _settings.RegionsInsertNewRegions;
            var entries = built.Entries;

            // When inserting regions every existing one goes; otherwise which ones stay depends on the members they hold,
            // which when sorting across regions is only known after the sort.
            var removeAfterSort = remove && !keep && !insert;
            if (remove && !removeAfterSort)
            {
                entries = RemoveRegions(entries, state);
            }

            if (!keep)
            {
                entries = FlattenRegions(entries);
            }

            entries = SortLevel(entries, state);

            if (removeAfterSort)
            {
                entries = RemoveRegions(UnflattenRegions(entries), state);
            }

            if (insert && IsType(plan.Kind))
            {
                entries = InsertRegions(entries, state, plan);
            }

            if (!state.Mutated)
            {
                return null;
            }

            var body = Assemble(plan, built, entries);
            var original = Source[plan.BodyStart..plan.BodyEnd];
            if (!SameContent(original, body))
            {
                throw new StructureException("a safety check: the rewritten body does not hold the same lines as the original");
            }

            if (!DirectivesStayBalanced(original, body))
            {
                throw new StructureException("a safety check: moving its members would separate an #if or #region from its #endif or #endregion");
            }

            return body;
        }

        private static bool IsType(ContainerKind kind) => kind is ContainerKind.Class or ContainerKind.Struct or ContainerKind.Interface;

        /// <summary>A body with at most one member and no region or <c>#if</c> block has nothing to order; regions may still be inserted into it.</summary>
        private bool HasAnythingToDo(ContainerPlan plan) =>
            MemberCount(plan) > 1 || plan.Atoms.Any(atom => atom.Type is AtomType.Region or AtomType.If) || (_settings.RegionsInsertNewRegions && IsType(plan.Kind));

        public Description? Describe(Atom atom)
        {
            if (atom.Node is null || _plan is null || _context is null)
            {
                return null;
            }

            var node = atom.Node;
            var kind = MemberDescriber.KindOf(node);

            if (_plan.Kind is ContainerKind.Unit or ContainerKind.Namespace)
            {
                if (node is UsingDirectiveSyntax or ExternAliasDirectiveSyntax or AttributeListSyntax or FileScopedNamespaceDeclarationSyntax)
                {
                    return new Description.Barrier();
                }

                return kind is MemberKind.Namespace or MemberKind.Class or MemberKind.Struct or MemberKind.Interface or MemberKind.Enum or MemberKind.Delegate
                    ? new Description.Member(MemberDescriber.Describe((MemberDeclarationSyntax)node, kind.Value, _context))
                    : null;
            }

            return kind is { } memberKind && memberKind != MemberKind.Namespace
                ? new Description.Member(MemberDescriber.Describe((MemberDeclarationSyntax)node, memberKind, _context))
                : null;
        }

        public IReadOnlyList<MemberInfo>? DescribeDisabled(Atom atom)
        {
            if (_plan is null || _context is null)
            {
                return null;
            }

            var inType = IsType(_plan.Kind);
            var text = inType ? $"class __Disabled\n{{\n{atom.Text}\n}}\n" : atom.Text;
            var unit = SyntaxFactory.ParseCompilationUnit(text, options: (CSharpParseOptions)_tree.Options);
            // In a type the text must be members of the wrapper only: braces it does not balance would close the wrapper early.
            if (unit.GetDiagnostics().Any(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error) || (inType && unit.Members.Count != 1))
            {
                return null;
            }

            var members = inType ? ((TypeDeclarationSyntax)unit.Members[0]).Members.ToList() : [.. unit.Members];
            var infos = new List<MemberInfo>();
            foreach (var member in members)
            {
                var kind = MemberDescriber.KindOf(member);
                if (kind is null || (inType && kind == MemberKind.Namespace))
                {
                    return null;
                }

                infos.Add(MemberDescriber.Describe(member, kind.Value, _context, withSemantics: false));
            }

            return infos;
        }

        /// <summary>The source between <paramref name="start"/> and <paramref name="end"/> with the rewrites of the containers inside applied.</summary>
        public string SpanText(int start, int end)
        {
            var inside = _rewrites
                .Where(rewrite => rewrite.Start >= start && rewrite.End <= end)
                .OrderBy(rewrite => rewrite.Start)
                .ThenByDescending(rewrite => rewrite.End);

            var result = new StringBuilder();
            var cursor = start;
            foreach (var rewrite in inside)
            {
                if (rewrite.Start < cursor)
                {
                    continue;
                }

                result.Append(Source, cursor, rewrite.Start - cursor).Append(rewrite.Text);
                cursor = rewrite.End;
            }

            return result.Append(Source, cursor, end - cursor).ToString();
        }

        // ------------------------------------------------------------------ regions

        /// <summary>Removes the regions that do not stay (<c>RegionsRemoveExisting</c>), lifting their entries to the level of the region.</summary>
        private List<Entry> RemoveRegions(List<Entry> entries, State state)
        {
            var current = entries;

            while (true)
            {
                var kept = _settings.RegionsInsertNewRegions ? [] : _namer.ComposedNames(current);
                var doomed = current.OfType<RegionEntry>().Where(region => !kept.Contains(region.Name)).ToHashSet();
                if (doomed.Count == 0)
                {
                    break;
                }

                state.Mutated = true;
                current = current.SelectMany(entry => entry is RegionEntry region && doomed.Contains(region) ? LiftChildren(region) : [entry]).ToList();
            }

            return current.Select(entry =>
            {
                if (entry is not RegionEntry region)
                {
                    return entry;
                }

                var copy = (RegionEntry)region.Clone();
                copy.Children = RemoveRegions(region.Children, state);

                return copy;
            }).ToList();
        }

        /// <summary><c>RegionsInsert</c>: puts a region around each run of members that belong to one.</summary>
        private List<Entry> InsertRegions(List<Entry> entries, State state, ContainerPlan plan)
        {
            var existing = entries.Select(RegionNameOfEntry).OfType<string>().ToHashSet();
            var fallbackIndent = MemberIndent(plan);
            string IndentOf(Entry? entry)
            {
                var reference = entry ?? entries.FirstOrDefault(candidate => candidate is MemberEntry);
                if (reference is null)
                {
                    return fallbackIndent;
                }

                return IndentationOf(reference is RegionEntry region ? region.StartText : reference.Text);
            }

            var result = new List<Entry>();
            var runs = new Dictionary<RegionEntry, List<Entry>>(ReferenceEqualityComparer.Instance);
            var created = new Dictionary<string, RegionEntry>(StringComparer.Ordinal);
            for (var i = 0; i < entries.Count;)
            {
                var name = entries[i] is MemberEntry member ? _namer.NameOf(member.Info) : null;
                if (name is null)
                {
                    result.Add(entries[i]);
                    i++;
                    continue;
                }

                var end = i;
                while (end < entries.Count && entries[end] is MemberEntry next && _namer.NameOf(next.Info) == name)
                {
                    end++;
                }

                var run = entries.GetRange(i, end - i);
                if (existing.Contains(name))
                {
                    result.AddRange(run);
                }
                else if (_settings.KeepMembersWithinRegions
                    && run.All(IsLayoutField)
                    && created.TryGetValue(name, out var earlier) && result.IndexOf(earlier) is var at and >= 0
                    && runs[earlier].All(IsLayoutField)
                    && result.Skip(at + 1).All(entry => IsLayoutField(entry) || (entry is RegionEntry region && runs.TryGetValue(region, out var inner) && inner.All(IsLayoutField))))
                {
                    // The layout of a struct keeps its fields, auto-properties and field-like events in their order, which can keep
                    // the fields apart: one region holds them and the members of the layout between them, rather than two Fields regions.
                    var merged = new List<Entry>(runs[earlier]);
                    foreach (var between in result.Skip(at + 1))
                    {
                        if (between is RegionEntry region && runs.Remove(region, out var inner))
                        {
                            created.Remove(region.Name);
                            merged.AddRange(inner);
                        }
                        else
                        {
                            merged.Add(between);
                        }
                    }

                    merged.AddRange(run);
                    runs.Remove(earlier);
                    result.RemoveRange(at, result.Count - at);
                    var combined = CreateRegion(name, merged, IndentOf(merged[0]));
                    runs[combined] = merged;
                    created[name] = combined;
                    result.Add(combined);
                }
                else
                {
                    var region = CreateRegion(name, run, IndentOf(run[0]));
                    runs[region] = run;
                    created[name] = region;
                    result.Add(region);
                    state.Mutated = true;
                }

                i = end;
            }

            if (_settings.RegionsInsertKeepEvenIfEmpty)
            {
                AddEmptyRegions(result, state, IndentOf(null));
            }

            return result;
        }

        private static bool IsLayoutField(Entry entry) => entry is MemberEntry { Info.IsLayoutField: true };

        /// <summary>Inserts the regions that are kept even when empty, each before the first entry of a later region.</summary>
        private void AddEmptyRegions(List<Entry> entries, State state, string indent)
        {
            var pointer = 0;
            foreach (var name in _namer.AllPossibleNames())
            {
                var found = -1;
                for (var index = pointer; index < entries.Count; index++)
                {
                    if (RegionNameOfEntry(entries[index]) == name)
                    {
                        found = index;
                        break;
                    }
                }

                if (found >= 0)
                {
                    pointer = found + 1;
                    continue;
                }

                entries.Insert(pointer, CreateRegion(name, [], indent));
                pointer++;
                state.Mutated = true;
            }
        }

        private RegionEntry CreateRegion(string name, List<Entry> children, string indent)
        {
            var firstBlank = children.Count > 0 ? children[0].Blank : 0;
            var lastBlankAfter = children.Count > 0 ? children[^1].BlankAfter : 0;
            var wrapped = children.Select((child, index) =>
            {
                if (index != 0)
                {
                    return child;
                }

                var copy = child.Clone();
                copy.Blank = 0;
                copy.MoveBlank = 0;

                return copy;
            }).ToList();

            return new RegionEntry
            {
                Name = name,
                StartText = $"{indent}#region {name}",
                EndText = $"{indent}#endregion{(_cleanup.UpdateEndRegionDirectives ? $" {name}" : string.Empty)}",
                Children = wrapped,
                HeadBlank = wrapped.Count > 0 && _cleanup.AfterRegionTags ? 1 : 0,
                TailBlank = wrapped.Count > 0 && _cleanup.BeforeEndRegionTags ? 1 : 0,
                Blank = firstBlank,
                BlankAfter = lastBlankAfter,
                Level = -1,
                Index = -1,
            };
        }

        /// <summary>One level deeper than the line of the type, for a body that has no member to copy the indentation from.</summary>
        private string MemberIndent(ContainerPlan plan)
        {
            var outer = TypeIndent(plan);

            return outer + (outer.Contains('\t') ? "\t" : "    ");
        }

        /// <summary>The indentation of the line the type is declared on (of its attributes, for a type with some).</summary>
        private string TypeIndent(ContainerPlan plan)
        {
            var start = plan.Node.SpanStart;
            var header = start == 0 ? 0 : Source.LastIndexOf('\n', start - 1) + 1;
            var end = header;
            while (end < Source.Length && Source[end] is ' ' or '\t')
            {
                end++;
            }

            return Source[header..end];
        }

        // ------------------------------------------------------------------ sorting

        private List<Entry> SortLevel(List<Entry> entries, State state)
        {
            var result = new List<Entry>();
            var run = new List<Entry>();

            void Flush()
            {
                result.AddRange(SortRun(run, state));
                run = [];
            }

            foreach (var entry in entries)
            {
                var sorted = entry;
                if (entry is RegionEntry region)
                {
                    var copy = (RegionEntry)region.Clone();
                    copy.Children = SortLevel(region.Children, state);
                    sorted = copy;
                }

                if (sorted is FixedEntry { Barrier: true })
                {
                    Flush();
                    result.Add(sorted);
                }
                else
                {
                    run.Add(sorted);
                }
            }

            Flush();

            return result;
        }

        /// <summary>Puts the members of a run in their order; everything else (regions, comments) stays in its slot.</summary>
        private List<Entry> SortRun(List<Entry> run, State state)
        {
            var slots = run.Select((entry, index) => (entry, index)).Where(item => item.entry is MemberEntry).Select(item => item.index).ToList();
            var members = slots.Select(slot => (MemberEntry)run[slot]).ToList();
            var ordered = OrderMembers(members);

            if (ordered.Select((member, index) => ReferenceEquals(member, members[index])).All(same => same))
            {
                return run;
            }

            state.Mutated = true;
            var result = new List<Entry>(run);
            for (var i = 0; i < slots.Count; i++)
            {
                result[slots[i]] = ordered[i];
            }

            return result;
        }

        /// <summary>
        /// The members in the configured order, except that members whose initializers depend on the declaration order
        /// keep their relative order: the wanted order is followed as far as those constraints allow.
        /// </summary>
        private List<MemberEntry> OrderMembers(List<MemberEntry> members)
        {
            var keys = members.Select((member, index) => SortableOf(member.Info, index)).ToList();
            var wanted = Enumerable.Range(0, members.Count).ToList();
            wanted.Sort((a, b) => _comparer.Compare(keys[a], keys[b]));

            var predecessors = OrderConstraints(members);
            var placed = new HashSet<int>();
            var remaining = new List<int>(wanted);
            var ordered = new List<MemberEntry>();

            while (remaining.Count > 0)
            {
                var next = remaining.FindIndex(candidate => !predecessors.TryGetValue(candidate, out var before) || before.All(placed.Contains));
                var index = remaining[next];
                remaining.RemoveAt(next);
                placed.Add(index);
                ordered.Add(members[index]);
            }

            return ordered;
        }

        // ------------------------------------------------------------------ output

        private string Assemble(ContainerPlan plan, BuiltEntries built, List<Entry> entries)
        {
            if (built.Entries.Count == 0)
            {
                // A body without members that gets regions: they go on lines of their own between the braces.
                return _eol + Emit(entries) + _eol + TypeIndent(plan);
            }

            var lineStart = built.Start == 0 ? 0 : Source.LastIndexOf('\n', built.Start - 1) + 1;

            return Source[plan.BodyStart..lineStart] + Emit(entries) + Source[built.End..plan.BodyEnd];
        }

        private string Emit(IReadOnlyList<Entry> entries)
        {
            var result = new StringBuilder();
            for (var index = 0; index < entries.Count; index++)
            {
                if (index > 0)
                {
                    result.Insert(result.Length, _eol, 1 + Gap(entries[index - 1], entries[index]));
                }

                result.Append(TextOf(entries[index]));
            }

            return result.ToString();
        }

        private string TextOf(Entry entry)
        {
            if (entry is not RegionEntry region)
            {
                return entry.Text;
            }

            if (region.Children.Count == 0)
            {
                return region.StartText + _eol + region.EndText;
            }

            return region.StartText + Repeat(_eol, 1 + region.HeadBlank) + Emit(region.Children) + Repeat(_eol, 1 + region.TailBlank) + region.EndText;
        }

        private static string Repeat(string text, int count) => new StringBuilder().Insert(0, text, count).ToString();

        /// <summary>Blank lines between two entries: kept where they were adjacent before, padded per the cleanup settings where they are new neighbours.</summary>
        private int Gap(Entry previous, Entry current)
        {
            if (previous.Level == current.Level && current.Index == previous.Index + 1)
            {
                return current.Blank;
            }

            var inherited = current is not MemberEntry ? current.Blank : previous is not MemberEntry ? previous.BlankAfter : current.MoveBlank;
            var padded = PaddingAfter(previous) || PaddingBefore(current);

            return Math.Max(inherited, padded ? 1 : 0);
        }

        private bool PaddingBefore(Entry entry) => entry switch
        {
            MemberEntry member => _cleanup.PaddingOf(member.Info).Before,
            RegionEntry => _cleanup.BeforeRegionTags,
            FixedEntry { Marker: RegionMarker.RegionStart } => _cleanup.BeforeRegionTags,
            FixedEntry { Marker: RegionMarker.RegionEnd } => _cleanup.BeforeEndRegionTags,
            _ => false,
        };

        private bool PaddingAfter(Entry entry) => entry switch
        {
            MemberEntry member => _cleanup.PaddingOf(member.Info).After,
            RegionEntry => _cleanup.AfterEndRegionTags,
            FixedEntry { Marker: RegionMarker.RegionStart } => _cleanup.AfterRegionTags,
            FixedEntry { Marker: RegionMarker.RegionEnd } => _cleanup.AfterEndRegionTags,
            _ => false,
        };

        // ------------------------------------------------------------------ helpers

        /// <summary>
        /// <c>ShouldReorganizeChildren</c>: attributes that say the order of the members matters (layout of a struct,
        /// vtable of a COM interface). <c>LayoutKind.Auto</c> lets the runtime choose the layout.
        /// </summary>
        private static bool HasFixedLayout(MemberDeclarationSyntax node) =>
            node.AttributeLists.SelectMany(list => list.Attributes).Any(attribute =>
                ComAttributes.Contains(AttributeName(attribute)) || (LayoutAttributes.Contains(AttributeName(attribute)) && !IsAutoLayout(attribute)));

        /// <summary>A struct without <c>[StructLayout(LayoutKind.Auto)]</c> is laid out in the order of its instance fields.</summary>
        private static bool HasAutoLayout(SyntaxNode node) =>
            node is MemberDeclarationSyntax member
            && member.AttributeLists.SelectMany(list => list.Attributes).Any(attribute => LayoutAttributes.Contains(AttributeName(attribute)) && IsAutoLayout(attribute));

        private static bool IsAutoLayout(AttributeSyntax attribute) =>
            attribute.ArgumentList?.Arguments.FirstOrDefault() is { NameEquals: null, NameColon: null } argument && AutoLayout().IsMatch(argument.Expression.ToString());

        /// <summary><c>global::System.Runtime.InteropServices.StructLayout</c> -> <c>StructLayout</c> (also when qualified).</summary>
        private static string AttributeName(AttributeSyntax attribute)
        {
            var name = attribute.Name switch
            {
                QualifiedNameSyntax qualified => qualified.Right.Identifier.ValueText,
                AliasQualifiedNameSyntax alias => alias.Name.Identifier.ValueText,
                SimpleNameSyntax simple => simple.Identifier.ValueText,
                _ => attribute.Name.ToString(),
            };
            var full = Whitespace().Replace(attribute.Name.ToString(), string.Empty).Replace("global::", string.Empty, StringComparison.Ordinal);

            return full == name || full == $"System.Runtime.InteropServices.{name}" ? name : full;
        }

        /// <summary>The indentation of the first line of code of an entry (a <c>#if</c> block starts with a directive, which has none).</summary>
        private static string IndentationOf(string text)
        {
            var line = text.Split('\n').FirstOrDefault(candidate => !candidate.TrimStart().StartsWith('#'));
            if (line is null)
            {
                return string.Empty;
            }

            var end = 0;
            while (end < line.Length && line[end] is ' ' or '\t')
            {
                end++;
            }

            return line[..end];
        }

        private static SortableMember SortableOf(MemberInfo info, int offset) =>
            new(info.Kind, info.Name, info.Access, info.IsStatic, info.IsConstant, info.IsReadOnly, info.IsExplicitInterface, offset);

        /// <summary>
        /// For each member, the members declared before it that must stay before it: initializers that depend on
        /// declaration order, parts of the same partial type, and the instance fields of a struct (its layout).
        /// </summary>
        private static Dictionary<int, List<int>> OrderConstraints(List<MemberEntry> members)
        {
            var constraints = new Dictionary<int, List<int>>();
            var bearing = members
                .Select((member, index) => (member, index))
                .Where(item => !item.member.Info.Init.IsNone || item.member.Info.PartialTypes.Count > 0 || item.member.Info.IsLayoutField)
                .Select(item => item.index)
                .ToList();

            for (var position = 0; position < bearing.Count; position++)
            {
                var second = bearing[position];
                var b = members[second].Info;
                for (var earlier = 0; earlier < position; earlier++)
                {
                    var first = bearing[earlier];
                    var a = members[first].Info;
                    if (InitInfo.MustKeepOrder(a.Init, b.Init) || b.PartialTypes.Overlaps(a.PartialTypes) || (a.IsLayoutField && b.IsLayoutField))
                    {
                        if (!constraints.TryGetValue(second, out var list))
                        {
                            constraints[second] = list = [];
                        }

                        list.Add(first);
                    }
                }
            }

            return constraints;
        }

        private static string? RegionNameOfEntry(Entry entry) => entry switch
        {
            RegionEntry region => region.Name,
            FixedEntry { Marker: RegionMarker.RegionStart } marker => EntryBuilder.RegionName(marker.Text),
            _ => null,
        };

        /// <summary>Replaces each region by its <c>#region</c> line, its entries and its <c>#endregion</c> line, so entries can be sorted across regions.</summary>
        private static List<Entry> FlattenRegions(IEnumerable<Entry> entries) =>
            entries.SelectMany(entry =>
            {
                if (entry is not RegionEntry region)
                {
                    return [entry];
                }

                var start = new FixedEntry { Marker = RegionMarker.RegionStart, Text = region.StartText, Blank = region.Blank, BlankAfter = region.HeadBlank, Level = region.Level, Index = region.Index };
                var end = new FixedEntry { Marker = RegionMarker.RegionEnd, Text = region.EndText, Blank = region.TailBlank, BlankAfter = region.BlankAfter, Level = region.Level, Index = region.Index };
                var children = FlattenRegions(region.Children).Select((child, index) =>
                {
                    if (index != 0)
                    {
                        return child;
                    }

                    var copy = child.Clone();
                    copy.Blank = region.HeadBlank;
                    copy.MoveBlank = 0;

                    return copy;
                });

                return (IEnumerable<Entry>)[start, .. children, end];
            }).ToList();

        /// <summary>The inverse of <see cref="FlattenRegions"/>: the entries between a pair of region markers become the children of a region again.</summary>
        private static List<Entry> UnflattenRegions(IEnumerable<Entry> entries)
        {
            var root = new List<Entry>();
            var open = new Stack<(FixedEntry Start, List<Entry> Children)>();

            foreach (var entry in entries)
            {
                var target = open.Count > 0 ? open.Peek().Children : root;

                if (entry is FixedEntry { Marker: RegionMarker.RegionStart } start)
                {
                    open.Push((start, []));
                }
                else if (entry is FixedEntry { Marker: RegionMarker.RegionEnd } end)
                {
                    var (regionStart, children) = open.Pop();
                    var parent = open.Count > 0 ? open.Peek().Children : root;
                    parent.Add(new RegionEntry
                    {
                        Name = EntryBuilder.RegionName(regionStart.Text),
                        StartText = regionStart.Text,
                        EndText = end.Text,
                        Children = children,
                        HeadBlank = regionStart.BlankAfter,
                        TailBlank = end.Blank,
                        Blank = regionStart.Blank,
                        BlankAfter = end.BlankAfter,
                        Level = regionStart.Level,
                        Index = regionStart.Index,
                    });
                }
                else
                {
                    target.Add(entry);
                }
            }

            return root;
        }

        /// <summary>The children of a region that goes away, in the place of the region.</summary>
        private static IEnumerable<Entry> LiftChildren(RegionEntry region) =>
            region.Children.Select((child, index) =>
            {
                var lifted = child.Clone();
                if (index == 0)
                {
                    lifted.Blank = region.Blank;
                    lifted.MoveBlank = region.Blank;
                }

                if (index == region.Children.Count - 1)
                {
                    lifted.BlankAfter = region.BlankAfter;
                }

                return lifted;
            });

        /// <summary>The safety net: a reorganized body holds exactly the lines of the original (moved, never edited), apart from blank lines and region directives.</summary>
        private static bool SameContent(string before, string after)
        {
            static List<string> Lines(string text) => text
                .Split('\n')
                .Select(line => line.TrimEnd('\r').Trim())
                .Where(line => line.Length > 0 && !RegionLine().IsMatch(line))
                .OrderBy(line => line, StringComparer.Ordinal)
                .ToList();

            return Lines(before).SequenceEqual(Lines(after), StringComparer.Ordinal);
        }

        /// <summary>Conditional and region directives that were properly nested must stay so.</summary>
        private static bool DirectivesStayBalanced(string before, string after) =>
            new[] { (IfLine(), EndIfLine()), (RegionOpenLine(), EndRegionLine()) }
                .All(pair => !IsBalanced(before, pair.Item1, pair.Item2) || IsBalanced(after, pair.Item1, pair.Item2));

        private static bool IsBalanced(string text, Regex open, Regex close)
        {
            var depth = 0;
            foreach (var line in text.Split('\n'))
            {
                if (open.IsMatch(line))
                {
                    depth++;
                }
                else if (close.IsMatch(line) && --depth < 0)
                {
                    return false;
                }
            }

            return depth == 0;
        }

        [GeneratedRegex(@"^#\s*(end)?region\b")]
        private static partial Regex RegionLine();

        [GeneratedRegex(@"^[ \t]*#\s*if\b")]
        private static partial Regex IfLine();

        [GeneratedRegex(@"^[ \t]*#\s*endif\b")]
        private static partial Regex EndIfLine();

        [GeneratedRegex(@"^[ \t]*#\s*region\b")]
        private static partial Regex RegionOpenLine();

        [GeneratedRegex(@"^[ \t]*#\s*endregion\b")]
        private static partial Regex EndRegionLine();

        [GeneratedRegex(@"^(global\s*::\s*)?(System\.Runtime\.InteropServices\.)?LayoutKind\s*\.\s*Auto$")]
        private static partial Regex AutoLayout();

        [GeneratedRegex(@"\s+")]
        private static partial Regex Whitespace();

        private sealed class State
        {
            public bool Mutated { get; set; }
        }
    }
}
