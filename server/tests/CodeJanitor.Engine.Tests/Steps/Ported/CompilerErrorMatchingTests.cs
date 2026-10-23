#nullable disable
#pragma warning disable RS1029, RS2008 // Compiler ids on purpose: the matcher is fed compiler errors.
using System.Collections.Generic;
using System.Linq;
using CodeJanitor.Engine.Diagnostics;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;
using Xunit;
using Assert = CodeJanitor.Engine.Tests.Steps.Support.MsAssert;

namespace CodeJanitor.Engine.Tests.Steps;

/// <summary>
/// Unit tests for <see cref="CompilerErrorMatching" />: errors after a change are matched with those before it by id,
/// file path and message, counting duplicates, regardless of their positions.
/// </summary>
public sealed class CompilerErrorMatchingTests
{
    private static readonly DiagnosticDescriptor TypeNotFound = new DiagnosticDescriptor("CS0246", "Type not found", "The type '{0}' could not be found", "Compiler", DiagnosticSeverity.Error, true);

    private static readonly DiagnosticDescriptor Ambiguous = new DiagnosticDescriptor("CS0104", "Ambiguous", "'{0}' is ambiguous", "Compiler", DiagnosticSeverity.Error, true);

    private static readonly SyntaxTree FileA = CSharpSyntaxTree.ParseText("class A { }", path: "A.cs");

    private static readonly SyntaxTree FileB = CSharpSyntaxTree.ParseText("class B { }", path: "B.cs");

    [Fact]
    public void ErrorsThatOnlyMove_AreMatched()
    {
        Diagnostic before = Error(TypeNotFound, FileA, 0, "Foo");
        Diagnostic after = Error(TypeNotFound, FileA, 6, "Foo");

        (List<Diagnostic> unmatched, IEnumerable<Diagnostic> remaining) = CompilerErrorMatching.MatchByMessage(new[] { before }, new[] { after });

        Assert.IsEmpty(unmatched);
        Assert.IsEmpty(remaining.ToList());
    }

    [Fact]
    public void DuplicatesAreCounted_TheExtraErrorAfterIsNew_AndTheLastEqualErrorBeforeIsConsumedFirst()
    {
        Diagnostic first = Error(TypeNotFound, FileA, 0, "Foo");
        Diagnostic second = Error(TypeNotFound, FileA, 6, "Foo");
        Diagnostic[] after = { Error(TypeNotFound, FileA, 1, "Foo"), Error(TypeNotFound, FileA, 2, "Foo"), Error(TypeNotFound, FileA, 3, "Foo") };

        (List<Diagnostic> unmatched, IEnumerable<Diagnostic> remaining) = CompilerErrorMatching.MatchByMessage(new[] { first, second }, after);

        Assert.AreSequenceEqual(new[] { after[2] }, unmatched);
        Assert.IsEmpty(remaining.ToList());

        (unmatched, remaining) = CompilerErrorMatching.MatchByMessage(new[] { first, second }, new[] { after[0] });

        Assert.IsEmpty(unmatched);
        Assert.AreSequenceEqual(new[] { first }, remaining.ToList());
    }

    [Fact]
    public void ErrorsDifferingInIdFileOrMessage_AreNotMatched_AndKeepTheirOrder()
    {
        Diagnostic before = Error(TypeNotFound, FileA, 0, "Foo");
        Diagnostic[] after =
        {
            Error(Ambiguous, FileA, 0, "Foo"),
            Error(TypeNotFound, FileB, 0, "Foo"),
            Error(TypeNotFound, FileA, 0, "Bar"),
        };

        (List<Diagnostic> unmatched, IEnumerable<Diagnostic> remaining) = CompilerErrorMatching.MatchByMessage(new[] { before }, after);

        Assert.AreSequenceEqual(after, unmatched);
        Assert.AreSequenceEqual(new[] { before }, remaining.ToList());
    }

    [Fact]
    public void ErrorsWithoutASourceFile_AreMatchedWithEachOther_ButNotWithErrorsInAFile()
    {
        Diagnostic before = Diagnostic.Create(TypeNotFound, Location.None, "Foo");
        Diagnostic sameWithoutFile = Diagnostic.Create(TypeNotFound, Location.None, "Foo");
        Diagnostic sameInAFile = Error(TypeNotFound, FileA, 0, "Foo");

        (List<Diagnostic> unmatched, IEnumerable<Diagnostic> remaining) = CompilerErrorMatching.MatchByMessage(new[] { before }, new[] { sameInAFile, sameWithoutFile });

        Assert.AreSequenceEqual(new[] { sameInAFile }, unmatched);
        Assert.IsEmpty(remaining.ToList());
    }

    [Fact]
    public void NoErrors_MatchNothing()
    {
        (List<Diagnostic> unmatched, IEnumerable<Diagnostic> remaining) = CompilerErrorMatching.MatchByMessage(new Diagnostic[0], new Diagnostic[0]);

        Assert.IsEmpty(unmatched);
        Assert.IsEmpty(remaining.ToList());
    }

    private static Diagnostic Error(DiagnosticDescriptor descriptor, SyntaxTree tree, int start, string argument)
        => Diagnostic.Create(descriptor, Location.Create(tree, new TextSpan(start, 1)), argument);
}
