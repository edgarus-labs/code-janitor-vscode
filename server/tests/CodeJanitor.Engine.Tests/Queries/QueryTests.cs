using System.Text.Json.Nodes;
using CodeJanitor.Engine.Contracts;
using CodeJanitor.Engine.Queries;
using Xunit;
using static CodeJanitor.Engine.Tests.Reorganize.ReorganizeHarness;

namespace CodeJanitor.Engine.Tests.Queries;

internal static class QueryRunner
{
    public static readonly System.Text.Json.JsonSerializerOptions Relaxed = new() { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    public static async Task<JsonNode?> RunAsync(IDocumentQuery query, string source, JsonObject? arguments = null, JsonObject? settings = null)
    {
        var document = await DocumentAsync(source);

        return await query.QueryAsync(document, EngineSettings(settings), arguments, CancellationToken.None);
    }
}

/// <summary>The <c>memberAtPosition</c> query: the member that encloses a position.</summary>
public sealed class MemberAtPositionQueryTests
{
    private const string Source = "namespace N\n{\n    class C\n    {\n        void M()\n        {\n            var x = 1;\n        }\n    }\n}\n";

    private static Task<JsonNode?> At(string source, int line, int character) =>
        QueryRunner.RunAsync(new MemberAtPositionQuery(), source, new JsonObject { ["line"] = line, ["character"] = character });

    [Fact]
    public async Task FindsTheInnermostMemberAtAPosition()
    {
        var member = (await At(Source, 6, 12))!;

        Assert.Equal("M", member["name"]!.GetValue<string>());
        Assert.Equal("method", member["kind"]!.GetValue<string>());
        Assert.StartsWith("void M()", member["text"]!.GetValue<string>());
        Assert.Equal(4, member["startLine"]!.GetValue<int>());
        Assert.Equal(7, member["endLine"]!.GetValue<int>());
        Assert.Equal("void M()", member["signature"]!.GetValue<string>());
    }

    [Fact]
    public async Task FallsBackToTheEnclosingTypeOutsideAnyMethod()
    {
        var member = (await At(Source, 2, 4))!;

        Assert.Equal("C", member["name"]!.GetValue<string>());
        Assert.Equal("class", member["kind"]!.GetValue<string>());
        Assert.Equal("class C", member["signature"]!.GetValue<string>());
    }

    [Fact]
    public async Task ReturnsNullOutsideAnyMember()
    {
        Assert.Null(await At(Source, 0, 0));
    }

    [Fact]
    public async Task HandlesAnEmptySourceAndALineBeyondTheEnd()
    {
        Assert.Null(await At(string.Empty, 0, 0));
        Assert.Null(await At(Source, 99, 0));
    }

    [Fact]
    public async Task TakesInTheDocumentationAndAttributesOfTheMember()
    {
        var source = "class C\n{\n    /// <summary>Does it.</summary>\n    [Obsolete]\n    public int Get(int x) => x;\n}\n";
        var onDocumentation = (await At(source, 2, 10))!;
        var onAttribute = (await At(source, 3, 5))!;

        Assert.Equal("Get", onDocumentation["name"]!.GetValue<string>());
        Assert.Equal(2, onDocumentation["startLine"]!.GetValue<int>());
        Assert.Equal(4, onDocumentation["endLine"]!.GetValue<int>());
        Assert.StartsWith("/// <summary>Does it.</summary>\n    [Obsolete]\n    public int Get", onDocumentation["text"]!.GetValue<string>());
        Assert.Equal("public int Get(int x)", onDocumentation["signature"]!.GetValue<string>());
        Assert.Equal("Get", onAttribute["name"]!.GetValue<string>());
    }

    [Fact]
    public async Task CountsTheEndOfAMemberAsInsideIt()
    {
        var source = "class C\n{\n    int P { get; set; }\n}\n";
        var member = (await At(source, 2, "    int P { get; set; }".Length))!;

        Assert.Equal("P", member["name"]!.GetValue<string>());
        Assert.Equal("property", member["kind"]!.GetValue<string>());
        Assert.Equal("int P", member["signature"]!.GetValue<string>());
    }

