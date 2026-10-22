using System.Text.RegularExpressions;
using CodeJanitor.Engine.Contracts;
using CodeJanitor.Engine.Pipeline;
using CodeJanitor.Engine.Settings;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace CodeJanitor.Engine.Diagnostics;

/// <summary>
/// The Roslyn rules of the file: what its <c>.editorconfig</c> enforces, the Code Style rules and the settings applied through
/// Roslyn rules (<see cref="EffectiveSettings.AnalyzerConfigOverrides"/>), fixed with the Roslyn code fixes of the IDE, SDK
/// and NuGet analyzers (<see cref="DiagnosticCleanupEngine"/>). Naming runs first and formatting last.
/// </summary>
public sealed partial class RoslynRulesStep : IRuleReportingStep, IAnalyzingStep
{
    private const string AccessModifiersRule = "IDE0040";
    private const string NamingRule = "IDE1006";
    private const string UnnecessaryUsingsRule = "IDE0005";
    private const string NamespaceRule = "IDE0130";
    private const string MethodGroupRule = "IDE0200";
    private const string MethodGroupOption = "csharp_style_prefer_method_group_conversion";
    private const string UsingPlacementRule = "IDE0065";
    private const string PopulateSwitchDetail = "not fixed: populating the switch adds cases that throw NotImplementedException, add them yourself.";
    private const string UsingPlacementDetail = "not moved: preprocessor directives around the using directives make the move unsafe.";
    private const string NamespaceDetail = "not fixed: cleanup does not move types to another namespace, run Fix Namespace.";

    /// <summary>
    /// The boolean Code Style rules whose Roslyn analyzer always reports at its descriptor's default severity (hidden) and
    /// ignores the severity of its option: the diagnostics are actionable when the rule is enforced with <c>true</c>.
    /// </summary>
    private static readonly Dictionary<string, string> HiddenReportingRules = new(StringComparer.Ordinal)
    {
        ["IDE0320"] = "csharp_prefer_static_anonymous_function",
    };

    private static readonly DiagnosticCleanupCategory[][] Phases =
    [
        [DiagnosticCleanupCategory.Naming],
        [DiagnosticCleanupCategory.CodeStyle, DiagnosticCleanupCategory.AnalyzerFixes],
        [DiagnosticCleanupCategory.Formatting],
    ];

    private static readonly DiagnosticCleanupEngine Engine = new();

    /// <inheritdoc/>
    public string Name => ".editorconfig and Roslyn rules";

    /// <inheritdoc/>
    public string? RuleId => null;

    /// <inheritdoc/>
    public CleanupStage Stage => CleanupStage.Diagnostics;

    /// <inheritdoc/>
    public int Order => 0;

    /// <inheritdoc/>
    public bool IsEnabled(IEffectiveSettings settings) => true;

    /// <inheritdoc/>
    public bool OwnsRule(string ruleId) => DiagnosticId().IsMatch(ruleId);

    /// <inheritdoc/>
    public async Task<Solution> ApplyAsync(Document document, IEffectiveSettings settings, CancellationToken cancellationToken)
    {
        var effective = settings as EffectiveSettings ?? throw new ArgumentException($"{Name} needs the {nameof(EffectiveSettings)} of the file.", nameof(settings));

        return (await RunAsync(document, effective, StepRunOptions.All, cancellationToken).ConfigureAwait(false)).Solution;
    }

    /// <inheritdoc/>
    Task<StepRun> IRuleReportingStep.RunAsync(Document document, EffectiveSettings settings, StepRunOptions options, CancellationToken cancellationToken) =>
        RunAsync(document, settings, options, cancellationToken);

    /// <inheritdoc/>
    Task<IReadOnlyList<EngineDiagnostic>> IAnalyzingStep.AnalyzeAsync(Document document, EffectiveSettings settings, CancellationToken cancellationToken) =>
        AnalyzeAsync(document, settings, cancellationToken);

