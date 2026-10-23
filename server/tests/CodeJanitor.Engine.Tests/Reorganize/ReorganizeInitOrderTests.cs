using CodeJanitor.Engine.Reorganize;
using Xunit;
using static CodeJanitor.Engine.Tests.Reorganize.ReorganizeHarness;

namespace CodeJanitor.Engine.Tests.Reorganize;

public sealed class ReorganizeInitOrderTests
{

    // Field and property initializers run in declaration order, so members whose initializers depend
    // on that order must keep their relative order; everything else is sorted as usual.
    // reorganize: initializers that depend on declaration order
    [Fact]
    public void SortsFieldsWithConstantInitializersFreely()
    {
        var source = "class C\n{\n    static int B = 2;\n    static int A = 1;\n    static string S = \"s\" + \"t\";\n}\n";

        Assert.Equal(new[] { "A", "B", "S" }, Members(Run(source)));
    }

    [Fact]
    public void KeepsAStaticFieldBeforeTheStaticFieldsWhoseInitializersReadIt()
    {
        var source = "class C\n{\n    static int B = A + 1;\n    static int A = 1;\n}\n";
        // B reads A, which is declared after it: that read sees the default, so the order is part of the behaviour.
        Assert.Equal(new[] { "B", "A" }, Members(Run(source)));
    }

    [Fact]
    public void KeepsAStaticFieldBeforeTheOneThatReadsItEvenIfANameSortsTheOtherWay()
    {
        var source = "class C\n{\n    static int Z = 1;\n    static int A = Z * 2;\n}\n";

        Assert.Equal(new[] { "Z", "A" }, Members(Run(source)));
    }

    [Fact]
    public void FollowsAReadThroughThisTheTypeNameAndStringInterpolation()
    {
        var viaThis = "class C\n{\n    static int Z = 1;\n    static int A = C.Z;\n}\n";
        var interpolated = "class C\n{\n    static int Z = 1;\n    static string A = $\"{Z}\";\n}\n";

        Assert.Equal(new[] { "Z", "A" }, Members(Run(viaThis)));
        Assert.Equal(new[] { "Z", "A" }, Members(Run(interpolated)));
    }

    [Fact]
    public void DoesNotMoveAStaticFieldAcrossOneWhoseInitializerRunsCode()
    {
        var source = "class C\n{\n    static int Z = 1;\n    static int M = Compute();\n    static int A = 2;\n    static int Compute() => Z;\n}\n";

        Assert.Equal(new[] { "Z", "M", "A", "Compute" }, Members(Run(source)));
    }

    [Fact]
    public void DoesNotMoveAStaticFieldAcrossAnInitializerThatCreatesAUserDefinedObject()
    {
        var source = "class C\n{\n    static int Z = 1;\n    static Widget W = new Widget();\n    static int A = 2;\n}\n";

        Assert.Equal(new[] { "Z", "W", "A" }, Members(Run(source)));
    }

    [Fact]
    public void TreatsLibraryCollectionsLambdasAndPureStaticCallsAsFreeOfSideEffects()
    {
        var source =
          "class C\n{\n    static Func<int> Z = () => Other;\n    static List<int> L = new List<int>();\n    static object Lock = new object();\n    static int M = Math.Max(1, 2);\n    static int A = 2;\n}\n";

        Assert.Equal(new[] { "A", "L", "Lock", "M", "Z" }, Members(Run(source)));
    }

    [Fact]
    public void KeepsInstanceInitializersThatRunCodeInOrder()
    {
        var source = "class C\n{\n    int Z = Next();\n    int A = Next();\n    static int Next() => 1;\n}\n";

        Assert.Equal(new[] { "Z", "A", "Next" }, Members(Run(source)));
    }

    [Fact]
    public void SortsInstanceFieldsWithPureInitializers()
    {
        var source = "class C\n{\n    int Z = 1;\n    int A = 2;\n}\n";

        Assert.Equal(new[] { "A", "Z" }, Members(Run(source)));
    }

