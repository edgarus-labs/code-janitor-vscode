#nullable disable
#pragma warning disable RS1010, RS1025, RS1026, RS2008 // Test analyzers and fixers: no release tracking, minimal registration on purpose.

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CodeActions;
using Microsoft.CodeAnalysis.CodeFixes;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Text;

// The analyzers below are test doubles handed to the workspace as instances. The analyzer-authoring rules about
// shipping compiler extensions (target framework, Workspaces reference, extended rules, release tracking) do not apply.
#pragma warning disable RS1036, RS1038, RS1041, RS2008

namespace CodeJanitor.Engine.Tests.Diagnostics;

/// <summary>
/// Test analyzer reporting every source field whose name starts with <c>legacy</c> (or a prefix chosen by the test),
/// once per configured rule. The diagnostic ids and descriptor categories are chosen per test so classification and
/// provider lookup are exercised without depending on any built-in analyzer.
/// </summary>
[DiagnosticAnalyzer(LanguageNames.CSharp)]
internal sealed class LegacyFieldAnalyzer : DiagnosticAnalyzer
{
    private readonly ImmutableArray<DiagnosticDescriptor> _descriptors;
    private readonly string _namePrefix;

    public LegacyFieldAnalyzer()
        : this("CJT0000", "Style")
    {
    }

    public LegacyFieldAnalyzer(string diagnosticId, string category)
        : this((diagnosticId, category))
    {
    }

    public LegacyFieldAnalyzer(params (string DiagnosticId, string Category)[] rules)
        : this("legacy", rules)
    {
    }

    public LegacyFieldAnalyzer(string namePrefix, params (string DiagnosticId, string Category)[] rules)
    {
        _namePrefix = namePrefix;
        _descriptors = rules
            .Select(rule => new DiagnosticDescriptor(
                rule.DiagnosticId,
                "Legacy field",
                "Field '{0}' uses the legacy prefix",
                rule.Category,
                DiagnosticSeverity.Warning,
                isEnabledByDefault: true))
            .ToImmutableArray();
    }

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => _descriptors;

    public override void Initialize(AnalysisContext context)
    {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
        context.EnableConcurrentExecution();
        context.RegisterSymbolAction(
            symbolContext =>
            {
                if (symbolContext.Symbol.Name.StartsWith(_namePrefix, System.StringComparison.Ordinal))
                {
                    foreach (DiagnosticDescriptor descriptor in _descriptors)
                    {
                        symbolContext.ReportDiagnostic(Diagnostic.Create(descriptor, symbolContext.Symbol.Locations[0], symbolContext.Symbol.Name));
                    }
                }
            },
            SymbolKind.Field);
    }
}

/// <summary>
/// Test analyzer that reports nothing and only counts analyzed syntax trees, proving whether analysis ran.
/// </summary>
[DiagnosticAnalyzer(LanguageNames.CSharp)]
internal sealed class AnalysisProbeAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Descriptor = new DiagnosticDescriptor(
        "CJT0099",
        "Analysis probe",
        "Never reported",
        "Style",
        DiagnosticSeverity.Warning,
        isEnabledByDefault: true);

    private int _analyzedTreeCount;

    public int AnalyzedTreeCount => Volatile.Read(ref _analyzedTreeCount);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Descriptor);

    public override void Initialize(AnalysisContext context)
    {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
        context.EnableConcurrentExecution();
        context.RegisterSyntaxTreeAction(_ => Interlocked.Increment(ref _analyzedTreeCount));
    }
}

/// <summary>
/// Base class for test fixers acting on the field declarator reported by <see cref="LegacyFieldAnalyzer" />.
/// </summary>
internal abstract class LegacyFieldCodeFixProviderBase : CodeFixProvider
{
    private readonly ImmutableArray<string> _fixableDiagnosticIds;

    protected LegacyFieldCodeFixProviderBase(string diagnosticId)
    {
        _fixableDiagnosticIds = ImmutableArray.Create(diagnosticId);
    }

    public sealed override ImmutableArray<string> FixableDiagnosticIds => _fixableDiagnosticIds;

