#nullable disable
#pragma warning disable RS1010, RS1025, RS1026, RS2008 // Test analyzers and fixers: no release tracking, minimal registration on purpose.

using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using CodeJanitor.Engine.Diagnostics;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;
using Xunit;

namespace CodeJanitor.Engine.Tests.Diagnostics;

/// <summary>
/// Unit tests for <see cref="CompilerErrors" />, the gate deciding whether a candidate change introduces a compiler
/// error: an error only counts as existing when its message is unchanged or when its old location maps onto its new
/// location through the text changes.
/// </summary>
public sealed class CompilerErrorsTests
{
    private const string Text = "aaaa bbbb cccc dddd\n";

    private static readonly DiagnosticDescriptor ErrorDescriptor = new DiagnosticDescriptor(
        "CJT0400",
        "Test error",
        "Error {0}",
        "Compiler",
        DiagnosticSeverity.Error,
        isEnabledByDefault: true);

    [Fact]
    public async Task FindFirstNewAsync_ErrorInAnUnchangedFileWhoseMessageChanged_IsNotNew()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace();
        DocumentId settingsId = workspace.AddDocument("Settings.cs", "public class Settings\n{\n    public int Value;\n}\n");
        workspace.AddDocument("User.cs", "class User\n{\n    string Read(Settings settings) => settings.Value;\n}\n");
        Project before = workspace.CreateSolution().GetProject(settingsId.ProjectId);
        Project after = before.Solution.WithDocumentText(settingsId, SourceText.From("public class Settings\n{\n    public long Value;\n}\n")).GetProject(before.Id);
        IReadOnlyList<Diagnostic> beforeErrors = await CompilerErrors.GetAsync(before, CancellationToken.None);
        IReadOnlyList<Diagnostic> afterErrors = await CompilerErrors.GetAsync(after, CancellationToken.None);

        Diagnostic newError = await CompilerErrors.FindFirstNewAsync(before, beforeErrors, after, afterErrors, CancellationToken.None);