    [Fact]
    public void KeepsAPropertyWithAnInitializerInOrderWithFieldsThatRunCode()
    {
        var source = "class C\n{\n    public static int Count { get; } = Make();\n    static int _b = 2;\n    static int _a = 1;\n    static int Make() => _b;\n}\n";
        var result = Run(source);

        // Count runs code that may read any static, so neither field may move above it.
        Assert.Equal(new[] { "Count", "_a", "_b", "Make" }, Members(result));
    }

    [Fact]
    public void KeepsAFieldBeforeAnInitializerThatReadsAComputedPropertyWhichMayReadTheField()
    {
        var source = "class C\n{\n    static int A = Twice;\n    static int Twice => Z * 2;\n    static int Z = 1;\n}\n";

        Assert.Equal(new[] { "A", "Z", "Twice" }, Members(Run(source)));
    }

    [Fact]
    public void DoesNotMoveAStaticFieldAcrossAnInitializerReadingANameDeclaredOutsideThisTypeBody()
    {
        // Y2 may be a computed property of another partial part, a base class or a `using static` type
        // that reads A: moving A above X would change what X sees.
        var partial = "partial class C\n{\n    static int X = Y2;\n    static int A = 5;\n}\n";
        var inherited = "class C : B\n{\n    static int X = C.Y2 + 1;\n    static int A = 5;\n}\n";

        Assert.Equal(new[] { "X", "A" }, Members(Run(partial)));
        Assert.Equal(new[] { "X", "A" }, Members(Run(inherited)));
    }

    [Fact]
    public void SortsStaticFieldsReadingLibraryEnumValues()
    {
        var regex = "class C\n{\n    static Regex Z = new Regex(\"a\", RegexOptions.CultureInvariant | RegexOptions.Compiled);\n    static int A = 5;\n}\n";
        var flags = "class C\n{\n    static BindingFlags Z = BindingFlags.Public | BindingFlags.Static;\n    static int A = 5;\n}\n";

        Assert.Equal(new[] { "A", "Z" }, Members(Run(regex)));
        Assert.Equal(new[] { "A", "Z" }, Members(Run(flags)));
    }

    [Fact]
    public void SortsStaticFieldsReadingValuesOfAnEnumDeclaredInThisTypeOrAnEnclosingScope()
    {
        var nested = "class C\n{\n    enum Mode { Fast }\n    static Mode Z = Mode.Fast;\n    static int A = 5;\n}\n";
        var enclosing = "enum Level { High }\nclass C\n{\n    private Level _z = Level.High;\n    private int _a = Next();\n    static int Next() => 1;\n}\n";

        Assert.Equal(new[] { "A", "Z", "Mode" }, Members(Run(nested)));
        Assert.Equal(new[] { "_a", "_z", "Next" }, Members(Run(enclosing)));
    }

    [Fact]
    public void DoesNotTreatANestedClassOrATypeThatMayShadowAnEnumAsPure()
    {
        // A static property of a nested class runs its accessor (and static constructor), which may read A.
        var nestedClass = "class C\n{\n    class Mode { public static int Fast => A; }\n    static int Z = Mode.Fast;\n    static int A = 5;\n}\n";
        var shadowed = "enum Mode { Fast }\nclass C\n{\n    class Mode { public static int Fast => A; }\n    static int Z = Mode.Fast;\n    static int A = 5;\n}\n";
        // A nested type of a base class that does not resolve may shadow the outer enum.
        var inherited = "enum Mode { Fast }\nclass C : B\n{\n    static int Z = Mode.Fast;\n    static int A = 5;\n}\n";
        var partial = "enum Mode { Fast }\npartial class C\n{\n    static int Z = Mode.Fast;\n    static int A = 5;\n}\n";

        Assert.Equal(new[] { "Z", "A", "Mode" }, Members(Run(nestedClass)));
        Assert.Equal(new[] { "Z", "A", "Mode" }, Members(Run(shadowed)));
        Assert.Equal(new[] { "Z", "A" }, Members(Run(inherited)));
        // The semantic model sees every part of C in the compilation: no other part declares a Mode, so Mode.Fast is the enum value.
        Assert.Equal(new[] { "A", "Z" }, Members(Run(partial)));
    }