    public override FixAllProvider GetFixAllProvider() => null;

    protected static async Task<Document> RenameDeclaratorAsync(Document document, TextSpan span, string newName, CancellationToken cancellationToken)
    {
        SyntaxNode root = await document.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false);
        VariableDeclaratorSyntax declarator = root.FindToken(span.Start).Parent.AncestorsAndSelf().OfType<VariableDeclaratorSyntax>().First();

        return document.WithSyntaxRoot(root.ReplaceToken(declarator.Identifier, SyntaxFactory.Identifier(newName).WithTriviaFrom(declarator.Identifier)));
    }

    protected static string ReplaceLegacyPrefix(string name, string newPrefix) => newPrefix + name.Substring("legacy".Length);

    protected static async Task<string> GetFieldNameAsync(Document document, TextSpan span, CancellationToken cancellationToken)
    {
        SyntaxNode root = await document.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false);

        return root.FindToken(span.Start).ValueText;
    }
}

/// <summary>
/// Offers a nested (non-applicable) group first and a plain rename action second.
/// </summary>
internal sealed class RenameLegacyFieldCodeFixProvider : LegacyFieldCodeFixProviderBase
{
    public RenameLegacyFieldCodeFixProvider(string diagnosticId)
        : base(diagnosticId)
    {
    }

    public override async Task RegisterCodeFixesAsync(CodeFixContext context)
    {
        string name = await GetFieldNameAsync(context.Document, context.Span, context.CancellationToken).ConfigureAwait(false);
        CodeAction nested = CodeAction.Create(
            "Rename (nested choice)",
            ct => RenameDeclaratorAsync(context.Document, context.Span, ReplaceLegacyPrefix(name, "nested"), ct),
            "RenameLegacyField.Nested");

        context.RegisterCodeFix(CodeAction.Create("Choose a name", ImmutableArray.Create(nested), isInlinable: false), context.Diagnostics);
        context.RegisterCodeFix(
            CodeAction.Create(
                "Rename",
                ct => RenameDeclaratorAsync(context.Document, context.Span, ReplaceLegacyPrefix(name, "renamed"), ct),
                "RenameLegacyField"),
            context.Diagnostics);
    }
}

/// <summary>
/// Only offers a nested group of actions, which the engine must not pick on its own.
/// </summary>
internal sealed class NestedOnlyLegacyFieldCodeFixProvider : LegacyFieldCodeFixProviderBase
{
    public NestedOnlyLegacyFieldCodeFixProvider(string diagnosticId)
        : base(diagnosticId)
    {
    }

    public override Task RegisterCodeFixesAsync(CodeFixContext context)
    {
        CodeAction nested = CodeAction.Create(
            "Rename (nested choice)",
            ct => RenameDeclaratorAsync(context.Document, context.Span, "nestedChoice", ct),
            "NestedOnlyLegacyField.Nested");

        context.RegisterCodeFix(CodeAction.Create("Choose a name", ImmutableArray.Create(nested), isInlinable: false), context.Diagnostics);

        return Task.CompletedTask;
    }
}

/// <summary>
/// Offers an action that returns the document unchanged, i.e. a fix without any effect.
/// </summary>
internal sealed class NoOpLegacyFieldCodeFixProvider : LegacyFieldCodeFixProviderBase
{
    public NoOpLegacyFieldCodeFixProvider(string diagnosticId)
        : base(diagnosticId)
    {
    }

    public override Task RegisterCodeFixesAsync(CodeFixContext context)
    {
        context.RegisterCodeFix(CodeAction.Create("Keep as is", _ => Task.FromResult(context.Document), "NoOpLegacyField"), context.Diagnostics);

        return Task.CompletedTask;
    }
}

/// <summary>
/// Replaces the field type with an undefined type, i.e. its fix introduces a compiler error.
/// </summary>
internal sealed class BreakingLegacyFieldCodeFixProvider : LegacyFieldCodeFixProviderBase
{
    public BreakingLegacyFieldCodeFixProvider(string diagnosticId)
        : base(diagnosticId)
    {
    }