    internal async Task<StepRun> RunAsync(Document document, EffectiveSettings settings, StepRunOptions options, CancellationToken cancellationToken)
    {
        var whole = await RunPhasesAsync(document, settings, options, cancellationToken).ConfigureAwait(false);
        if (options.ChangedLines is not { } changedLines)
        {
            return whole.ToStepRun();
        }

        var before = (await document.GetTextAsync(cancellationToken).ConfigureAwait(false)).ToString();
        var kept = await KeepChangedLinesAsync(document, settings, options, before, whole, changedLines, cancellationToken).ConfigureAwait(false);
        if (kept is not null)
        {
            return kept;
        }

        // Rule by rule: the rules whose changes stay on changed lines still apply.
        var current = document;
        var lines = changedLines;
        var rules = whole.Rules.Where(rule => !rule.Included).ToList();
        var issues = new List<string>(whole.Issues);
        foreach (var rule in whole.Rules.Where(rule => rule.Included && rule.Changes > 0))
        {
            var ruleOptions = options with { OnlyRule = rule.Id, ChangedLines = lines };
            var currentText = (await current.GetTextAsync(cancellationToken).ConfigureAwait(false)).ToString();
            var single = await RunPhasesAsync(current, settings, ruleOptions, cancellationToken).ConfigureAwait(false);
            var ruleKept = await KeepChangedLinesAsync(current, settings, ruleOptions, currentText, single, lines, cancellationToken).ConfigureAwait(false);
            if (ruleKept is null)
            {
                issues.Add($"{rule.Id}: not applied, its changes span lines not changed since the last commit (codeJanitor.cleanup.onlyChangedLines).");
                rules.Add(rule with { Changes = 0 });
                continue;
            }

            rules.AddRange(ruleKept.Rules.Where(outcome => outcome.Included));
            var keptText = (await ruleKept.Solution.GetDocument(document.Id)!.GetTextAsync(cancellationToken).ConfigureAwait(false)).ToString();
            lines = ChangedLines.Renumber(lines, LineDiff.Hunks(currentText, keptText));
            current = ruleKept.Solution.GetDocument(document.Id)!;
        }

        return new StepRun(current.Project.Solution, rules, whole.Unresolved, issues) { Failures = whole.Failures };
    }

    internal async Task<IReadOnlyList<EngineDiagnostic>> AnalyzeAsync(Document document, EffectiveSettings settings, CancellationToken cancellationToken)
    {
        var diagnostics = new List<EngineDiagnostic>();
        foreach (var phase in Phases)
        {
            var options = CreateOptions(phase, settings, StepRunOptions.All, null);
            foreach (var analyzed in await Engine.AnalyzeAsync(document, options, cancellationToken).ConfigureAwait(false))
            {
                var span = analyzed.Diagnostic.Location.GetLineSpan();
                diagnostics.Add(new EngineDiagnostic(
                    analyzed.Diagnostic.Id,
                    analyzed.Unresolved is { Reason: UnresolvedDiagnosticReason.NotApplied } unresolved
                        ? $"{analyzed.Diagnostic.GetMessage()}; {unresolved.Detail}"
                        : analyzed.Diagnostic.GetMessage(),
                    SeverityName(analyzed.Diagnostic.Severity),
                    span.StartLinePosition.Line,
                    span.StartLinePosition.Character,
                    span.EndLinePosition.Line,
                    span.EndLinePosition.Character,
                    analyzed.Fixable,
                    string.IsNullOrEmpty(analyzed.Diagnostic.Descriptor.HelpLinkUri) ? null : analyzed.Diagnostic.Descriptor.HelpLinkUri));
            }
        }

        return diagnostics;
    }

    /// <summary>The <c>.editorconfig</c> severity name of a reported severity.</summary>
    internal static string SeverityName(DiagnosticSeverity severity) => severity switch
    {
        DiagnosticSeverity.Error => "error",
        DiagnosticSeverity.Warning => "warning",
        DiagnosticSeverity.Info => "suggestion",
        _ => "silent",
    };

    /// <summary>Why a diagnostic was not fixed, for the output channel.</summary>
    internal static string ReasonText(UnresolvedRoslynDiagnostic unresolved) => unresolved.Reason switch
    {
        UnresolvedDiagnosticReason.NoCodeFixProvider => "no code fix is available, so it was not fixed automatically" + (unresolved.Detail.Length == 0 ? string.Empty : $" ({unresolved.Detail})"),
        UnresolvedDiagnosticReason.NoApplicableCodeAction => "no automatic fix applies here",
        UnresolvedDiagnosticReason.FixRejectedIntroducesCompilerErrors => "not fixed: the fix would add a compiler error",
        UnresolvedDiagnosticReason.FixRejectedUnsupportedChanges => "not fixed: the fix changes more than the text of documents",
        UnresolvedDiagnosticReason.NotConverged => "not fixed: the fixes did not converge",
        UnresolvedDiagnosticReason.FixProviderFailed => $"not fixed: the code fix failed ({unresolved.Detail})",
        UnresolvedDiagnosticReason.NotApplied => unresolved.Detail,
        _ => unresolved.Reason.ToString(),
    };