    [Fact]
    public void DoesNotTreatANameAsAnEnumWhenAnEnclosingTypeDeclaresAMemberOfThatName()
    {
        // Simple-name lookup binds `Mode` to Outer's property before the enum, so `Mode.Fast` runs Holder.Fast,
        // which reads Z: A must stay after Z.
        var source =
          "enum Mode { Fast }\nclass Holder { public int Fast => Outer.C.Z; }\nstatic class Outer\n{\n    static Holder Mode => new Holder();\n    public static class C\n    {\n        public static int Z = 5;\n        public static int A = Mode.Fast;\n    }\n}\n";
        var result = Run(source);

        Assert.True(result.IndexOf("int Z = 5") < result.IndexOf("int A = Mode.Fast"));
    }

    [Fact]
    public void DoesNotReadTheAlignmentAndFormatOfAnInterpolationHoleAsNames()
    {
        var format = "class C\n{\n    const double V = 1;\n    static string Z = $\"{V:N2}\";\n    static int A = 5;\n}\n";
        var date = "class C\n{\n    static readonly DateTime D;\n    static string Z = $\"{D,10:yyyy-MM-dd}\";\n    static int A = 5;\n}\n";

        Assert.Equal(new[] { "V", "A", "Z" }, Members(Run(format)));
        Assert.Equal(new[] { "D", "A", "Z" }, Members(Run(date)));
    }

    [Fact]
    public void ReadsTheNamesOfAnInterpolationHoleThatContainsBraces()
    {
        // The switch subject Z is read: moving A above Z makes the hole see Z == 0.
        var switched = "class C\n{\n    static int Z = 1;\n    static string A = $\"{Z switch { 1 => 10, _ => 20 }}\";\n}\n";

        Assert.Equal(new[] { "Z", "A" }, Members(Run(switched)));
    }

    [Fact]
    public void DoesNotTreatAPropertyPatternWhichRunsGettersAsFreeOfSideEffects()
    {
        var source = "struct S { public int P => C.A; }\nclass C\n{\n    static S s;\n    public static bool B = s is { P: 1 };\n    public static int A = 1;\n}\n";
        var result = Run(source);

        Assert.True(result.IndexOf("bool B") < result.IndexOf("int A = 1"));
    }

    [Fact]
    public void SortsStaticFieldsTestingATypeOrConstantPattern()
    {
        var source = "class C\n{\n    static object o;\n    static bool Z = o is null;\n    static bool Y = o is string;\n    static int A = 5;\n}\n";

        Assert.Equal(new[] { "A", "o", "Y", "Z" }, Members(Run(source)));
    }

    [Fact]
    public void AppliesTheConstraintsToTheMembersOfAIfBlock()
    {
        var source = "class C\n{\n    static int Z = 1;\n#if X\n    static int A = Z;\n#endif\n}\n";

        Assert.Equal(new[] { "Z", "A" }, Members(Run(source, new ReorganizeSettings { PerformWhenPreprocessorConditionals = PreprocessorPolicy.Yes })));
    }

    [Fact]
    public void StillSortsFieldsWithoutInitializersAroundConstrainedOnes()
    {
        var source = "class C\n{\n    static int Z = 1;\n    static int M;\n    static int A = Z;\n    static int B;\n}\n";

        Assert.Equal(new[] { "B", "M", "Z", "A" }, Members(Run(source)));
    }