    public override Task RegisterCodeFixesAsync(CodeFixContext context)
    {
        context.RegisterCodeFix(
            CodeAction.Create("Use missing type", ct => UseMissingTypeAsync(context.Document, context.Span, ct), "BreakingLegacyField"),
            context.Diagnostics);

        return Task.CompletedTask;
    }

    private static async Task<Document> UseMissingTypeAsync(Document document, TextSpan span, CancellationToken cancellationToken)
    {
        SyntaxNode root = await document.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false);
        VariableDeclarationSyntax declaration = root.FindToken(span.Start).Parent.AncestorsAndSelf().OfType<VariableDeclarationSyntax>().First();

        return document.WithSyntaxRoot(root.ReplaceNode(declaration.Type, SyntaxFactory.IdentifierName("MissingType").WithTriviaFrom(declaration.Type)));
    }
}

/// <summary>
/// Throws while registering its fixes, like a third-party provider with a bug.
/// </summary>
internal sealed class ThrowingLegacyFieldCodeFixProvider : LegacyFieldCodeFixProviderBase
{
    public ThrowingLegacyFieldCodeFixProvider(string diagnosticId)
        : base(diagnosticId)
    {
    }

    public override Task RegisterCodeFixesAsync(CodeFixContext context) => throw new InvalidOperationException("Sequence contains no elements");
}

/// <summary>
/// Where <see cref="UnreliableFixAllLegacyFieldCodeFixProvider" /> throws.
/// </summary>
internal enum FixAllFailure
{
    None,
    GetFixAllProvider,
    GetFixAsync,
}

/// <summary>
/// Renames the field (<c>legacy</c> to <c>renamed</c>) and optionally has broken fix-all support: either
/// <see cref="CodeFixProvider.GetFixAllProvider" /> itself throws, or the fix-all provider throws while computing the fix.
/// Its type name sorts after <see cref="ThrowingLegacyFieldCodeFixProvider" />, so the catalog tries it second.
/// </summary>
internal sealed class UnreliableFixAllLegacyFieldCodeFixProvider : LegacyFieldCodeFixProviderBase
{
    private readonly FixAllFailure _failure;

    public UnreliableFixAllLegacyFieldCodeFixProvider(string diagnosticId, FixAllFailure failure)
        : base(diagnosticId)
    {
        _failure = failure;
    }

    public override FixAllProvider GetFixAllProvider() => _failure switch
    {
        FixAllFailure.GetFixAllProvider => throw new InvalidOperationException("Fix-all provider unavailable"),
        FixAllFailure.GetFixAsync => new ThrowingFixAllProvider(),
        _ => null,
    };

    public override async Task RegisterCodeFixesAsync(CodeFixContext context)
    {
        string name = await GetFieldNameAsync(context.Document, context.Span, context.CancellationToken).ConfigureAwait(false);

        context.RegisterCodeFix(
            CodeAction.Create("Rename", ct => RenameDeclaratorAsync(context.Document, context.Span, ReplaceLegacyPrefix(name, "renamed"), ct), "UnreliableFixAllLegacyField"),
            context.Diagnostics);
    }

    private sealed class ThrowingFixAllProvider : FixAllProvider
    {
        public override IEnumerable<FixAllScope> GetSupportedFixAllScopes() => new[] { FixAllScope.Document };

        public override Task<CodeAction> GetFixAsync(FixAllContext fixAllContext) => throw new InvalidOperationException("Fix-all computation failed");
    }
}

/// <summary>
/// Cancels the cleanup and then throws while registering its fixes, like a provider interrupted by the user.
/// </summary>
internal sealed class CancelingLegacyFieldCodeFixProvider : LegacyFieldCodeFixProviderBase
{
    private readonly CancellationTokenSource _cancellation;

    public CancelingLegacyFieldCodeFixProvider(string diagnosticId, CancellationTokenSource cancellation)
        : base(diagnosticId)
    {
        _cancellation = cancellation;
    }

    public override Task RegisterCodeFixesAsync(CodeFixContext context)
    {
        _cancellation.Cancel();

        throw new InvalidOperationException("Provider interrupted");
    }
}