    private async Task<StepRun?> KeepChangedLinesAsync(Document document, EffectiveSettings settings, StepRunOptions options, string before, PhaseRun run, IReadOnlySet<int> changedLines, CancellationToken cancellationToken)
    {
        if (run.ChangesOtherDocuments)
        {
            return null;
        }

        var after = (await run.Solution.GetDocument(document.Id)!.GetTextAsync(cancellationToken).ConfigureAwait(false)).ToString();
        var encoding = (await document.GetTextAsync(cancellationToken).ConfigureAwait(false)).Encoding;
        var kept = await ChangedLines.KeepAsync(document, before, after, changedLines, async text =>
        {
            var redone = await RunPhasesAsync(document.WithText(SourceText.From(text, encoding)), settings, options, cancellationToken).ConfigureAwait(false);

            return (await redone.Solution.GetDocument(document.Id)!.GetTextAsync(cancellationToken).ConfigureAwait(false)).ToString();
        }, cancellationToken).ConfigureAwait(false);
        if (kept is null)
        {
            return null;
        }

        var solution = kept.Value.Text == after ? run.Solution : document.Project.Solution.WithDocumentText(document.Id, SourceText.From(kept.Value.Text, encoding));

        return new StepRun(solution, run.Rules, run.Unresolved, run.Issues) { Failures = run.Failures };
    }

    private static async Task<PhaseRun> RunPhasesAsync(Document document, EffectiveSettings settings, StepRunOptions options, CancellationToken cancellationToken)
    {
        var original = document.Project.Solution;
        var solution = original;
        var counts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        var order = new List<string>();
        var unresolved = new List<UnresolvedDiagnostic>();
        var failures = new List<string>();
        var originalUsings = await KeptUsingsAsync(document, settings.GetList("usingStatementsToReinsertWhenRemoved"), cancellationToken).ConfigureAwait(false);
        var changedLines = options.ChangedLines;

        foreach (var phase in Phases)
        {
            var current = solution.GetDocument(document.Id)!;
            var result = await Engine.CleanupAsync(current, CreateOptions(phase, settings, options, current), cancellationToken).ConfigureAwait(false);
            foreach (var fix in result.AppliedFixes)
            {
                if (counts.TryAdd(fix.DiagnosticId, 0))
                {
                    order.Add(fix.DiagnosticId);
                }

                counts[fix.DiagnosticId] += fix.Count;
            }

            if (changedLines is not null)
            {
                var before = (await current.GetTextAsync(cancellationToken).ConfigureAwait(false)).ToString();
                var after = (await result.ChangedSolution.GetDocument(document.Id)!.GetTextAsync(cancellationToken).ConfigureAwait(false)).ToString();
                changedLines = ChangedLines.Renumber(changedLines, LineDiff.Hunks(before, after));
            }

            unresolved.AddRange(result.Unresolved
                .Where(item => changedLines is null || changedLines.Contains(item.Line - 1))
                .Select(item => new UnresolvedDiagnostic(item.DiagnosticId, item.Message, SeverityName(item.Severity), item.Line, item.Column, ReasonText(item))));
            failures.AddRange(result.AnalyzerFailures.Where(failure => !failures.Contains(failure)));
            solution = result.ChangedSolution;
        }

        if (originalUsings.Count > 0 && counts.ContainsKey(UnnecessaryUsingsRule))
        {
            solution = await ReinsertUsingsAsync(solution, document.Id, originalUsings, cancellationToken).ConfigureAwait(false);
        }

        if (!ReferenceEquals(solution, original))
        {
            solution = await KeepBlankLineAfterFileScopedNamespaceAsync(document, solution, cancellationToken).ConfigureAwait(false);
        }

        var rules = order.Select(id => new RuleOutcome(id, id, counts[id], Included: true))
            .Concat(options.ExcludedRules.Where(id => DiagnosticId().IsMatch(id)).Select(id => new RuleOutcome(id, id, 0, Included: false)))
            .ToList();
        var changesOther = solution.GetChanges(original).GetProjectChanges()
            .SelectMany(changes => changes.GetChangedDocuments(onlyGetDocumentsWithTextChanges: true))
            .Any(id => id != document.Id && original.GetDocument(id)?.FilePath != document.FilePath);

        return new PhaseRun(solution, rules, unresolved, [], failures, changesOther);
    }