    [Fact]
    public void DoesNotOrderConstantsByTheirDependencies()
    {
        var source = "class C\n{\n    const int B = A + 1;\n    const int A = 1;\n}\n";

        Assert.Equal(new[] { "A", "B" }, Members(Run(source)));
    }

    [Fact]
    public void KeepsInitializersThatIncrementAFieldWithPostfixOrInOrder()
    {
        // Each `counter++` both reads and changes counter: swapping them swaps the values a and b get.
        var staticForm = "class C\n{\n    static int counter;\n    static int b = counter++;\n    static int a = counter--;\n}\n";
        var instanceForm = "class C\n{\n    static int counter;\n    int b = counter++;\n    int a = counter++;\n}\n";

        Assert.Equal(new[] { "b", "a", "counter" }, Members(Run(staticForm)));
        Assert.Equal(new[] { "counter", "b", "a" }, Members(Run(instanceForm)));
    }

    [Fact]
    public void KeepsAnInstanceInitializerReadingAStaticFieldAfterOneThatRunsCodeWhichMayChangeIt()
    {
        var increment = "class C\n{\n    static int counter;\n    int z = ++counter;\n    int b = counter;\n}\n";
        var call = "class C\n{\n    static int counter = 0;\n    int z = Next();\n    int b = counter;\n    static int Next() => ++counter;\n}\n";

        Assert.Equal(new[] { "counter", "z", "b" }, Members(Run(increment)));
        Assert.Equal(new[] { "counter", "z", "b", "Next" }, Members(Run(call)));
    }

    [Fact]
    public void KeepsAnInstanceInitializerReadingAPrimaryConstructorParameterAfterOneThatChangesIt()
    {
        // `x++` changes x: moving _a above _z makes _a read x before the increment.
        var source = "class C(int x)\n{\n    private int _z = x++;\n    private int _a = x;\n}\n";

        Assert.Equal(new[] { "_z", "_a" }, Members(Run(source)));
    }

    [Fact]
    public void KeepsAnInstanceInitializerReadingProcessStateAfterOneThatRunsCodeWhichMayChangeIt()
    {
        // Set changes the environment variable and the current directory the later initializers read.
        var call = "class C\n{\n    private bool _z = Set();\n    private string _a = Environment.GetEnvironmentVariable(\"MODE\");\n    static bool Set() { Environment.SetEnvironmentVariable(\"MODE\", \"on\"); return true; }\n}\n";
        var property = "class C\n{\n    private bool _z = Set();\n    private string _a = Environment.CurrentDirectory;\n    static bool Set() { Environment.CurrentDirectory = \"/\"; return true; }\n}\n";

        Assert.Equal(new[] { "_z", "_a", "Set" }, Members(Run(call)));
        Assert.Equal(new[] { "_z", "_a", "Set" }, Members(Run(property)));
    }

    [Fact]
    public void KeepsAnInstanceInitializerReadingAStaticFieldOfALibraryAfterOneThatRunsCodeWhichMayChangeIt()
    {
        var library = Library("public static class Holder { public static int Value; }");
        var (tree, model) = Compile("class C\n{\n    private bool _z = Set();\n    private int _a = Holder.Value;\n    static bool Set() { Holder.Value = 1; return true; }\n}\n", references: [library]);

        var result = Reorganizer.Reorganize(tree, model, new ReorganizeSettings(), ReorganizeCleanup.WithoutPadding);

        Assert.Equal(new[] { "_z", "_a", "Set" }, Members(result.Output));
    }

    [Fact]
    public void FollowsAReadThroughTheGenericTypeNameAndTreatsAnotherGenericTypeAsRunningCode()
    {
        // B = C<T>.Z + 1 reads Z; G<int>.V may run G's static constructor, which may read Z.
        var self = "class C<T>\n{\n    public static int Z = 1;\n    public static int B = C<T>.Z + 1;\n}\n";
        var other = "class C\n{\n    public static int Z = 1;\n    public static int B = G<int>.V + 1;\n}\n";
        var library = "class C\n{\n    public static int Z = 1;\n    public static EqualityComparer<int> B = EqualityComparer<int>.Default;\n}\n";

        Assert.Equal(new[] { "Z", "B" }, Members(Run(self)));
        Assert.Equal(new[] { "Z", "B" }, Members(Run(other)));
        Assert.Equal(new[] { "B", "Z" }, Members(Run(library)));
    }