/// <summary>
/// Adds a new document instead of editing text, which the engine must reject as an unsupported change.
/// </summary>
internal sealed class AddDocumentLegacyFieldCodeFixProvider : LegacyFieldCodeFixProviderBase
{
    public AddDocumentLegacyFieldCodeFixProvider(string diagnosticId)
        : base(diagnosticId)
    {
    }

    public override Task RegisterCodeFixesAsync(CodeFixContext context)
    {
        context.RegisterCodeFix(
            CodeAction.Create(
                "Move to new file",
                ct => Task.FromResult(context.Document.Project.AddDocument("Extracted.cs", SourceText.From("class Extracted { }\n")).Project.Solution),
                "AddDocumentLegacyField"),
            context.Diagnostics);

        return Task.CompletedTask;
    }
}

/// <summary>
/// Renames the field (<c>legacy</c> to <c>renamed</c>) through a code action whose operation list is shaped by the
/// test from the field name, the original and the renamed solution, e.g. the solution change next to a host
/// notification (as Visual Studio's rename-based fixes return), two solution changes, or no solution change at all.
/// </summary>
internal sealed class CustomOperationsLegacyFieldCodeFixProvider : LegacyFieldCodeFixProviderBase
{
    private readonly Func<string, Solution, Solution, IEnumerable<CodeActionOperation>> _createOperations;

    public CustomOperationsLegacyFieldCodeFixProvider(string diagnosticId, Func<string, Solution, Solution, IEnumerable<CodeActionOperation>> createOperations)
        : base(diagnosticId)
    {
        _createOperations = createOperations;
    }

    public override async Task RegisterCodeFixesAsync(CodeFixContext context)
    {
        string name = await GetFieldNameAsync(context.Document, context.Span, context.CancellationToken).ConfigureAwait(false);

        context.RegisterCodeFix(
            new CustomOperationsCodeAction(async ct =>
            {
                Document renamed = await RenameDeclaratorAsync(context.Document, context.Span, ReplaceLegacyPrefix(name, "renamed"), ct).ConfigureAwait(false);

                return _createOperations(name, context.Document.Project.Solution, renamed.Project.Solution);
            }),
            context.Diagnostics);
    }

    private sealed class CustomOperationsCodeAction : CodeAction
    {
        private readonly Func<CancellationToken, Task<IEnumerable<CodeActionOperation>>> _computeOperations;

        public CustomOperationsCodeAction(Func<CancellationToken, Task<IEnumerable<CodeActionOperation>>> computeOperations)
        {
            _computeOperations = computeOperations;
        }

        public override string Title => "Rename";

        public override string EquivalenceKey => "CustomOperationsLegacyField";

        protected override Task<IEnumerable<CodeActionOperation>> ComputeOperationsAsync(CancellationToken cancellationToken)
            => _computeOperations(cancellationToken);
    }
}

/// <summary>
/// A host/UI notification operation that changes no text, like Visual Studio's symbol-renamed notification. Applying
/// it fails, so a test using it also proves the engine never executes such operations itself.
/// </summary>
internal sealed class HostNotificationOperation : CodeActionOperation
{
    private readonly string _subject;

    public HostNotificationOperation(string subject)
    {
        _subject = subject;
    }

    public override string Title => "Notify host: " + _subject;

    public override void Apply(Workspace workspace, CancellationToken cancellationToken)
        => throw new InvalidOperationException("The engine must hand host notifications to the host instead of executing them.");
}

/// <summary>
/// Offers two alternative actions without an equivalence key and supports the batch fix-all provider, which merges
/// every action whose equivalence key matches. Only the first alternative (renaming the field) may be applied; the
/// second renames the class.
/// </summary>
internal sealed class AlternativesWithoutEquivalenceKeyLegacyFieldCodeFixProvider : LegacyFieldCodeFixProviderBase
{
    private readonly bool _withFixAll;

    public AlternativesWithoutEquivalenceKeyLegacyFieldCodeFixProvider(string diagnosticId, bool withFixAll = true)
        : base(diagnosticId)
    {
        _withFixAll = withFixAll;
    }