    private static DiagnosticCleanupOptions CreateOptions(DiagnosticCleanupCategory[] categories, EffectiveSettings settings, StepRunOptions options, Document? _)
    {
        var accessModifiersBySetting = !settings.EditorConfigKeys.ContainsKey(RepositoryPolicy.InsertExplicitAccessModifierKeys[0]);
        var renameAcrossWorkspace = !options.KeepOtherFiles && settings.GetBool("renamePublicSymbolsAcrossWorkspace");
        var changedLines = options.ChangedLines;
        var keepsLambdas = OptionValue(settings, MethodGroupOption) is { } methodGroups && string.Equals(methodGroups, "false", StringComparison.OrdinalIgnoreCase);
        var enforcedHiddenRules = HiddenReportingRules
            .Where(rule => IsEnforcedTrue(settings, rule.Value))
            .Select(rule => rule.Key)
            .ToHashSet(StringComparer.Ordinal);

        return new DiagnosticCleanupOptions(
            categories,
            analyzerConfigOverrides: settings.AnalyzerConfigOverrides,
            diagnosticIds: options.OnlyRule is null ? null : [options.OnlyRule],
            excludedDiagnosticIds: options.ExcludedRules,
            filter: diagnostic =>
            {
                var line = diagnostic.Location.GetLineSpan().StartLinePosition.Line;
                if (options.OnlyLine is { } onlyLine && line != onlyLine)
                {
                    return false;
                }

                if ((diagnostic.Id == NamingRule && changedLines is not null && !changedLines.Contains(line))
                    || (diagnostic.Id == MethodGroupRule && keepsLambdas))
                {
                    return false;
                }

                return !(diagnostic.Id == AccessModifiersRule && accessModifiersBySetting) || IsAccessModifierKindEnabled(diagnostic, settings);
            },
            gate: (document, diagnostic, cancellationToken) =>
            {
                if (diagnostic.Id == NamespaceRule)
                {
                    return Task.FromResult<string?>(NamespaceDetail);
                }

                if (diagnostic.Id is "IDE0010" or "IDE0072")
                {
                    return Task.FromResult<string?>(PopulateSwitchDetail);
                }

                if (diagnostic.Id == UsingPlacementRule && HasDirectivesAroundUsings(diagnostic))
                {
                    return Task.FromResult<string?>(UsingPlacementDetail);
                }

                if (diagnostic.Id != NamingRule)
                {
                    return Task.FromResult<string?>(null);
                }

                if (changedLines is not null)
                {
                    return Task.FromResult<string?>(NamingRenameScope.ChangedLinesDetail);
                }

                return renameAcrossWorkspace ? Task.FromResult<string?>(null) : NamingRenameScope.WhyNotRenamedAsync(document, diagnostic, cancellationToken);
            },
            enforced: diagnostic => enforcedHiddenRules.Contains(diagnostic.Id));
    }

