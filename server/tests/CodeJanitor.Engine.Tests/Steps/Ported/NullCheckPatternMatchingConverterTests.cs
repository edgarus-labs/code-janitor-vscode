#nullable disable
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using CodeJanitor.Engine.Steps.Transformations;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;
using Xunit;
using Assert = CodeJanitor.Engine.Tests.Steps.Support.MsAssert;

namespace CodeJanitor.Engine.Tests.Steps;

/// <summary>
/// Unit tests for <see cref="NullCheckPatternMatchingConverter" />.
/// </summary>
public sealed class NullCheckPatternMatchingConverterTests
{
    /// <summary>A class with user-defined equality operators that give <c>null</c> a meaning of their own.</summary>
    private const string HandleWithEqualityOperators =
        "public class H\r\n{\r\n" +
        "    public static bool operator ==(H a, H b) => true;\r\n" +
        "    public static bool operator !=(H a, H b) => false;\r\n" +
        "    public override bool Equals(object o) => true;\r\n" +
        "    public override int GetHashCode() => 0;\r\n" +
        "}\r\n";

    /// <summary>A struct with user-defined equality operators, which C# lifts to <c>S?</c>.</summary>
    private const string StructWithEqualityOperators =
        "public struct S\r\n{\r\n" +
        "    public static bool operator ==(S a, S b) => true;\r\n" +
        "    public static bool operator !=(S a, S b) => false;\r\n" +
        "    public override bool Equals(object o) => true;\r\n" +
        "    public override int GetHashCode() => 0;\r\n" +
        "}\r\n";

    private static readonly MetadataReference SystemCoreReference = MetadataReference.CreateFromFile(typeof(Enumerable).Assembly.Location);

    [Theory]
    [InlineData("class C { bool M(object x) => x /*why*/ == /*b*/ null; }", "class C { bool M(object x) => x /*why*/ is /*b*/ null; }")]
    [InlineData("class C { bool M(object x) => x /*why*/ != /*b*/ null; }", "class C { bool M(object x) => x /*why*/ is not /*b*/ null; }")]
    [InlineData("class C { bool M(object x) => x // why\n == null; }", "class C { bool M(object x) => x // why\n is null; }")]
    [InlineData("class C { bool M(object x) => null /*why*/ == x; }", "class C { bool M(object x) => null /*why*/ == x; }")]
    public async Task CommentsInsideNullCheck_AreKept(string input, string expected) => Assert.AreEqual(expected, await ConvertAsync(input));

    [Theory]
    [InlineData("class C { bool M(object a, object b) => a == b == null; }")]
    [InlineData("class C { bool M(object a, object b) => a != b != null; }")]
    public async Task EqualityOperand_IsUnchanged(string input)
        // A bool operand is not a reference type, so the semantic gate already rejects the outer check.
        => Assert.AreEqual(input, await ConvertAsync(input));

    [Theory]
    [InlineData("a == b == null")]
    [InlineData("a != b != null")]
    public async Task UserDefinedEqualityReturningReference_AsOperand_IsUnchanged(string expression)
    {
        // `a == b is null` would parse as `a == (b is null)`; the outer check is a reference check, so only the operand guard prevents it.
        string input =
            "class R { }\n" +
            "class H { public static R operator ==(H a, H b) => null; public static R operator !=(H a, H b) => null; }\n" +
            "class C { bool M(H a, H b) => " + expression + "; }\n";

        Assert.AreEqual(input, await ConvertAsync(input));
    }

    [Fact]
    public async Task FileDeclaringEqualityOperator_IsUnchanged()
    {
        string input =
            "class H { public static bool operator ==(H a, H b) => true; public static bool operator !=(H a, H b) => false; }\n" +
            "class C { bool M(H h) => h == null; bool N(H h) => h != null; }\n";

        Assert.AreEqual(input, await ConvertAsync(input));
    }