    public override FixAllProvider GetFixAllProvider() => _withFixAll ? WellKnownFixAllProviders.BatchFixer : null;

    public override async Task RegisterCodeFixesAsync(CodeFixContext context)
    {
        string name = await GetFieldNameAsync(context.Document, context.Span, context.CancellationToken).ConfigureAwait(false);

        context.RegisterCodeFix(
            CodeAction.Create("Rename field", ct => RenameDeclaratorAsync(context.Document, context.Span, ReplaceLegacyPrefix(name, "first"), ct)),
            context.Diagnostics);
        context.RegisterCodeFix(
            CodeAction.Create("Rename class", ct => RenameClassAsync(context.Document, ct)),
            context.Diagnostics);
    }

    private static async Task<Document> RenameClassAsync(Document document, CancellationToken cancellationToken)
    {
        SyntaxNode root = await document.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false);
        ClassDeclarationSyntax type = root.DescendantNodes().OfType<ClassDeclarationSyntax>().First();

        return document.WithSyntaxRoot(root.ReplaceToken(type.Identifier, SyntaxFactory.Identifier("Alternative").WithTriviaFrom(type.Identifier)));
    }
}

/// <summary>
/// Offers a single rename action without an equivalence key and supports the batch fix-all provider, optionally after
/// a nested group of choices (whose container action has no equivalence key either and changes nothing itself).
/// </summary>
internal sealed class BatchRenameLegacyFieldCodeFixProvider : LegacyFieldCodeFixProviderBase
{
    private readonly bool _withNestedChoice;

    public BatchRenameLegacyFieldCodeFixProvider(string diagnosticId, bool withNestedChoice = false)
        : base(diagnosticId)
    {
        _withNestedChoice = withNestedChoice;
    }

    public override FixAllProvider GetFixAllProvider() => WellKnownFixAllProviders.BatchFixer;

    public override async Task RegisterCodeFixesAsync(CodeFixContext context)
    {
        string name = await GetFieldNameAsync(context.Document, context.Span, context.CancellationToken).ConfigureAwait(false);

        if (_withNestedChoice)
        {
            CodeAction nested = CodeAction.Create("Rename (nested choice)", ct => RenameDeclaratorAsync(context.Document, context.Span, ReplaceLegacyPrefix(name, "nested"), ct), "BatchRename.Nested");
            context.RegisterCodeFix(CodeAction.Create("Choose a name", ImmutableArray.Create(nested), isInlinable: false), context.Diagnostics);
        }

        context.RegisterCodeFix(
            CodeAction.Create("Rename", ct => RenameDeclaratorAsync(context.Document, context.Span, ReplaceLegacyPrefix(name, "batch"), ct)),
            context.Diagnostics);
    }
}

/// <summary>
/// Analyzer whose <see cref="DiagnosticAnalyzer.SupportedDiagnostics" /> is broken: it either throws or returns a
/// default array, like a faulty third-party analyzer.
/// </summary>
[DiagnosticAnalyzer(LanguageNames.CSharp)]
internal sealed class BrokenDescriptorsAnalyzer : DiagnosticAnalyzer
{
    private readonly bool _throws;

    public BrokenDescriptorsAnalyzer(bool throws)
    {
        _throws = throws;
    }

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics
        => _throws ? throw new InvalidOperationException("Broken analyzer.") : default(ImmutableArray<DiagnosticDescriptor>);

    public override void Initialize(AnalysisContext context)
        => throw new InvalidOperationException("A skipped analyzer must never be initialized.");
}

/// <summary>
/// Analyzer that reports <c>CJT0071</c> as a performance rule and throws while analyzing a syntax tree, which Roslyn turns
/// into an <c>AD0001</c> diagnostic without a source location.
/// </summary>
[DiagnosticAnalyzer(LanguageNames.CSharp)]
internal sealed class ThrowingAnalysisAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Descriptor = new DiagnosticDescriptor(
        "CJT0071",
        "Throwing analysis",
        "Never reported",
        "Performance",
        DiagnosticSeverity.Warning,
        isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Descriptor);

    public override void Initialize(AnalysisContext context)
    {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
        context.RegisterSyntaxTreeAction(_ => throw new InvalidOperationException("Analysis exploded."));
    }
}