    /// <summary>Whether a Code Style rule applies with the value <c>true</c>: a user rule, or one <c>.editorconfig</c> enforces.</summary>
    private static bool IsEnforcedTrue(EffectiveSettings settings, string key)
    {
        var value = settings.CodeStyleValues.TryGetValue(key, out var user) ? user
            : settings.CodeStyleEditorConfigKeys.ContainsKey(key) ? OptionValue(settings, key)
            : null;

        return string.Equals(value, "true", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// The value an option has for the analyzers: the override the settings apply, else the <c>.editorconfig</c> value, without
    /// its severity suffix. Roslyn's IDE0200 analyzer reads only the severity of <c>csharp_style_prefer_method_group_conversion</c>
    /// and reports even when the value is <c>false</c>, which asks to keep the lambdas.
    /// </summary>
    private static string? OptionValue(EffectiveSettings settings, string key)
    {
        var raw = settings.AnalyzerConfigOverrides.TryGetValue(key, out var overridden) ? overridden : settings.EditorConfigValue(key);

        return raw?.Split(':')[0].Trim();
    }

    /// <summary>
    /// Whether a preprocessor directive (<c>#if</c>, <c>#pragma</c>, <c>#region</c>, ...) sits among the using directives of the
    /// container IDE0065 reports on: moving them would split the directive from the code it governs.
    /// </summary>
    private static bool HasDirectivesAroundUsings(Diagnostic diagnostic)
    {
        var tree = diagnostic.Location.SourceTree;
        var node = tree?.GetRoot().FindToken(diagnostic.Location.SourceSpan.Start).Parent;
        var container = node?.AncestorsAndSelf().FirstOrDefault(ancestor => ancestor is BaseNamespaceDeclarationSyntax or CompilationUnitSyntax);
        var usings = container switch
        {
            BaseNamespaceDeclarationSyntax namespaceDeclaration => namespaceDeclaration.Usings,
            CompilationUnitSyntax unit => unit.Usings,
            _ => default,
        };
        if (usings.Count == 0)
        {
            return false;
        }

        var lastToken = usings.Last().GetLastToken();

        return usings.Any(directive => directive.GetLeadingTrivia().Any(trivia => trivia.IsDirective))
            || lastToken.TrailingTrivia.Any(trivia => trivia.IsDirective)
            || lastToken.GetNextToken().LeadingTrivia.Any(trivia => trivia.IsDirective);
    }

    /// <summary>Whether the per-kind <c>insertExplicitAccessModifiersOn*</c> setting of the declaration IDE0040 reports is on.</summary>
    private static bool IsAccessModifierKindEnabled(Diagnostic diagnostic, EffectiveSettings settings)
    {
        var tree = diagnostic.Location.SourceTree;
        if (tree is null)
        {
            return false;
        }

        var declaration = tree.GetRoot().FindToken(diagnostic.Location.SourceSpan.Start).Parent?.AncestorsAndSelf().OfType<MemberDeclarationSyntax>().FirstOrDefault();
        var setting = declaration switch
        {
            ClassDeclarationSyntax => "Classes",
            RecordDeclarationSyntax record => record.ClassOrStructKeyword.IsKind(SyntaxKind.StructKeyword) ? "Structs" : "Classes",
            StructDeclarationSyntax => "Structs",
            InterfaceDeclarationSyntax => "Interfaces",
            EnumDeclarationSyntax => "Enumerations",
            DelegateDeclarationSyntax => "Delegates",
            EventDeclarationSyntax or EventFieldDeclarationSyntax => "Events",
            FieldDeclarationSyntax => "Fields",
            PropertyDeclarationSyntax or IndexerDeclarationSyntax => "Properties",
            BaseMethodDeclarationSyntax => "Methods",
            _ => null,
        };

        return setting is not null && settings.GetBool("insertExplicitAccessModifiersOn" + setting);
    }

    /// <summary>
    /// The using directives of <c>usingStatementsToReinsertWhenRemoved</c> the document has, each with the directives of its
    /// container in their original order, to put it back at the place it had.
    /// </summary>
    internal static async Task<IReadOnlyList<KeptUsing>> KeptUsingsAsync(Document document, IReadOnlyList<string> reinsert, CancellationToken cancellationToken)
    {
        var keep = reinsert.Select(Normalize).Where(text => text.Length > 0).ToHashSet(StringComparer.Ordinal);
        if (keep.Count == 0 || await document.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false) is not { } root)
        {
            return [];
        }

        var kept = new List<KeptUsing>();
        foreach (var container in root.DescendantNodesAndSelf().Where(node => node is CompilationUnitSyntax or BaseNamespaceDeclarationSyntax))
        {
            var siblings = UsingsOf(container).Select(directive => Normalize(directive.ToString())).ToList();
            for (var index = 0; index < siblings.Count; index++)
            {
                if (keep.Contains(siblings[index]))
                {
                    kept.Add(new KeptUsing(ContainerKey(container), siblings, index));
                }
            }
        }

        return kept;
    }

    /// <summary>
    /// Puts back the using directives of <c>usingStatementsToReinsertWhenRemoved</c> the fixes removed as unnecessary (IDE0005):
    /// in the container they were in, after the directive that preceded them, with the line ending of the file.
    /// </summary>
    internal static async Task<Solution> ReinsertUsingsAsync(Solution solution, DocumentId documentId, IReadOnlyList<KeptUsing> kept, CancellationToken cancellationToken)
    {
        var document = solution.GetDocument(documentId)!;
        if (await document.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false) is not CompilationUnitSyntax root)
        {
            return solution;
        }

        var lineBreak = LineBreakOf((await document.GetTextAsync(cancellationToken).ConfigureAwait(false)).ToString());
        var changed = false;
        foreach (var group in kept.GroupBy(item => item.Container))
        {
            var container = root.DescendantNodesAndSelf().FirstOrDefault(node => (node is CompilationUnitSyntax or BaseNamespaceDeclarationSyntax) && ContainerKey(node) == group.Key) ?? root;
            var original = UsingsOf(container);
            var usings = original;
            var present = usings.Select(directive => Normalize(directive.ToString())).ToHashSet(StringComparer.Ordinal);
            foreach (var item in group)
            {
                var text = item.Siblings[item.Index];
                if (present.Contains(text) || SyntaxFactory.ParseCompilationUnit(text + "\n").Usings.FirstOrDefault() is not { } parsed)
                {
                    continue;
                }

                var previous = item.Siblings.Take(item.Index).LastOrDefault(present.Contains);
                var index = previous is null ? 0 : usings.TakeWhile(existing => Normalize(existing.ToString()) != previous).Count() + 1;
                usings = InsertUsing(IndentationOf(container, usings), usings, index, parsed, lineBreak);
                present.Add(text);
            }

            if (usings.Count == original.Count)
            {
                continue;
            }

            changed = true;
            if (original.Count == 0)
            {
                usings = SeparateFromMembers(container, usings, lineBreak);
            }

            var updated = WithUsings(container, usings);
            root = container == root ? (CompilationUnitSyntax)updated : root.ReplaceNode(container, updated);
        }

        return changed ? solution.WithDocumentSyntaxRoot(documentId, root) : solution;
    }