    [Fact]
    public async Task Apply_CompilesWhereLambdasMayBecomeExpressionTrees_AndConvertsElsewhere()
    {
        // An 'is' pattern is not allowed in an expression tree (CS8122); only syntax that can never become one is converted.
        string input =
            "using System;\r\nusing System.Linq;\r\nusing System.Linq.Expressions;\r\n\r\n" +
            "class Item { public string Name; }\r\n\r\n" +
            "class C\r\n{\r\n" +
            "    Expression<Func<Item, bool>> tree = item => item.Name != null;\r\n" +
            "    Expression<Func<Item, object>> projection = item => new { Missing = item.Name == null };\r\n" +
            "    IQueryable<Item> Query(IQueryable<Item> items) => items.Where(item => item.Name != null);\r\n" +
            "    IQueryable<Item> Syntax(IQueryable<Item> items) => from item in items where item.Name == null select item;\r\n" +
            "    Func<Item, bool> Block => item => { return item.Name != null; };\r\n" +
            "    bool Method(Item item) => item.Name == null;\r\n" +
            "}\r\n";
        Document document = CompilingTestProject.CreateDocument(input, LanguageVersion.CSharp9, new[] { SystemCoreReference });

        string output = await ConvertAsync(document);

        IReadOnlyList<string> errors = await CompilingTestProject.GetCompileErrorsAsync(document, output);
        Assert.IsEmpty(errors, output + "\r\n" + string.Join("\r\n", errors));
        Assert.Contains("item => item.Name != null;", output);
        Assert.Contains("Missing = item.Name == null", output);
        Assert.Contains("items.Where(item => item.Name != null)", output);
        Assert.Contains("where item.Name == null", output);
        Assert.Contains("{ return item.Name is not null; }", output);
        Assert.Contains("bool Method(Item item) => item.Name is null;", output);
    }

    [Fact]
    public async Task Apply_NotEqualsNull_ConvertsToIsNotNull()
    {
        string input = @"
public class C
{
    public void M(object x)
    {
        if (x != null)
        {
            DoWork();
        }
    }
}";
        string expected = @"
public class C
{
    public void M(object x)
    {
        if (x is not null)
        {
            DoWork();
        }
    }
}";

        string result = await ConvertAsync(input);

        Assert.AreEqual(expected, result);
    }

    [Fact]
    public async Task Apply_EqualsEqualsNull_ConvertsToIsNull()
    {
        string input = @"
public class C
{
    public void M(object x)
    {
        if (x == null)
        {
            return;
        }
    }
}";
        string expected = @"
public class C
{
    public void M(object x)
    {
        if (x is null)
        {
            return;
        }
    }
}";

        string result = await ConvertAsync(input);

        Assert.AreEqual(expected, result);
    }

    [Fact]
    public async Task Apply_ReversedNullChecks_ConvertsProperly()
    {
        string input = @"
public class C
{
    public void M(object a, object b)
    {
        if (null != a && null == b)
        {
            DoWork();
        }
    }
}";
        string expected = @"
public class C
{
    public void M(object a, object b)
    {
        if (a is not null && b is null)
        {
            DoWork();
        }
    }
}";

        string result = await ConvertAsync(input);

        Assert.AreEqual(expected, result);
    }

    [Fact]
    public async Task Apply_TernaryAndReturnExpressions_ConvertsProperly()
    {
        string input = @"
public class C
{
    public bool Check(object x, object y)
    {
        var flag = x != null ? true : false;
        return y == null;
    }
}";
        string expected = @"
public class C
{
    public bool Check(object x, object y)
    {
        var flag = x is not null ? true : false;
        return y is null;
    }
}";

        string result = await ConvertAsync(input);

        Assert.AreEqual(expected, result);
    }

    [Fact]
    public async Task EmptyFile_IsUnchanged() => Assert.AreEqual(string.Empty, await ConvertAsync(string.Empty));

    [Fact]
    public async Task NullDocumentList_Throws()
    {
        ArgumentException exception = await Assert.ThrowsAsync<ArgumentException>(
            () => new NullCheckPatternMatchingConverter().ConvertAsync(null, CancellationToken.None));

        Assert.AreEqual("documents", exception.ParamName);
    }

    [Fact]
    public async Task EmptyDocumentList_Throws()
    {
        ArgumentException exception = await Assert.ThrowsAsync<ArgumentException>(
            () => new NullCheckPatternMatchingConverter().ConvertAsync(new Document[0], CancellationToken.None));

        Assert.AreEqual("documents", exception.ParamName);
    }