    [Fact]
    public void KeepsThePartsOfAPartialTypeInOrderSinceTheirInitializersRunInDeclarationOrder()
    {
        // B = A + 1 reads A from the earlier part: swapping the parts makes B read the default of A.
        var access = "partial class C\n{\n    public static int A = 1;\n}\n\npublic partial class C\n{\n    public static int B = A + 1;\n}\n";
        var staticPart = "partial class C\n{\n    public static int A = 1;\n}\n\nstatic partial class C\n{\n    public static int B = A + 1;\n}\n";
        var conditional = "partial class C\n{\n    public static int A = 1;\n}\n\n#if DEBUG\npublic class Helper\n{\n}\n\npublic partial class C\n{\n    public static int B = A + 1;\n}\n#endif\n";

        Assert.Equal(access, Run(access));
        Assert.Equal(staticPart, Run(staticPart));
        Assert.Equal(conditional, Run(conditional, new ReorganizeSettings { PerformWhenPreprocessorConditionals = PreprocessorPolicy.Yes }));
    }

    [Fact]
    public void TreatsAValueConvertedToATypeDeclaredInTheProgramAsRunningAConversionOperator()
    {
        // Alpha = 2 runs `implicit operator Meters(int)`, which reads Scale: Scale must stay before Alpha.
        var literal =
          "struct Meters\n{\n    static readonly int Scale = 10;\n    static readonly Meters Alpha = 2;\n    int value;\n    public static implicit operator Meters(int v) => new Meters { value = v * Scale };\n}\n";
        var cast = "class C\n{\n    static int Scale = 10;\n    static Meters Alpha = (Meters)2;\n}\n";

        Assert.Equal(new[] { "Scale", "Alpha", "value", "Meters" }, Members(Run(literal)));
        Assert.Equal(new[] { "Scale", "Alpha" }, Members(Run(cast)));
    }

    [Fact]
    public void TreatsAnOperatorIndexerOrConversionOnAValueOfATypeDeclaredInTheProgramAsRunningCode()
    {
        // `Base * 2` runs `operator *(Meters, int)`, which reads Scale: Scale must stay before Doubled.
        var operatorSource =
          "struct Meters\n{\n    static readonly int Scale = 10;\n    static readonly Meters Base = default;\n    static readonly int Doubled = Base * 2;\n    int value;\n    public static int operator *(Meters m, int k) => (m.value + k) * Scale;\n}\n";
        // `Table[0]` runs the indexer of Lookup, `-Base` its unary operator, `(int)Base` and `= Base` its conversion.
        var indexer = "class C\n{\n    static int Scale = 10;\n    static Lookup Table = null;\n    static int Doubled = Table[0];\n}\n";
        var unary = "class C\n{\n    static int Scale = 10;\n    static Meters Base;\n    static Meters Doubled = -Base;\n}\n";
        var explicitCast = "class C\n{\n    static int Scale = 10;\n    static Meters Base;\n    static int Doubled = (int)Base;\n}\n";
        var implicitConversion = "class C\n{\n    static int Scale = 10;\n    static Meters Base;\n    static int Doubled = Base;\n}\n";
        var conditionalAccess = "class C\n{\n    static int Scale = 10;\n    static Holder Base;\n    static int? Doubled = Base?.Value;\n}\n";
        var getter = "class C\n{\n    static int Scale = 10;\n    static Holder Base;\n    static int Doubled = Base.Value;\n}\n";
        var interpolated = "class C\n{\n    static int Scale = 10;\n    static Holder Base;\n    static string Doubled = $\"{Base}\";\n}\n";
        var concatenated = "class C\n{\n    static int Scale = 10;\n    static Holder Base;\n    static string Doubled = \"x\" + Base;\n}\n";
        var equality = "class C\n{\n    static int Scale = 10;\n    static Holder Base;\n    static bool Doubled = Base == null;\n}\n";

        // Base (`default`) runs nothing and may move; Doubled must stay after Scale.
        Assert.Equal(new[] { "Base", "Scale", "Doubled", "value" }, Members(Run(operatorSource)));
        var sources = new Dictionary<string, string>
        {
            ["indexer"] = indexer,
            ["unary"] = unary,
            ["explicitCast"] = explicitCast,
            ["implicitConversion"] = implicitConversion,
            ["conditionalAccess"] = conditionalAccess,
            ["getter"] = getter,
            ["interpolated"] = interpolated,
            ["concatenated"] = concatenated,
            ["equality"] = equality,
        };
        var reordered = sources.Where(pair =>
        {
            var result = Run(pair.Value);

            return result.IndexOf("Scale = 10", StringComparison.Ordinal) > result.IndexOf("Doubled =", StringComparison.Ordinal);
        }).Select(pair => pair.Key);
        Assert.Empty(reordered);
    }

