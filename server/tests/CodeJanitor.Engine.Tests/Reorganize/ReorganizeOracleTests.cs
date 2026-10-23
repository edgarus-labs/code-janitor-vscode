using System.Reflection;
using System.Runtime.Loader;
using CodeJanitor.Engine.Reorganize;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;
using Xunit;

namespace CodeJanitor.Engine.Tests.Reorganize;

/// <summary>
/// The real-compiler proof: the files of test/oracle/Reorganize (members in
/// the order nobody would choose, partial classes, nested types, explicit interface implementations, <c>#if</c>
/// around members, regions, structs, records and initializers that depend on their order) are reorganized with
/// several settings, compiled by Roslyn and run. The result has no new compiler error and Program.cs, which prints
/// every static and instance field, prints the same.
/// </summary>
[Collection(nameof(ConsoleCollection))]
public sealed class ReorganizeOracleTests
{
    private static readonly Lazy<MetadataReference[]> References = new(() =>
        ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator)
            .Where(path => Path.GetFileName(path) is var name && (name.StartsWith("System.", StringComparison.Ordinal) || name is "mscorlib.dll" or "netstandard.dll"))
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
            .ToArray());

    public static TheoryData<string> ScenarioNames() => [.. Scenarios.Keys];

    private static readonly Dictionary<string, (ReorganizeSettings Settings, bool Padding, string Eol, OptimizationLevel Level)> Scenarios = BuildScenarios();

    private static Dictionary<string, (ReorganizeSettings, bool, string, OptimizationLevel)> BuildScenarios()
    {
        var yes = new ReorganizeSettings { PerformWhenPreprocessorConditionals = PreprocessorPolicy.Yes };
        var custom = ReorganizeSettings.DefaultMemberTypes();
        custom[MemberTypeKey.Methods] = new MemberTypeSetting(1, "Methods");
        custom[MemberTypeKey.Classes] = new MemberTypeSetting(2, "Types");
        custom[MemberTypeKey.Structs] = new MemberTypeSetting(2, "Types");
        custom[MemberTypeKey.Fields] = new MemberTypeSetting(12, "State");

        return new()
        {
            ["the defaults"] = (yes, true, "\n", OptimizationLevel.Debug),
            ["the defaults in a Release build"] = (yes, true, "\n", OptimizationLevel.Release),
            ["the defaults without blank line padding and with CRLF line endings"] = (yes, false, "\r\n", OptimizationLevel.Debug),
            ["members in source order inside their group"] = (yes with { AlphabetizeMembersOfTheSameGroup = false, ExplicitMembersAtEnd = true }, true, "\n", OptimizationLevel.Debug),
            ["access first, private to public"] = (yes with { PrimaryOrderByAccessLevel = true, ReverseOrderByAccessLevel = true }, true, "\n", OptimizationLevel.Debug),
            ["a configured member type order"] = (yes with { MemberTypes = custom }, true, "\n", OptimizationLevel.Debug),
            ["members sorted across the existing regions"] = (yes with { KeepMembersWithinRegions = false }, true, "\n", OptimizationLevel.Debug),
            ["existing regions removed"] = (yes with { RegionsRemoveExistingRegions = true }, true, "\n", OptimizationLevel.Debug),
            ["new regions"] = (yes with { RegionsInsertNewRegions = true, RegionsRemoveExistingRegions = true }, true, "\n", OptimizationLevel.Debug),
            ["new regions with the access level"] = (yes with { RegionsInsertNewRegions = true, RegionsIncludeAccessLevel = true, RegionsInsertKeepEvenIfEmpty = true }, true, "\n", OptimizationLevel.Debug),
            ["new regions with the access level of methods, sorted across regions"] = (yes with { RegionsInsertNewRegions = true, RegionsIncludeAccessLevel = true, RegionsIncludeAccessLevelForMethodsOnly = true, KeepMembersWithinRegions = false }, true, "\r\n", OptimizationLevel.Debug),
        };
    }

    private static Dictionary<string, string> ReadCorpus()
    {
        var folder = Path.Combine(ReorganizeFixturesTests.RepositoryRoot(), "test", "oracle", "Reorganize");

        return Directory.GetFiles(folder, "*.cs").ToDictionary(path => Path.GetFileName(path), File.ReadAllText);
    }

    private static CSharpCompilation Compile(IReadOnlyDictionary<string, string> files, OptimizationLevel level) =>
        CSharpCompilation.Create(
            "Reorganize",
            files.Select(file => CSharpSyntaxTree.ParseText(SourceText.From(file.Value), CSharpParseOptions.Default.WithLanguageVersion(LanguageVersion.Latest), file.Key)),
            References.Value,
            new CSharpCompilationOptions(OutputKind.ConsoleApplication, optimizationLevel: level, allowUnsafe: true, nullableContextOptions: NullableContextOptions.Enable));

    private static string[] Errors(Compilation compilation) =>
        compilation.GetDiagnostics().Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error).Select(diagnostic => diagnostic.ToString()).ToArray();

    /// <summary>Emits and runs the program, returning what it printed.</summary>
    private static string Run(CSharpCompilation compilation)
    {
        using var image = new MemoryStream();
        var emitted = compilation.Emit(image);
        Assert.True(emitted.Success, string.Join("\n", emitted.Diagnostics));

        var context = new AssemblyLoadContext("oracle", isCollectible: true);
        try
        {
            image.Position = 0;
            var assembly = context.LoadFromStream(image);
            var output = new StringWriter();
            var original = Console.Out;
            Console.SetOut(output);
            try
            {
                assembly.EntryPoint!.Invoke(null, assembly.EntryPoint.GetParameters().Length == 0 ? null : [Array.Empty<string>()]);
            }
            finally
            {
                Console.SetOut(original);
            }

            return output.ToString();
        }
        finally
        {
            context.Unload();
        }
    }

    [Fact]
    public void StartsFromACorpusThatCompilesAndRuns()
    {
        foreach (var level in new[] { OptimizationLevel.Debug, OptimizationLevel.Release })
        {
            var compilation = Compile(ReadCorpus(), level);

            Assert.Empty(Errors(compilation));
            Assert.Contains("Oracle.Reorganize.Settings.Quadrupled = 84", Run(compilation));
        }
    }

    [Theory]
    [MemberData(nameof(ScenarioNames))]
    public void ReorganizesWithoutANewCompilerErrorAndWithoutAChangeOfBehaviour(string name)
    {
        var (settings, padding, eol, level) = Scenarios[name];
        var cleanup = padding ? ReorganizeCleanup.Default : ReorganizeCleanup.WithoutPadding;
        var corpus = ReadCorpus().ToDictionary(file => file.Key, file => eol == "\n" ? file.Value : file.Value.Replace("\r\n", "\n", StringComparison.Ordinal).Replace("\n", eol, StringComparison.Ordinal));
        var baseline = Compile(corpus, level);
        var expected = Run(baseline);

        var reorganized = new Dictionary<string, string>();
        var changed = new List<string>();
        foreach (var (file, content) in corpus)
        {
            var tree = baseline.SyntaxTrees.Single(candidate => candidate.FilePath == file);
            var first = Reorganizer.Reorganize(tree, baseline.GetSemanticModel(tree), settings, cleanup);
            Assert.True(first.Skipped.Count == 0, $"{file} must not be left alone: {string.Join("; ", first.Skipped)}");

            var again = CSharpSyntaxTree.ParseText(first.Output, (CSharpParseOptions)tree.Options, file);
            var second = Reorganizer.Reorganize(again, baseline.ReplaceSyntaxTree(tree, again).GetSemanticModel(again), settings, cleanup);
            Assert.True(second.Output == first.Output, $"{file} must not change when reorganized again");

            reorganized[file] = first.Output;
            if (first.Output != content)
            {
                changed.Add(file);
            }
        }

        // The scenarios would prove nothing if the reorganizer left the files alone.
        Assert.Contains("Kitchen.cs", changed);
        Assert.Contains("StaticInit.cs", changed);

        var after = Compile(reorganized, level);
        Assert.Equal(Errors(baseline), Errors(after));
        Assert.Equal(expected, Run(after));
    }
}

/// <summary>Tests that redirect <see cref="Console.Out"/> do not run in parallel with each other.</summary>
[CollectionDefinition(nameof(ConsoleCollection), DisableParallelization = true)]
public sealed class ConsoleCollection;