    [Fact]
    public async Task Apply_EqualsNullInsideExpressionBodiedLambda_LeavesUnchanged()
    {
        string input = @"
using System.Collections.Generic;
using System.Linq;

class C
{
    void M(IEnumerable<string> items)
    {
        var found = items.Any(x => x == null);
    }
}";

        string actual = await ConvertAsync(input);

        // Deliberately conservative: every expression-bodied non-async lambda is skipped, because it may be bound to
        // Expression<Func<T, bool>> (e.g. IQueryable .Where/.Any), and `is null` in an expression tree
        // fails to compile with CS8122.
        Assert.Contains("x == null", actual);
        Assert.DoesNotContain("x is null", actual);
    }

    [Fact]
    public async Task Apply_NotEqualsNullInsideExpressionBodiedLambda_LeavesUnchanged()
    {
        string input = @"
using System.Collections.Generic;
using System.Linq;

class C
{
    void M(IEnumerable<string> items)
    {
        var found = items.Any(x => x != null);
    }
}";

        string actual = await ConvertAsync(input);

        Assert.Contains("x != null", actual);
        Assert.DoesNotContain("is not null", actual);
    }

    [Fact]
    public async Task Apply_EqualsNullInsideBlockBodiedLambda_ConvertsToIsNull()
    {
        string input = @"
using System.Collections.Generic;
using System.Linq;

class C
{
    void M(IEnumerable<string> items)
    {
        var found = items.Any(x =>
        {
            return x == null;
        });
    }
}";

        string actual = await ConvertAsync(input);

        // A block-bodied lambda can never be compiled to an expression tree (CS0834), so this is
        // always safe to convert.
        Assert.Contains("x is null", actual);
        Assert.DoesNotContain("== null", actual);
    }

    [Fact]
    public async Task Apply_EqualsNullInsideAsyncLambda_ConvertsToIsNull()
    {
        string input = @"
using System;
using System.Threading.Tasks;

class C
{
    void M()
    {
        Func<string, Task<bool>> f = async x => await Task.FromResult(x == null);
    }
}";

        string actual = await ConvertAsync(input);

        // An async lambda can never be compiled to an expression tree (CS1989), so this is always
        // safe to convert.
        Assert.Contains("x is null", actual);
    }

    [Fact]
    public async Task Apply_EqualsNullInsideAnonymousMethod_ConvertsToIsNull()
    {
        string input = @"
using System;

class C
{
    void M()
    {
        Func<string, bool> f = delegate (string x)
        {
            return x == null;
        };
    }
}";

        string actual = await ConvertAsync(input);

        // An anonymous method can never be compiled to an expression tree (CS1946), so this is
        // always safe to convert.
        Assert.Contains("x is null", actual);
    }

    [Fact]
    public async Task Apply_EqualsNullInQueryWhereClause_LeavesUnchanged()
    {
        string input = @"
using System.Collections.Generic;
using System.Linq;

class C
{
    void M(IEnumerable<string> items)
    {
        var result = from x in items where x == null select x;
    }
}";

        string actual = await ConvertAsync(input);

        // Deliberately conservative: a query clause's condition cannot rule out an IQueryable
        // source being translated to an expression tree, so it is never rewritten.
        Assert.Contains("x == null", actual);
        Assert.DoesNotContain("x is null", actual);
    }

    [Theory]
    [InlineData("  \r\n\t")]
    [InlineData("class C { bool M(object a, object b) => a == b || a != b; }")]
    [InlineData("class C { bool M(int? a) => a > null; }")]
    [InlineData("class C { object M(object a) => a ?? null; }")]
    [InlineData("class C { string A = \"x == null\"; string B = @\"x != null\"; string D = $\"{1} x == null\"; }")]
    [InlineData("class C\r\n{\r\n    // if (x == null)\r\n    /// <remarks>x != null</remarks>\r\n    void M() { }\r\n}\r\n")]
    [InlineData("class C\r\n{\r\n    bool M(object x)\r\n    {\r\n#if NEVER\r\n        return x == null;\r\n#endif\r\n        return false;\r\n    }\r\n}\r\n")]
    [InlineData("class C { const string Mode = null; const bool B = Mode == null; const bool N = null != Mode; }")]
    [InlineData("class C { const string Mode = null; void M(bool b = Mode == null) { } }")]
    [InlineData("[System.Obsolete(null, C.Mode != null)] class C { public const string Mode = null; }")]
    [InlineData("class C { const string Mode = null; int M(bool b) { switch (b) { case Mode == null: return 1; default: return 0; } } }")]
    public async Task SourceWithoutConvertibleNullCheck_IsUnchanged(string input) => Assert.AreEqual(input, await ConvertAsync(input));