        Assert.Null(newError);
        Assert.Equal("CS0029", beforeErrors.Single().Id);
        Assert.NotEqual(beforeErrors.Single().GetMessage(), afterErrors.Single().GetMessage());
    }

    [Fact]
    public async Task FindFirstNewAsync_ChangeBreakingAnotherFile_ReturnsTheNewError()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace();
        DocumentId settingsId = workspace.AddDocument("Settings.cs", "public class Settings\n{\n    public int Value;\n}\n");
        workspace.AddDocument("User.cs", "class User\n{\n    int Read(Settings settings) => settings.Value;\n}\n");
        Project before = workspace.CreateSolution().GetProject(settingsId.ProjectId);
        Project after = before.Solution.WithDocumentText(settingsId, SourceText.From("public class Settings\n{\n    public int Renamed;\n}\n")).GetProject(before.Id);

        Diagnostic newError = await CompilerErrors.FindFirstNewAsync(
            before,
            await CompilerErrors.GetAsync(before, CancellationToken.None),
            after,
            await CompilerErrors.GetAsync(after, CancellationToken.None),
            CancellationToken.None);

        Assert.Equal("CS1061", newError.Id);
        Assert.Equal(DiagnosticCleanupTestWorkspace.GetPath("User.cs"), newError.Location.SourceTree.FilePath);
    }

    [Fact]
    public async Task FindFirstNewAsync_NewErrorWithoutASourceLocation_IsNew()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace();
        DocumentId documentId = workspace.AddDocument("Sample.cs", Text);
        Project project = workspace.CreateSolution().GetProject(documentId.ProjectId);
        SyntaxTree tree = await project.GetDocument(documentId).GetSyntaxTreeAsync(CancellationToken.None);
        Diagnostic existing = Diagnostic.Create(ErrorDescriptor, Location.Create(tree, new TextSpan(5, 4)), "old");
        Diagnostic withoutLocation = Diagnostic.Create(ErrorDescriptor, Location.None, "new");

        Diagnostic newError = await CompilerErrors.FindFirstNewAsync(project, new[] { existing }, project, new[] { withoutLocation }, CancellationToken.None);

        Assert.Same(withoutLocation, newError);
    }

    [Theory]
    [InlineData(5, 4, 15, 4, "D", 5, 4, false)]
    [InlineData(5, 4, 15, 4, "D", 6, 4, true)]
    [InlineData(5, 4, 0, 0, "ZZ", 7, 4, false)]
    [InlineData(5, 4, 6, 2, "XYZ", 5, 5, false)]
    [InlineData(5, 4, 7, 5, "X", 5, 3, true)]
    [InlineData(5, 4, 3, 4, "X", 3, 3, true)]
    [InlineData(5, 4, 5, 0, "XX", 7, 4, false)]
    [InlineData(5, 4, 5, 0, "XX", 5, 6, false)]
    [InlineData(5, 4, 9, 0, "XX", 5, 6, false)]
    [InlineData(5, 0, 5, 0, "XX", 7, 0, false)]
    [InlineData(5, 0, 5, 0, "XX", 5, 0, false)]
    [InlineData(5, 0, 5, 0, "XX", 6, 0, true)]
    public async Task FindFirstNewAsync_ErrorWithAChangedMessage_IsExistingOnlyWhenItsLocationMapsThroughTheEdit(
        int oldStart,
        int oldLength,
        int changeStart,
        int changeLength,
        string insertedText,
        int newStart,
        int newLength,
        bool expectNew)
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace();
        DocumentId documentId = workspace.AddDocument("Sample.cs", Text);
        Project before = workspace.CreateSolution().GetProject(documentId.ProjectId);
        SourceText oldText = await before.GetDocument(documentId).GetTextAsync(CancellationToken.None);
        Project after = before.Solution
            .WithDocumentText(documentId, oldText.WithChanges(new TextChange(new TextSpan(changeStart, changeLength), insertedText)))
            .GetProject(before.Id);
        Diagnostic beforeError = Diagnostic.Create(ErrorDescriptor, Location.Create(await before.GetDocument(documentId).GetSyntaxTreeAsync(CancellationToken.None), new TextSpan(oldStart, oldLength)), "old");
        Diagnostic afterError = Diagnostic.Create(ErrorDescriptor, Location.Create(await after.GetDocument(documentId).GetSyntaxTreeAsync(CancellationToken.None), new TextSpan(newStart, newLength)), "new");

        Diagnostic newError = await CompilerErrors.FindFirstNewAsync(before, new[] { beforeError }, after, new[] { afterError }, CancellationToken.None);

        Assert.Equal(expectNew, newError is not null);
    }

    [Fact]
    public async Task FindFirstNewAsync_TwoErrorsWithChangedMessagesCompeteForOneExistingError_TheSecondIsNew()
    {
        using DiagnosticCleanupTestWorkspace workspace = new DiagnosticCleanupTestWorkspace();
        DocumentId documentId = workspace.AddDocument("Sample.cs", Text);
        Project before = workspace.CreateSolution().GetProject(documentId.ProjectId);
        SourceText oldText = await before.GetDocument(documentId).GetTextAsync(CancellationToken.None);
        Project after = before.Solution
            .WithDocumentText(documentId, oldText.WithChanges(new TextChange(new TextSpan(0, 0), "ZZ")))
            .GetProject(before.Id);
        SyntaxTree afterTree = await after.GetDocument(documentId).GetSyntaxTreeAsync(CancellationToken.None);
        Diagnostic existing = Diagnostic.Create(ErrorDescriptor, Location.Create(await before.GetDocument(documentId).GetSyntaxTreeAsync(CancellationToken.None), new TextSpan(5, 4)), "old");
        Diagnostic first = Diagnostic.Create(ErrorDescriptor, Location.Create(afterTree, new TextSpan(7, 4)), "first");
        Diagnostic second = Diagnostic.Create(ErrorDescriptor, Location.Create(afterTree, new TextSpan(7, 4)), "second");

        Diagnostic newError = await CompilerErrors.FindFirstNewAsync(before, new[] { existing }, after, new[] { first, second }, CancellationToken.None);

        Assert.Same(second, newError);
    }

}