    private static SyntaxList<UsingDirectiveSyntax> InsertUsing(SyntaxTriviaList indentation, SyntaxList<UsingDirectiveSyntax> usings, int index, UsingDirectiveSyntax parsed, string lineBreak)
    {
        var directive = parsed.WithLeadingTrivia(indentation).WithTrailingTrivia(SyntaxFactory.EndOfLine(lineBreak));
        if (index == 0 && usings.Count > 0)
        {
            directive = directive.WithLeadingTrivia(usings[0].GetLeadingTrivia());
            usings = usings.Replace(usings[0], usings[0].WithLeadingTrivia(indentation));
        }

        return usings.Insert(index, directive);
    }

    /// <summary>Adds the blank line between the directives put into an empty container and its first member, unless the member starts with one.</summary>
    private static SyntaxList<UsingDirectiveSyntax> SeparateFromMembers(SyntaxNode container, SyntaxList<UsingDirectiveSyntax> usings, string lineBreak)
    {
        var next = MembersOf(container).FirstOrDefault()?.GetFirstToken();
        if (next is not { } token || token.LeadingTrivia.SkipWhile(trivia => trivia.IsKind(SyntaxKind.WhitespaceTrivia)).FirstOrDefault().IsKind(SyntaxKind.EndOfLineTrivia))
        {
            return usings;
        }

        var last = usings[^1];

        return usings.Replace(last, last.WithTrailingTrivia(last.GetTrailingTrivia().Add(SyntaxFactory.EndOfLine(lineBreak))));
    }

    private static SyntaxTriviaList IndentationOf(SyntaxNode container, SyntaxList<UsingDirectiveSyntax> usings)
    {
        var leading = usings.Count > 0 ? usings[0].GetLeadingTrivia() : MembersOf(container).FirstOrDefault()?.GetLeadingTrivia() ?? default;
        var whitespace = leading.LastOrDefault(trivia => trivia.IsKind(SyntaxKind.WhitespaceTrivia));

        return whitespace.IsKind(SyntaxKind.None) || container is CompilationUnitSyntax ? default : SyntaxFactory.TriviaList(whitespace);
    }

    private static SyntaxList<UsingDirectiveSyntax> UsingsOf(SyntaxNode container) => container switch
    {
        CompilationUnitSyntax unit => unit.Usings,
        BaseNamespaceDeclarationSyntax declaration => declaration.Usings,
        _ => default,
    };