    [Theory]
    [InlineData(LanguageVersion.CSharp7)]
    [InlineData(LanguageVersion.CSharp8)]
    public async Task BeforeCSharp9_ConvertsOnlyEqualityChecks(LanguageVersion languageVersion)
    {
        string input = "class C { bool M(object a, object b) => a == null && b != null && null != a && null == b; }";
        string expected = "class C { bool M(object a, object b) => a is null && b != null && null != a && b is null; }";

        Assert.AreEqual(expected, await ConvertAsync(input, languageVersion));
    }

    [Theory]
    [InlineData("class C { static string S = \"\"; bool F = S == null; }", "class C { static string S = \"\"; bool F = S is null; }")]
    [InlineData("class C { C(object o) { if (o == null) { } } }", "class C { C(object o) { if (o is null) { } } }")]
    [InlineData("class C { object _o; bool P { get { return _o != null; } } }", "class C { object _o; bool P { get { return _o is not null; } } }")]
    [InlineData("class C { object _o; bool P => _o == null; }", "class C { object _o; bool P => _o is null; }")]
    [InlineData("class C { bool this[object o] => o == null; }", "class C { bool this[object o] => o is null; }")]
    [InlineData("class C { public static bool operator !(C c) => c == null; }", "class C { public static bool operator !(C c) => c is null; }")]
    [InlineData("class C { void M() { bool L(object o) => o != null; } }", "class C { void M() { bool L(object o) => o is not null; } }")]
    [InlineData("class C { System.Func<object, bool> F = delegate (object o) { return o == null; }; }", "class C { System.Func<object, bool> F = delegate (object o) { return o is null; }; }")]
    [InlineData("class C { System.Func<object, System.Threading.Tasks.Task<bool>> F = async o => o == null; }", "class C { System.Func<object, System.Threading.Tasks.Task<bool>> F = async o => o is null; }")]
    [InlineData("class C { System.Func<object, bool> F = (o) => { return o != null; }; }", "class C { System.Func<object, bool> F = (o) => { return o is not null; }; }")]
    [InlineData("record R(string Name) { public bool Unnamed => Name == null; }", "record R(string Name) { public bool Unnamed => Name is null; }")]
    [InlineData("class C<T> { bool M(T value) => value == null; }", "class C<T> { bool M(T value) => value is null; }")]
    [InlineData("class C { bool M(int? i) => i != null; }", "class C { bool M(int? i) => i is not null; }")]
    public async Task NullCheckOutsideExpressionLambdasAndQueries_IsConverted(string input, string expected) => Assert.AreEqual(expected, await ConvertAsync(input));

    [Theory]
    [InlineData("class C { bool M(C a) => (a) == null; }", "class C { bool M(C a) => (a) is null; }")]
    [InlineData("class C { C Next; bool M(C a) => a?.Next == null; }", "class C { C Next; bool M(C a) => a?.Next is null; }")]
    [InlineData("class C { bool M(object o) => (string)o != null; }", "class C { bool M(object o) => (string)o is not null; }")]
    [InlineData("class C { bool M(object o) => o as string == null; }", "class C { bool M(object o) => o as string is null; }")]
    [InlineData("class C { bool M(object[] a) => a[0] == null; }", "class C { bool M(object[] a) => a[0] is null; }")]
    [InlineData("class C { async System.Threading.Tasks.Task<bool> M(System.Threading.Tasks.Task<object> t) => await t == null; }", "class C { async System.Threading.Tasks.Task<bool> M(System.Threading.Tasks.Task<object> t) => await t is null; }")]
    [InlineData("class C { string M(object o) => $\"{o == null}\"; }", "class C { string M(object o) => $\"{o is null}\"; }")]
    [InlineData("class C { int M(object o) { switch (o) { case string s when s != null: return 1; default: return 0; } } }", "class C { int M(object o) { switch (o) { case string s when s is not null: return 1; default: return 0; } } }")]
    [InlineData("class C { bool M(object a, object b) => a == null ? b != null : false; }", "class C { bool M(object a, object b) => a is null ? b is not null : false; }")]
    [InlineData("class C { bool M(object a) => !(a == null); }", "class C { bool M(object a) => !(a is null); }")]
    public async Task OperandShapes_AreConvertedWithoutParenthesesChanges(string input, string expected) => Assert.AreEqual(expected, await ConvertAsync(input));