    [Fact]
    public async Task NamesConstructorsOperatorsIndexersAndRecords()
    {
        var source = "record R(int X)\n{\n    public R() : this(0) { }\n    public static R operator +(R a, R b) => a;\n    public int this[int i] => i;\n}\n";

        Assert.Equal("constructor", (await At(source, 2, 10))!["kind"]!.GetValue<string>());
        Assert.Equal("operator +", (await At(source, 3, 10))!["name"]!.GetValue<string>());
        Assert.Equal("this[]", (await At(source, 4, 10))!["name"]!.GetValue<string>());
        Assert.Equal("record", (await At(source, 0, 1))!["kind"]!.GetValue<string>());
    }

    [Fact]
    public async Task IgnoresFields()
    {
        var source = "class C\n{\n    int _f = 1;\n}\n";

        Assert.Equal("C", (await At(source, 2, 8))!["name"]!.GetValue<string>());
    }
}

/// <summary>The <c>xmlDocTargets</c> query: which members are selected for documentation.</summary>
public sealed class XmlDocTargetsQueryTests
{
    private static async Task<JsonArray> Targets(string source, JsonObject? arguments = null) =>
        (await QueryRunner.RunAsync(new XmlDocTargetsQuery(), source, arguments ?? []))!.AsArray();

    private static string[] Names(JsonArray targets) => targets.Select(target => target!["name"]!.GetValue<string>()).ToArray();

    [Fact]
    public async Task DescribesAMethodWithEverythingThePromptAndTheBlockNeed()
    {
        var source = "\nnamespace Demo;\n\npublic class Sample\n{\n    [Pure]\n    public string BuildName<T>(string firstName, string lastName)\n    {\n        if (string.IsNullOrWhiteSpace(firstName))\n        {\n            throw new ArgumentException(nameof(firstName));\n        }\n\n        ArgumentNullException.ThrowIfNull(lastName);\n        return firstName + \" \" + lastName;\n    }\n}\n";
        var method = (await Targets(source)).Single(target => target!["kind"]!.GetValue<string>() == "method")!;

        Assert.Equal("BuildName", method["name"]!.GetValue<string>());
        Assert.Equal(5, method["insertionLine"]!.GetValue<int>());
        Assert.Equal("    ", method["indent"]!.GetValue<string>());
        Assert.Equal("public string BuildName<T>(string firstName, string lastName)", method["signature"]!.GetValue<string>());
        Assert.StartsWith("{\n        if (string.IsNullOrWhiteSpace(firstName))", method["body"]!.GetValue<string>());
        Assert.Equal("""[{"name":"firstName","type":"string"},{"name":"lastName","type":"string"}]""", method["parameters"]!.ToJsonString(QueryRunner.Relaxed));
        Assert.Equal("""["T"]""", method["typeParameters"]!.ToJsonString(QueryRunner.Relaxed));
        Assert.Equal("string", method["returnType"]!.GetValue<string>());
        Assert.Equal("""{"name":"Sample","kind":"class"}""", method["containingType"]!.ToJsonString(QueryRunner.Relaxed));
        Assert.Equal("""["ArgumentException","ArgumentNullException"]""", method["exceptions"]!.ToJsonString(QueryRunner.Relaxed));
        Assert.Null(method["accessors"]);
        Assert.StartsWith("[Pure]\n    public string BuildName<T>", method["text"]!.GetValue<string>());
    }