    [Fact]
    public void KeepsAFieldReadThroughTheGetterOfAnotherTypeDeclaredInTheProgramAfterTheFieldsThatGetterReads()
    {
        // `Cfg.Port` runs Config.Port, which reads C.BasePort: sorting BasePort before Port would make Port 8001 instead of 1.
        var source =
          "class Config { public int Port => C.BasePort + 1; }\nclass C\n{\n    static readonly Config Cfg = new Config();\n    static readonly int Port = Cfg.Port;\n    static readonly int BasePort = 8000;\n}\n";
        var result = Run(source);

        Assert.True(result.IndexOf("int Port =") < result.IndexOf("int BasePort ="));
    }

    [Fact]
    public void StillSortsOperatorsIndexersAndCastsOnValuesOfPredefinedLibraryAndEnumTypes()
    {
        var source =
          "class C\n{\n    static int[] Values = { 1 };\n    static string Z = \"z\" + Values[0] + -Values[0] + (long)Values[0] + (Values.Length > 0 ? 1 : 2);\n    static int A = Math.Max(1, 2) * 2;\n}\n";

        Assert.Equal(new[] { "A", "Values", "Z" }, Members(Run(source)));
    }

    [Fact]
    public async Task AnalysesLongOperatorChainsInLinearTime()
    {
        // Each level of a left-nested `+` chain, a right-nested `?:` chain and an indexer chain is analysed once:
        // analysing an operand twice per level makes each chain take 2^60 steps, which never finishes. The bound is only
        // there to turn that hang into a failure; linear analysis takes milliseconds.
        var terms = string.Join(" + ", Enumerable.Range(0, 60).Select(i => $"\"part{i} \""));
        var conditions = string.Concat(Enumerable.Range(0, 60).Select(i => $"B > {i} ? {i} : ")) + "0";
        var indexers = "Grid" + string.Concat(Enumerable.Repeat("[0]", 60));
        var source = $"class C\n{{\n    static int B = 2;\n    static string Sql = {terms};\n    static int Pick = {conditions};\n    static int[] Grid = {{ 1 }};\n    static object Cell = {indexers};\n    static int A = 1;\n}}\n";

        var result = await Task.Run(() => Run(source)).WaitAsync(TimeSpan.FromSeconds(30));

        // Pick reads B. Indexing the int Grid[0] does not compile, so Cell may run any code and no static initializer crosses it.
        Assert.Equal(new[] { "B", "Grid", "Pick", "Sql", "Cell", "A" }, Members(result));
    }
}