    [Theory]
    [InlineData("class C { System.Func<object, bool> F => o => o == null; }")]
    [InlineData("class C { void M() { System.Action a = () => { System.Func<object, bool> f = y => y != null; }; } }")]
    [InlineData("class C { void M() { System.Func<object, System.Func<object, bool>> f = x => y => x == y || y == null; } }")]
    [InlineData("class C { object M(int[] xs) => from x in xs let y = (object)x == null select y; }")]
    [InlineData("class C { object M(object[] xs) => from x in xs select x == null; }")]
    [InlineData("class C { object M(object[] xs) => from x in xs orderby x != null select x; }")]
    [InlineData("class C { object M(object[] xs) => from x in xs group x by x == null; }")]
    public async Task NullCheckThatMayEndUpInAnExpressionTree_IsUnchanged(string input) => Assert.AreEqual(input, await ConvertAsync(input));

    [Fact]
    public async Task TopLevelStatementsFile_ConvertsStatementsLocalFunctionsAndTypes()
    {
        string input =
            "using System;\r\n" +
            "\r\n" +
            "if (args == null)\r\n" +
            "{\r\n" +
            "    return;\r\n" +
            "}\r\n" +
            "\r\n" +
            "Console.WriteLine(Check(args[0]));\r\n" +
            "\r\n" +
            "static bool Check(string value) => value != null;\r\n" +
            "\r\n" +
            "class Helper\r\n" +
            "{\r\n" +
            "    Func<string, bool> _tree = s => s == null;\r\n" +
            "    bool M(string s) => s == null;\r\n" +
            "}\r\n";
        string expected = input
            .Replace("if (args == null)", "if (args is null)")
            .Replace("value != null;", "value is not null;")
            .Replace("bool M(string s) => s == null;", "bool M(string s) => s is null;");

        Assert.AreEqual(expected, await ConvertAsync(input));
    }

    [Theory]
    [InlineData("\r\n")]
    [InlineData("\n")]
    public async Task TriviaAroundTheNullCheck_IsPreserved(string newLine)
    {
        string input =
            "namespace N" + newLine +
            "{" + newLine +
            "\tclass C" + newLine +
            "\t{" + newLine +
            "\t\tbool M(object x, object y)" + newLine +
            "\t\t{" + newLine +
            "\t\t\t// leading comment" + newLine +
            "\t\t\treturn /*a*/x == null/*b*/ && y != null; // trailing" + newLine +
            "\t\t}" + newLine +
            "\t}" + newLine +
            "}" + newLine;
        string expected = input.Replace("/*a*/x == null/*b*/ && y != null;", "/*a*/x is null/*b*/ && y is not null;");

        Assert.AreEqual(expected, await ConvertAsync(input));
    }

    [Fact]
    public async Task FileWithSyntaxErrors_ConvertsTheValidNullCheckAndKeepsTheRestVerbatim()
    {
        string input = "class C { bool M(object x) { return x == null; } void N( { int y = ; } }";
        string expected = "class C { bool M(object x) { return x is null; } void N( { int y = ; } }";

        Assert.AreEqual(expected, await ConvertAsync(input));
    }

    [Theory]
    [InlineData(LanguageVersion.CSharp9)]
    [InlineData(LanguageVersion.CSharp7_3)]
    public async Task ConvertedNullChecks_CompileForTheirLanguageVersion(LanguageVersion languageVersion)
    {
        string input =
            "using System;\r\n" +
            "using System.Threading.Tasks;\r\n" +
            "class Node<T> where T : class\r\n" +
            "{\r\n" +
            "    public Node<T> Next;\r\n" +
            "    public T Value;\r\n" +
            "    public int? Count;\r\n" +
            "    public bool IsLast => Next == null;\r\n" +
            "    public bool HasValue { get { return Value != null; } }\r\n" +
            "    public Func<object, bool> Filter = o => o == null;\r\n" +
            "    public Func<object, bool> Block = o => { return o != null; };\r\n" +
            "    public async Task<bool> WaitAsync(Task<object> t) => await t == null;\r\n" +
            "    public int Length()\r\n" +
            "    {\r\n" +
            "        int length = 0;\r\n" +
            "        for (Node<T> node = this; node != null; node = node.Next) { length++; }\r\n" +
            "        return Count == null ? length : Count.Value;\r\n" +
            "    }\r\n" +
            "}\r\n";
        Document document = CompilingTestProject.CreateDocument(input, languageVersion, new MetadataReference[0]);
        string inequality = languageVersion >= LanguageVersion.CSharp9 ? "is not null" : "!= null";
        string expected = input
            .Replace("Next == null;", "Next is null;")
            .Replace("Value != null;", "Value " + inequality + ";")
            .Replace("o => { return o != null; }", "o => { return o " + inequality + "; }")
            .Replace("await t == null;", "await t is null;")
            .Replace("node != null;", "node " + inequality + ";")
            .Replace("Count == null ?", "Count is null ?");

        string output = await ConvertAsync(document);

        Assert.AreEqual(expected, output);
        Assert.IsEmpty(await CompilingTestProject.GetCompileErrorsAsync(document, output));
    }