    [Fact]
    public async Task DescribesTypesWithTheirModifiersBaseTypesAndMembers()
    {
        var source = "public sealed record CreateRecipeCommand(string Title, Guid AuthorId) : ICommand<int>\n{\n    public int Count { get; init; }\n    public string Name => Title;\n    public void Run() { }\n    public const int Max = 3;\n}\n\npublic enum Mode { Fast, Slow }\n";
        var targets = await Targets(source);
        var record = targets[0]!;
        var count = targets.Single(target => target!["name"]!.GetValue<string>() == "Count")!;
        var name = targets.Single(target => target!["name"]!.GetValue<string>() == "Name")!;
        var mode = targets.Single(target => target!["name"]!.GetValue<string>() == "Mode")!;

        Assert.Equal("record", record["kind"]!.GetValue<string>());
        Assert.Equal("public sealed record CreateRecipeCommand(string Title, Guid AuthorId) : ICommand<int>", record["signature"]!.GetValue<string>());
        Assert.Equal("""[{"name":"Title","type":"string"},{"name":"AuthorId","type":"Guid"}]""", record["parameters"]!.ToJsonString(QueryRunner.Relaxed));
        Assert.Equal("""["ICommand<int>"]""", record["baseTypes"]!.ToJsonString(QueryRunner.Relaxed));
        Assert.Equal("""["public","sealed"]""", record["modifiers"]!.ToJsonString(QueryRunner.Relaxed));
        Assert.Equal("""["Title (string)","AuthorId (Guid)","Count (int)","Name (string)","Run()","Max"]""", record["members"]!.ToJsonString(QueryRunner.Relaxed));
        Assert.Null(record["returnType"]);
        Assert.Equal("""{"get":true,"set":true}""", count["accessors"]!.ToJsonString(QueryRunner.Relaxed));
        Assert.Equal("""{"get":true,"set":false}""", name["accessors"]!.ToJsonString(QueryRunner.Relaxed));
        Assert.Equal("""["Fast","Slow"]""", mode["members"]!.ToJsonString(QueryRunner.Relaxed));
        Assert.Equal("enum", mode["kind"]!.GetValue<string>());
    }

    [Fact]
    public async Task RespectsTheMemberLimitForAiMembersOnly()
    {
        var source = "\nnamespace Demo;\n\npublic class Sample\n{\npublic int First(int x)\n{\n    return x + 1;\n}\n\npublic int Second(int y)\n{\n    return y + 2;\n}\n\npublic int P { get; set; }\n}\n";

        Assert.Equal(["Sample", "P"], Names(await Targets(source, new JsonObject { ["maxMembersPerFile"] = 1 })));
    }

    [Fact]
    public async Task DocumentsAllConstFieldsRegardlessOfTheMemberLimit()
    {
        var fields = string.Join("\n", Enumerable.Range(0, 50).Select(i => $"    public const int Field{i} = {i};"));
        var source = $"namespace Demo;\npublic static class LargeConstants {{\n{fields}\n}}\n";

        Assert.Equal(51, (await Targets(source, new JsonObject { ["maxMembersPerFile"] = 2 })).Count);
    }

    [Fact]
    public async Task DocumentsPublicConstAndStaticMembers()
    {
        var source = "namespace Demo;\n\npublic class ConfigClass\n{\n    public const string Version = \"1.0\";\n\n    public static readonly string DefaultName = \"Test\";\n\n    public static int StaticCounter { get; set; }\n\n    public static string StaticExpressionProp => \"Hello\";\n}\n";

        Assert.Equal(5, (await Targets(source)).Count);
    }

    [Fact]
    public async Task DocumentsPublicFieldsAndSkipsPrivateOnes()
    {
        var source = "namespace Demo;\n\npublic class FieldSample\n{\n    public string PublicField;\n\n    public int PublicNumber = 42;\n\n    private string _privateField;\n\n    int _unspecifiedPrivate;\n}\n";

        Assert.Equal(["FieldSample", "PublicField", "PublicNumber"], Names(await Targets(source)));
    }

    [Fact]
    public async Task SkipsMembersThatAlreadyHaveDocumentationComments()
    {
        var source = "\nnamespace Demo;\n\npublic class Sample\n{\n/// <summary>\n/// Existing docs.\n/// </summary>\npublic int Existing(int x)\n{\n    return x;\n}\n\n/** <summary>Block docs.</summary> */\npublic int Block() => 1;\n\npublic int Missing(int y)\n{\n    return y;\n}\n}\n";

        Assert.Equal(["Sample", "Missing"], Names(await Targets(source)));
    }

    [Fact]
    public async Task IgnoresObsoleteMembersWhenEnabled()
    {
        var source = "\nnamespace Demo;\n\npublic class Sample\n{\n[Obsolete]\npublic int Legacy(int x)\n{\n    return x;\n}\n\npublic int Active(int y)\n{\n    return y;\n}\n}\n";

        Assert.Equal(["Sample", "Active"], Names(await Targets(source, new JsonObject { ["ignoreObsolete"] = true })));
        Assert.Equal(["Sample", "Legacy", "Active"], Names(await Targets(source)));
    }