/// <summary>
/// Suppresses every diagnostic with the given id, like a <c>DiagnosticSuppressor</c> shipped next to an analyzer.
/// </summary>
[DiagnosticAnalyzer(LanguageNames.CSharp)]
internal sealed class LegacyFieldSuppressor : DiagnosticSuppressor
{
    private readonly SuppressionDescriptor _descriptor;

    public LegacyFieldSuppressor(string suppressedDiagnosticId)
    {
        _descriptor = new SuppressionDescriptor("CJTSPR" + suppressedDiagnosticId, suppressedDiagnosticId, "Legacy fields are accepted here");
    }

    public override ImmutableArray<SuppressionDescriptor> SupportedSuppressions => ImmutableArray.Create(_descriptor);

    public override void ReportSuppressions(SuppressionAnalysisContext context)
    {
        foreach (Diagnostic diagnostic in context.ReportedDiagnostics)
        {
            context.ReportSuppression(Suppression.Create(_descriptor, diagnostic));
        }
    }
}

/// <summary>
/// A provider that does not declare its fixable diagnostic ids (a default array), which must simply be ignored.
/// </summary>
internal sealed class UndeclaredIdsCodeFixProvider : CodeFixProvider
{
    public override ImmutableArray<string> FixableDiagnosticIds => default;

    public override FixAllProvider GetFixAllProvider() => null;

    public override Task RegisterCodeFixesAsync(CodeFixContext context)
        => throw new InvalidOperationException("A provider without fixable ids must never be asked for fixes.");
}

/// <summary>
/// Renames the field (<c>legacy</c> to <c>probed</c>) and exposes a fix-all provider that only records which
/// diagnostics the fix-all context hands out for every document and project, then declines.
/// </summary>
internal sealed class ProbingFixAllLegacyFieldCodeFixProvider : LegacyFieldCodeFixProviderBase
{
    private readonly ProbingFixAllProvider _fixAllProvider = new ProbingFixAllProvider();

    public ProbingFixAllLegacyFieldCodeFixProvider(string diagnosticId)
        : base(diagnosticId)
    {
    }

    public IReadOnlyList<string> Observations => _fixAllProvider.Observations;

    public override FixAllProvider GetFixAllProvider() => _fixAllProvider;

    public override async Task RegisterCodeFixesAsync(CodeFixContext context)
    {
        string name = await GetFieldNameAsync(context.Document, context.Span, context.CancellationToken).ConfigureAwait(false);

        context.RegisterCodeFix(
            CodeAction.Create("Rename", ct => RenameDeclaratorAsync(context.Document, context.Span, ReplaceLegacyPrefix(name, "probed"), ct), "ProbingFixAllLegacyField"),
            context.Diagnostics);
    }

    private sealed class ProbingFixAllProvider : FixAllProvider
    {
        public List<string> Observations { get; } = [];

        public override IEnumerable<FixAllScope> GetSupportedFixAllScopes() => new[] { FixAllScope.Document };

        public override async Task<CodeAction> GetFixAsync(FixAllContext fixAllContext)
        {
            foreach (Document document in fixAllContext.Project.Documents.OrderBy(document => document.Name, StringComparer.Ordinal))
            {
                Observations.Add($"document {document.Name}: {(await fixAllContext.GetDocumentDiagnosticsAsync(document).ConfigureAwait(false)).Length}");
            }

            Observations.Add($"project-only: {(await fixAllContext.GetProjectDiagnosticsAsync(fixAllContext.Project).ConfigureAwait(false)).Length}");

            foreach (Project project in fixAllContext.Solution.Projects.OrderBy(project => project.Name, StringComparer.Ordinal))
            {
                Observations.Add($"all {project.Name}: {(await fixAllContext.GetAllDiagnosticsAsync(project).ConfigureAwait(false)).Length}");
            }

            return null;
        }
    }
}