    private static SyntaxList<MemberDeclarationSyntax> MembersOf(SyntaxNode container) => container switch
    {
        CompilationUnitSyntax unit => unit.Members,
        BaseNamespaceDeclarationSyntax declaration => declaration.Members,
        _ => default,
    };

    private static SyntaxNode WithUsings(SyntaxNode container, SyntaxList<UsingDirectiveSyntax> usings) => container switch
    {
        CompilationUnitSyntax unit => unit.WithUsings(usings),
        BaseNamespaceDeclarationSyntax declaration => declaration.WithUsings(usings),
        _ => container,
    };

    /// <summary>The full name of the namespace a container is, empty for the file level.</summary>
    private static string ContainerKey(SyntaxNode container) => string.Join(
        ".",
        container.AncestorsAndSelf().OfType<BaseNamespaceDeclarationSyntax>().Reverse().Select(declaration => declaration.Name.ToString()));

    private static string LineBreakOf(string text) => LineEndings.Uniform(text) ?? (text.Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n");

    /// <summary>
    /// Keeps the blank line after a file-scoped namespace declaration: moving the using directives out of it (IDE0065) takes
    /// the blank line that separated them from the first member along.
    /// </summary>
    private static async Task<Solution> KeepBlankLineAfterFileScopedNamespaceAsync(Document original, Solution solution, CancellationToken cancellationToken)
    {
        if (!HasBlankLineAfterFileScopedNamespace(await original.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false), out _))
        {
            return solution;
        }

        var document = solution.GetDocument(original.Id)!;
        var root = await document.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false);
        if (HasBlankLineAfterFileScopedNamespace(root, out var semicolon) || semicolon is not { } token || token.GetNextToken().IsKind(SyntaxKind.None))
        {
            return solution;
        }

        var text = await document.GetTextAsync(cancellationToken).ConfigureAwait(false);
        var line = text.Lines.GetLineFromPosition(token.Span.End);
        var lineBreak = text.ToString(TextSpan.FromBounds(line.End, line.EndIncludingLineBreak));

        return lineBreak.Length == 0 ? solution : solution.WithDocumentText(original.Id, text.WithChanges(new TextChange(new TextSpan(line.EndIncludingLineBreak, 0), lineBreak)));
    }

    private static bool HasBlankLineAfterFileScopedNamespace(SyntaxNode? root, out SyntaxToken? semicolon)
    {
        semicolon = null;
        if (root is not CompilationUnitSyntax unit || unit.Members.OfType<FileScopedNamespaceDeclarationSyntax>().FirstOrDefault() is not { } declaration)
        {
            return false;
        }

        semicolon = declaration.SemicolonToken;
        var next = declaration.SemicolonToken.GetNextToken();
        var tree = root.SyntaxTree;
        if (next.IsKind(SyntaxKind.None))
        {
            return false;
        }

        var semicolonLine = tree.GetLineSpan(declaration.SemicolonToken.Span).StartLinePosition.Line;
        var nextLine = tree.GetLineSpan(next.LeadingTrivia.FirstOrDefault(trivia => !trivia.IsKind(SyntaxKind.WhitespaceTrivia) && !trivia.IsKind(SyntaxKind.EndOfLineTrivia)) is { RawKind: not 0 } first ? first.Span : next.Span).StartLinePosition.Line;

        return nextLine - semicolonLine > 1;
    }

    private static string Normalize(string usingDirective) => Regex.Replace(usingDirective.Trim(), @"\s+", " ");

    [GeneratedRegex(@"^[A-Za-z]{2,}\d{3,}$")]
    private static partial Regex DiagnosticId();

    /// <summary>A directive to reinsert: where it was (the container and the directives of the container in order) and its index among them.</summary>
    internal sealed record KeptUsing(string Container, IReadOnlyList<string> Siblings, int Index);

    private sealed record PhaseRun(Solution Solution, IReadOnlyList<RuleOutcome> Rules, IReadOnlyList<UnresolvedDiagnostic> Unresolved, IReadOnlyList<string> Issues, IReadOnlyList<string> Failures, bool ChangesOtherDocuments)
    {
        public StepRun ToStepRun() => new StepRun(Solution, Rules, Unresolved, Issues) { Failures = Failures };
    }
}