    [Fact]
    public async Task IgnoresLikelyTestMethodsAndTypesWhenEnabled()
    {
        var source = "\nnamespace Demo;\n\npublic class SampleTests\n{\n[Fact]\npublic void UsesFact()\n{\n}\n\npublic void AlsoATestByTypeName()\n{\n}\n\npublic void ProductionLike()\n{\n}\n}\n\npublic class RealService\n{\npublic void DoWork()\n{\n}\n}\n";

        Assert.Equal(["RealService", "DoWork"], Names(await Targets(source, new JsonObject { ["ignoreTestMethods"] = true })));
    }

    [Fact]
    public async Task IgnoresMethodsMatchingTheIgnorePattern()
    {
        var source = "\nnamespace Demo;\n\npublic class Sample\n{\npublic void KeepThis()\n{\n}\n\npublic void SkipThisOne()\n{\n}\n}\n";

        Assert.Equal(["Sample", "KeepThis"], Names(await Targets(source, new JsonObject { ["ignorePattern"] = "demo\\.sample\\.skipthisone$" })));
    }

    [Theory]
    [InlineData("([")]
    [InlineData("*")]
    public async Task AnInvalidIgnorePattern_IsAnErrorNotAPatternThatMatchesNothing(string pattern)
    {
        var source = "\nnamespace Demo;\n\npublic class Sample\n{\npublic void KeepThis()\n{\n}\n}\n";

        var error = await Assert.ThrowsAsync<ArgumentException>(() => Targets(source, new JsonObject { ["ignorePattern"] = pattern }));

        Assert.Contains("is not a valid regular expression", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task IgnoresGeneratedCodeWhenEnabled()
    {
        var source = "[System.CodeDom.Compiler.GeneratedCode(\"tool\", \"1\")]\npublic class Generated\n{\n    public void Run() { }\n}\n\npublic class Written\n{\n    [CompilerGenerated]\n    public void Hidden() { }\n    public void Shown() { }\n}\n";

        Assert.Equal(["Written", "Shown"], Names(await Targets(source, new JsonObject { ["ignoreGeneratedCode"] = true })));
    }

    [Fact]
    public async Task SkipsInterfaceMembersAbstractAndExternMethodsAndStaticConstructors()
    {
        var source = "public interface IShape\n{\n    double Area();\n    int Sides { get; }\n}\n\npublic abstract class Shape\n{\n    static Shape() { }\n    public abstract double Area();\n    [DllImport(\"x\")] public static extern int Native();\n}\n";

        Assert.Equal(["IShape", "Shape"], Names(await Targets(source)));
    }

    [Fact]
    public async Task TruncatesTheTextAndReturnsAnEmptyListForABlankFile()
    {
        var source = "public class Sample\n{\n    public void Run() { var x = 1; }\n}\n";
        var run = (await Targets(source, new JsonObject { ["maxInputCharsPerMember"] = 10 })).Single(target => target!["name"]!.GetValue<string>() == "Run")!;

        Assert.Equal("public voi...", run["text"]!.GetValue<string>());
        Assert.Empty(await Targets("   \n"));
    }
}

/// <summary>The <c>structure</c> query: the type and member tree with McCabe complexity (Visual Studio <c>CodeElementHelper.CalculateComplexity</c>).</summary>
public sealed class StructureQueryTests
{
    private const string Source = """
        namespace Shop
        {
            #region Types
            public class Order<T> : IOrder
            {
                private int _a, _b;
                public const int Max = 3;
                public event System.Action Changed;

                public Order() { }

                internal int Total
                {
                    get { return _a > 0 && _b > 0 ? _a : _b; }
                    set { if (value > 0) { _a = value; } else if (value < 0) { _b = value; } else { _a = 0; } }
                }

                protected T Pick<TKey>(T item, int count)
                {
                    // if (comment) is not counted
                    var text = "while (string)";
                    for (var i = 0; i < count; i++)
                    {
                        try { } catch (System.Exception) { }
                    }

                    switch (count)
                    {
                        case 1: return item;
                        case 2: break;
                    }

                    do { count--; } while (count > 0 || count == -1);
                    return count switch { 0 => item, _ => item };
                }

                public static Order<T> operator +(Order<T> a, Order<T> b) => a;
            }

            public enum Mode { Fast }
            #endregion
        }
        """;

    private static async Task<JsonObject> Structure() => (await QueryRunner.RunAsync(new StructureQuery(), Source.Replace("\r\n", "\n", StringComparison.Ordinal)))!.AsObject();

    private static JsonObject Child(JsonNode node, string name) =>
        node["children"]!.AsArray().Single(child => child!["name"]!.GetValue<string>() == name)!.AsObject();

    [Fact]
    public async Task DescribesNamespacesTypesAndMembersWithTheirLines()
    {
        var structure = await Structure();
        var shop = structure["items"]![0]!;
        var order = Child(shop, "Order");

        Assert.Equal("namespace", shop["kind"]!.GetValue<string>());
        Assert.Equal("class", order["kind"]!.GetValue<string>());
        Assert.Equal("public", order["access"]!.GetValue<string>());
        Assert.Equal("""["T"]""", order["typeParameters"]!.ToJsonString(QueryRunner.Relaxed));
        Assert.Equal("""["IOrder"]""", order["baseTypes"]!.ToJsonString(QueryRunner.Relaxed));
        Assert.Equal(3, order["startLine"]!.GetValue<int>());
        Assert.Equal(["_a", "_b", "Max", "Changed", "Order", "Total", "Pick", "operator +"], order["children"]!.AsArray().Select(child => child!["name"]!.GetValue<string>()));
        Assert.Equal(["field", "field", "constant", "event", "constructor", "property", "method", "operator"], order["children"]!.AsArray().Select(child => child!["kind"]!.GetValue<string>()));
        Assert.Equal("private", Child(order, "_a")["access"]!.GetValue<string>());
        Assert.Equal("int", Child(order, "_b")["returnType"]!.GetValue<string>());
        Assert.Equal("enumMember", Child(Child(shop, "Mode"), "Fast")["kind"]!.GetValue<string>());
    }

    [Fact]
    public async Task DescribesMethodsWithTheirSignatureParts()
    {
        var pick = Child(Child((await Structure())["items"]![0]!, "Order"), "Pick");

        Assert.Equal("protected", pick["access"]!.GetValue<string>());
        Assert.Equal("""["protected"]""", pick["modifiers"]!.ToJsonString(QueryRunner.Relaxed));
        Assert.Equal("T", pick["returnType"]!.GetValue<string>());
        Assert.Equal("""[{"name":"item","type":"T"},{"name":"count","type":"int"}]""", pick["parameters"]!.ToJsonString(QueryRunner.Relaxed));
        Assert.Equal("""["TKey"]""", pick["typeParameters"]!.ToJsonString(QueryRunner.Relaxed));
        Assert.Equal(17, pick["startLine"]!.GetValue<int>());
        Assert.Equal(34, pick["endLine"]!.GetValue<int>());
    }

    [Fact]
    public async Task CountsTheMcCabeComplexityLikeVisualStudio()
    {
        var order = Child((await Structure())["items"]![0]!, "Order");
        var total = Child(order, "Total");
        var accessors = total["accessors"]!.AsArray();

        // for, catch, switch, two cases, do-while, ||, switch expression: 1 + 8. Comments and strings do not count.
        Assert.Equal(9, Child(order, "Pick")["complexity"]!.GetValue<int>());
        Assert.Equal(1, Child(order, "Order")["complexity"]!.GetValue<int>());
        Assert.Equal(1, Child(order, "operator +")["complexity"]!.GetValue<int>());
        // get: && and ?: (1 + 2); set: if, else if (counted once), else (1 + 3).
        Assert.Equal(3, accessors[0]!["complexity"]!.GetValue<int>());
        Assert.Equal(4, accessors[1]!["complexity"]!.GetValue<int>());
        Assert.Equal("get", accessors[0]!["kind"]!.GetValue<string>());
        Assert.Equal(6, total["complexity"]!.GetValue<int>());
        Assert.Null(Child(order, "_a")["complexity"]);
    }

    [Fact]
    public async Task ListsTheRegions()
    {
        var regions = (await Structure())["regions"]!.AsArray();

        Assert.Equal("""[{"name":"Types","startLine":2,"endLine":40,"children":[]}]""", regions.ToJsonString(QueryRunner.Relaxed));
    }
}
