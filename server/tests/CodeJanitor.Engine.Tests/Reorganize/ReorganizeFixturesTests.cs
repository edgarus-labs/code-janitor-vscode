using System.Runtime.CompilerServices;
using CodeJanitor.Engine.Reorganize;
using CodeJanitor.Engine.Tests.Testbed;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Xunit;
using static CodeJanitor.Engine.Tests.Reorganize.ReorganizeHarness;

namespace CodeJanitor.Engine.Tests.Reorganize;

/// <summary>Files that are not meant to compile: what the reorganizer cannot understand it leaves alone.</summary>
public sealed class ReorganizeFixturesTests
{
    private static readonly ReorganizeSettings Yes = new() { PerformWhenPreprocessorConditionals = PreprocessorPolicy.Yes };

    /// <summary>The root of the extension's repository, from the path of this source file.</summary>
    public static string RepositoryRoot([CallerFilePath] string path = "") =>
        Path.GetFullPath(Path.Combine(Path.GetDirectoryName(path)!, "..", "..", "..", ".."));

    private static string Read(string name, [CallerFilePath] string path = "") => TestbedScenarios.ReadText(Path.Combine(Path.GetDirectoryName(path)!, "Fixtures", name));

    private static ReorganizeResult RunFixture(string name)
    {
        var source = Read(name);
        var result = Detailed(source, Yes, ReorganizeCleanup.WithoutPadding);

        Assert.Equal(result.Output, Detailed(result.Output, Yes, ReorganizeCleanup.WithoutPadding).Output);

        return result;
    }

    [Fact]
    public void LeavesAnIfBlockWhoseInactiveTextIsNotMembersOfTheTypeWhereItIs()
    {
        // Roslyn reads the inactive `#if FLAG` text (with the end of Unbalanced and the start of Other) as one stretch:
        // Bravo is a member of Unbalanced, and the stretch is not members of a type, so nothing moves across it.
        var result = RunFixture("Unbalanced.cs");

        Assert.Equal(Read("Unbalanced.cs"), result.Output);
        Assert.Empty(result.Skipped);
    }

    [Fact]
    public void DoesNotSwapTwoTypesThatAnIfAndItsEndifAreSplitBetween()
    {
        var result = RunFixture("Unbalanced.cs");

        Assert.True(result.Output.IndexOf("class Unbalanced", StringComparison.Ordinal) < result.Output.IndexOf("class Other", StringComparison.Ordinal));
    }

    [Fact]
    public void LeavesATypeWithASyntaxErrorAloneAndStillSortsTheOthers()
    {
        // Roslyn recovers from the error inside Broken and the rest of the file is still sorted.
        var result = RunFixture("Broken.cs");

        Assert.Contains("public void Zulu( { }\n        public int Alpha;", result.Output);
        Assert.Contains("public class Fine\n    {\n        public int Alpha;\n        public void Zulu() { }\n    }", result.Output);
        Assert.Contains("Broken (line 3): skipped because of syntax the parser does not understand", result.Skipped);
    }

    [Fact]
    public void SortsMultiLineBodiesAndSkipsABodyWithSeveralMembersOnOneLine()
    {
        var result = RunFixture("OneLiners.cs");

        Assert.Contains("public struct Pair { public int Second; public int First; }", result.Output);
        Assert.Contains("public class Mixed\n    {\n        public int Alpha;\n        public void Zulu() { }\n    }", result.Output);
        Assert.Contains("Pair (line 3): skipped because of more than one member on a line", Assert.Single(result.Skipped));
    }

    [Fact]
    public void OrdersTheTypesAfterTopLevelStatementsWithoutTouchingTheStatements()
    {
        var result = RunFixture("TopLevel.cs");

        Assert.Contains("Console.WriteLine(Helper.Name);", result.Output);
        Assert.Contains("class Another\n{\n    public int Alpha;\n    public void Zulu() { }\n}", result.Output);
        Assert.Contains("static class Helper\n{\n    public static string Name = \"n\";\n    public static void Run() { }\n}", result.Output);
    }

    [Fact]
    public void KeepsAByteOrderMarkAndTheHeaderBeforeTheFirstLineOfCode()
    {
        var result = RunFixture("Bom.cs");

        Assert.StartsWith("\uFEFF// header\n\nusing System;", result.Output, StringComparison.Ordinal);
        Assert.Contains("public int Alpha;\n        public void Zulu() { }", result.Output);
    }

    [Fact]
    public void DoesNothingToAnEmptyOrBlankFileOrToOneWithoutTypes()
    {
        foreach (var source in new[] { "", "\n", "   \r\n\r\n", "// just a comment\n", "using System;\n" })
        {
            Assert.Equal(source, Detailed(source).Output);
        }
    }
}

/// <summary>Every member form is one node the reorganizer can move.</summary>
public sealed class ReorganizeSyntaxTests
{
    private const string Source = "class C : I\n{\n    int I.this[int i] { get => 0; }\n    event System.Action I.E { add { } remove { } }\n    int I.P { get; set; }\n    void I.M() { }\n}\n";

    [Fact]
    public void ParsesExplicitInterfaceImplementationsAsSingleMembers()
    {
        var type = (ClassDeclarationSyntax)CSharpSyntaxTree.ParseText(Source).GetCompilationUnitRoot().Members[0];

        Assert.Equal(
            [typeof(IndexerDeclarationSyntax), typeof(EventDeclarationSyntax), typeof(PropertyDeclarationSyntax), typeof(MethodDeclarationSyntax)],
            type.Members.Select(member => member.GetType()));
        Assert.Empty(type.SyntaxTree.GetDiagnostics());
    }

    [Fact]
    public void NamesExplicitImplementationsWithTheirInterface()
    {
        var output = Run("class C : I\n{\n    void I.M() { }\n    event System.Action I.E { add { } remove { } }\n    int I.this[int i] { get => 0; }\n}\n");

        // Events (5) sort before indexers (9) and methods (10).
        Assert.Equal("class C : I\n{\n    event System.Action I.E { add { } remove { } }\n    int I.this[int i] { get => 0; }\n    void I.M() { }\n}\n", output);
    }
}