    [Fact]
    public async Task UserDefinedOperatorInAnotherDocument_IsUnchanged()
    {
        string input = "class C { bool M(H h) => h == null; bool N(H h) => h != null; bool O(H h) => null == h; }";

        Assert.AreEqual(input, await ConvertAsync(input, HandleWithEqualityOperators));
    }

    [Fact]
    public async Task UserDefinedOperatorInReferencedProject_IsUnchanged()
    {
        // For example UnityEngine.Object, whose == reports a destroyed object as equal to null.
        string input = "class C { bool M(H h) => h == null; bool N(H h) => h != null; }";
        Document document = CompilingTestProject.CreateDocumentReferencingProject(input, new[] { HandleWithEqualityOperators });

        Assert.AreEqual(input, await ConvertAsync(document));
    }

    [Fact]
    public async Task LiftedUserDefinedOperatorOnNullableStruct_IsUnchanged()
    {
        string input = "class C { bool M(S? s) => s == null; bool N(S? s) => s != null; }";

        Assert.AreEqual(input, await ConvertAsync(input, StructWithEqualityOperators));
    }

    [Fact]
    public async Task TypeParameterConstrainedToClassWithUserDefinedOperator_IsUnchanged()
    {
        string input = "class C<T> where T : H { bool M(T t) => t == null; bool N(T t) => t != null; }";

        Assert.AreEqual(input, await ConvertAsync(input, HandleWithEqualityOperators));
    }

    [Theory]
    [InlineData("class C { bool M(int i) => i == null; bool N(int i) => i != null; }")]
    [InlineData("class C { bool M(System.DateTime d) => null == d; }")]
    [InlineData("class C { bool M(dynamic d) => d == null; bool N(dynamic d) => d != null; }")]
    [InlineData("class C { bool M(Unknown u) => u == null; }")]
    public async Task OperandWhoseNullComparisonIsNotAReferenceCheck_IsUnchanged(string input)
        // 'is null' on a non-nullable value type does not compile (CS0037); dynamic and unknown types may bind to a
        // user-defined operator.
        => Assert.AreEqual(input, await ConvertAsync(input));

    [Fact]
    public async Task FileCompiledByTwoProjects_IsConvertedOnlyWhenNoProjectSeesAUserDefinedOperator()
    {
        string input = "class C { bool M(H h) => h == null; }";
        Solution solution = new AdhocWorkspace().CurrentSolution;
        Document plain = AddProject(ref solution, "Plain", input, LanguageVersion.Latest, "public class H { }");
        Document plainToo = AddProject(ref solution, "PlainToo", input, LanguageVersion.Latest, "public class H { }");
        Document withOperator = AddProject(ref solution, "WithOperator", input, LanguageVersion.Latest, HandleWithEqualityOperators);

        string safeInBoth = await ConvertAsync(solution, plain, plainToo);
        string unsafeInOne = await ConvertAsync(solution, plain, withOperator);

        Assert.AreEqual("class C { bool M(H h) => h is null; }", safeInBoth);
        Assert.AreEqual(input, unsafeInOne);
    }

    [Fact]
    public async Task FileCompiledWithCSharp8AndCSharp9_ConvertsOnlyEqualityChecks()
    {
        // A project multi-targeting net48 and net8.0 can compile the file with two language versions.
        string input = "class C { bool M(object a, object b) => a == null && b != null; }";
        Solution solution = new AdhocWorkspace().CurrentSolution;
        Document modern = AddProject(ref solution, "Modern", input, LanguageVersion.CSharp9);
        Document legacy = AddProject(ref solution, "Legacy", input, LanguageVersion.CSharp8);

        Assert.AreEqual("class C { bool M(object a, object b) => a is null && b != null; }", await ConvertAsync(solution, modern, legacy));
    }

    [Fact]
    public async Task BeforeCSharp7_IsUnchanged()
    {
        string input = "class C { bool M(object a, object b) => a == null && b != null; }";

        Assert.AreEqual(input, await ConvertAsync(input, LanguageVersion.CSharp6));
    }

    [Theory]
    [InlineData("class C { bool M(object a) => a != null; }", LanguageVersion.CSharp8, 1)]
    [InlineData("class C { bool M(object a) => a != null && null != a; }", LanguageVersion.CSharp7, 1)]
    [InlineData("class C { bool M(object a) => a == null; }", LanguageVersion.CSharp8, 0)]
    [InlineData("class C { bool M(object a) => a != null; }", LanguageVersion.CSharp9, 0)]
    [InlineData("class C { bool M(int a) => a != null; }", LanguageVersion.CSharp8, 0)]
    [InlineData("class C { object M(object[] items) => System.Linq.Enumerable.Where(items, x => x != null); }", LanguageVersion.CSharp8, 0)]
    [InlineData("class C { bool M(object a, object b) => a == b != null; }", LanguageVersion.CSharp8, 0)]
    [InlineData("class C { bool M(object a) => null /* left */ != a; }", LanguageVersion.CSharp8, 0)]
    public async Task InequalityChecksLeftUnchangedForTheLanguageVersion_AreReported(string input, LanguageVersion languageVersion, int expectedReports)
    {
        List<string> reports = [];
        Document document = CompilingTestProject.CreateDocument(input, languageVersion, new[] { SystemCoreReference });

        await new NullCheckPatternMatchingConverter(reports.Add).ConvertAsync(new[] { document }, CancellationToken.None);

        Assert.HasCount(expectedReports, reports);
        if (expectedReports > 0)
        {
            Assert.Contains("C# 9", reports[0]);
        }
    }

    [Fact]
    public async Task InequalityChecksLeftUnchangedInSeveralProjects_AreReportedOnce()
    {
        string input = "class C { bool M(object a, object b) => a == null && b != null; }";
        Solution solution = new AdhocWorkspace().CurrentSolution;
        Document first = AddProject(ref solution, "First", input, LanguageVersion.CSharp8);
        Document second = AddProject(ref solution, "Second", input, LanguageVersion.CSharp7);
        List<string> reports = [];

        string result = await new NullCheckPatternMatchingConverter(reports.Add).ConvertAsync(
            new[] { solution.GetDocument(first.Id), solution.GetDocument(second.Id) },
            CancellationToken.None);

        Assert.AreEqual("class C { bool M(object a, object b) => a is null && b != null; }", result);
        Assert.HasCount(1, reports);
    }

    private static Task<string> ConvertAsync(string input, params string[] librarySources)
        => ConvertAsync(input, LanguageVersion.Latest, librarySources);

    private static Task<string> ConvertAsync(string input, LanguageVersion languageVersion, params string[] librarySources)
        => ConvertAsync(CompilingTestProject.CreateDocument(input, languageVersion, new[] { SystemCoreReference }, librarySources));

    private static Task<string> ConvertAsync(Document document)
        => new NullCheckPatternMatchingConverter().ConvertAsync(new[] { document }, CancellationToken.None);

    private static Task<string> ConvertAsync(Solution solution, params Document[] documents)
        => new NullCheckPatternMatchingConverter().ConvertAsync(documents.Select(document => solution.GetDocument(document.Id)).ToList(), CancellationToken.None);

    private static Document AddProject(ref Solution solution, string name, string targetSource, LanguageVersion languageVersion, params string[] librarySources)
    {
        Project project = solution
            .AddProject(name, name, LanguageNames.CSharp)
            .WithCompilationOptions(new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary))
            .WithParseOptions(new CSharpParseOptions(languageVersion))
            .AddMetadataReference(MetadataReference.CreateFromFile(typeof(object).Assembly.Location));

        for (int index = 0; index < librarySources.Length; index++)
        {
            project = project.AddDocument($"Library{index}.cs", SourceText.From(librarySources[index])).Project;
        }

        Document target = project.AddDocument("Target.cs", SourceText.From(targetSource));
        solution = target.Project.Solution;

        return target;
    }
}
