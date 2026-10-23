#nullable disable
using System.Threading.Tasks;
using CodeJanitor.Engine.Steps.Transformations;
using Xunit;
using Assert = CodeJanitor.Engine.Tests.Steps.Support.MsAssert;

namespace CodeJanitor.Engine.Tests.Steps;

/// <summary>
/// Unit tests for <see cref="NameOfOperatorConverter" />.
/// </summary>
public sealed class NameOfOperatorConverterTests
{
    private NameOfOperatorConverter _converter;

    public NameOfOperatorConverterTests() => _converter = new NameOfOperatorConverter();

    [Fact]
    public void Name_IsNotEmpty() => Assert.IsFalse(string.IsNullOrWhiteSpace(_converter.Name));

    [Fact]
    public void Apply_ArgumentNullException_ConvertsToNameOf()
    {
        string input = @"
public class C
{
    public void M(string myParam)
    {
        if (myParam == null)
        {
            throw new ArgumentNullException(""myParam"");
        }
    }
}";
        string expected = @"
public class C
{
    public void M(string myParam)
    {
        if (myParam == null)
        {
            throw new ArgumentNullException(nameof(myParam));
        }
    }
}";

        string result = _converter.Apply(input);

        Assert.AreEqual(expected, result);
    }

    [Fact]
    public void Apply_ArgumentException_ConvertsParameterNameToNameOf()
    {
        string input = @"
public class C
{
    public void M(int count)
    {
        if (count < 0)
        {
            throw new ArgumentException(""Count cannot be negative."", ""count"");
        }
    }
}";
        string expected = @"
public class C
{
    public void M(int count)
    {
        if (count < 0)
        {
            throw new ArgumentException(""Count cannot be negative."", nameof(count));
        }
    }
}";

        string result = _converter.Apply(input);

        Assert.AreEqual(expected, result);
    }

    [Fact]
    public void Apply_UnknownIdentifier_DoesNotConvert()
    {
        string input = @"
public class C
{
    public void M(int count)
    {
        throw new ArgumentNullException(""nonExistentParam"");
    }
}";

        string result = _converter.Apply(input);

        Assert.AreEqual(input, result);
    }

    [Fact]
    public void Apply_NullOrEmpty_ReturnsOriginal()
    {
        Assert.IsNull(_converter.Apply(null));
        Assert.AreEqual(string.Empty, _converter.Apply(string.Empty));
    }

    [Fact]
    public void Apply_QualifiedArgumentOutOfRangeException_ConvertsConstructorParameter()
    {
        string input = "public class C { public C(int value) { throw new System.ArgumentOutOfRangeException(\"value\"); } }";

        string result = _converter.Apply(input);

        Assert.AreEqual(input.Replace("\"value\"", "nameof(value)"), result);
    }

    [Fact]
    public void Apply_LocalFunctionParameter_ConvertsToNameOf()
    {
        string input = "public class C { public void M() { void Check(string value) { throw new ArgumentNullException(\"value\"); } } }";

        string result = _converter.Apply(input);

        Assert.AreEqual(input.Replace("\"value\"", "nameof(value)"), result);
    }

    [Fact]
    public void Apply_SimpleLambdaParameter_ConvertsToNameOf()
    {
        string input = "using System; public class C { public Action<string> Create() => value => throw new ArgumentNullException(\"value\"); }";

        string result = _converter.Apply(input);

        Assert.AreEqual(input.Replace("\"value\"", "nameof(value)"), result);
    }

    [Fact]
    public void Apply_ParenthesizedLambdaParameters_ConvertsMatchingArgumentOnly()
    {
        string input = "using System; public class C { public Action<string, int> Create() => (value, count) => throw new ArgumentException(\"value\", \"count\"); }";

        string result = _converter.Apply(input);

        Assert.AreEqual(input.Replace("\"count\"", "nameof(count)"), result);
    }

    [Fact]
    public void Apply_NonTargetExceptionOrInvalidIdentifier_ReturnsOriginal()
    {
        string input = "public class C { public void M(string value) { throw new InvalidOperationException(\"value\"); throw new ArgumentException(\"not a valid identifier\"); } }";

        string result = _converter.Apply(input);

        Assert.AreEqual(input, result);
    }

    [Fact]
    public void Apply_ExceptionWithoutArguments_ReturnsOriginal()
    {
        string input = "public class C { public void M() { throw new ArgumentException(); } }";

        string result = _converter.Apply(input);

        Assert.AreEqual(input, result);
    }

    [Theory]
    [InlineData("  \r\n\t")]
    [InlineData("class C { void M(string value) { throw new ArgumentException { Source = \"value\" }; } }")]
    [InlineData("class C { void M() { throw new ArgumentNullException(\"value\"); } }")]
    [InlineData("class C { Exception E = new ArgumentNullException(\"value\"); }")]
    [InlineData("class C { void M(string value) { throw new ArgumentNullException(\"Value\"); } }")]
    [InlineData("class C { void M(string value) { throw new ArgumentNullException($\"value\"); } }")]
    [InlineData("class C { void M(string value) { throw new ArgumentNullException(nameof(value)); } }")]
    [InlineData("class C { void M(string value) { ArgumentNullException e = new(\"value\"); } }")]
    [InlineData("class C { void M(string value) { throw new NotSupportedException(\"value\"); } }")]
    [InlineData("class C { void M(string value) { throw new MyArgumentException(\"value\"); } }")]
    [InlineData("class C { void M(string value) { string s = \"value\"; throw new ArgumentNullException(s); } }")]
    [InlineData("class C { void M(string value) { throw new ArgumentException(\"value\"); } }")]
    [InlineData("class C { void M(string value) { throw new ArgumentException(\"value\", \"unknown\"); } }")]
    [InlineData("class C { void M(string value, System.Exception inner) { throw new ArgumentException(\"value\", inner); } }")]
    [InlineData("class C { void M(string value) { throw new ArgumentException(message: \"value\"); } }")]
    [InlineData("class C { void M(string value) { throw new ArgumentNullException(\"other\", \"value\"); } }")]
    [InlineData("class C { void M(string value) { throw new ArgumentNullException(\"value\", new System.Exception()); } }")]
    [InlineData("class C { void M(string value, string text) { throw new ArgumentNullException(\"value\", text); } }")]
    [InlineData("class C { void M(string value) { throw new ArgumentOutOfRangeException(\"value\", new System.Exception()); } }")]
    [InlineData("class C { void M(string value) { throw new System.ComponentModel.InvalidEnumArgumentException(\"value\"); } }")]
    public void LiteralThatCannotBecomeNameOf_IsUnchanged(string input) => Assert.AreEqual(input, _converter.Apply(input));

    [Theory]
    [InlineData("class C { void M(string value) { throw new global::System.ArgumentNullException(\"value\"); } }", "class C { void M(string value) { throw new global::System.ArgumentNullException(nameof(value)); } }")]
    [InlineData("class C { void M(int value) { throw new System.ComponentModel.InvalidEnumArgumentException(\"value\", value, typeof(int)); } }", "class C { void M(int value) { throw new System.ComponentModel.InvalidEnumArgumentException(nameof(value), value, typeof(int)); } }")]
    [InlineData("class C { void M(string value, string message) { throw new ArgumentException(message, \"value\"); } }", "class C { void M(string value, string message) { throw new ArgumentException(message, nameof(value)); } }")]
    [InlineData("class C { void M(string value) { throw new ArgumentException(message: \"Bad\", paramName: \"value\"); } }", "class C { void M(string value) { throw new ArgumentException(message: \"Bad\", paramName: nameof(value)); } }")]
    [InlineData("class C { void M(string value) { throw new ArgumentNullException(@\"value\"); } }", "class C { void M(string value) { throw new ArgumentNullException(nameof(value)); } }")]
    [InlineData("class C { void M(string value) { throw new ArgumentNullException(\"\"\"value\"\"\"); } }", "class C { void M(string value) { throw new ArgumentNullException(nameof(value)); } }")]
    [InlineData("class C { void M(string outer) { System.Action<string> a = inner => { object e = new ArgumentException(\"x\", \"inner\"); object f = new ArgumentException(\"x\", \"outer\"); }; } }", "class C { void M(string outer) { System.Action<string> a = inner => { object e = new ArgumentException(\"x\", nameof(inner)); object f = new ArgumentException(\"x\", nameof(outer)); }; } }")]
    [InlineData("class C { void M(string value) { System.Func<string, Exception> f = static x => new ArgumentNullException(\"x\"); } }", "class C { void M(string value) { System.Func<string, Exception> f = static x => new ArgumentNullException(nameof(x)); } }")]
    [InlineData("class C { void M(string value) { throw new ArgumentException(\"value\", new ArgumentNullException(\"value\")); } }", "class C { void M(string value) { throw new ArgumentException(\"value\", new ArgumentNullException(nameof(value))); } }")]
    [InlineData("record R { public R(string name) { if (name == null) throw new ArgumentNullException(\"name\"); } }", "record R { public R(string name) { if (name == null) throw new ArgumentNullException(nameof(name)); } }")]
    [InlineData("struct S { void M<T>(T item) where T : class { _ = item ?? throw new ArgumentNullException(\"item\"); } }", "struct S { void M<T>(T item) where T : class { _ = item ?? throw new ArgumentNullException(nameof(item)); } }")]
    [InlineData("class C { void M(string value) { throw new ArgumentNullException(\"value\", \"must not be null\"); } }", "class C { void M(string value) { throw new ArgumentNullException(nameof(value), \"must not be null\"); } }")]
    [InlineData("class C { void M(string value) { throw new ArgumentOutOfRangeException(\"value\", \"too large\"); } }", "class C { void M(string value) { throw new ArgumentOutOfRangeException(nameof(value), \"too large\"); } }")]
    [InlineData("class C { void M(string value) { throw new ArgumentOutOfRangeException(\"value\", 5, \"too large\"); } }", "class C { void M(string value) { throw new ArgumentOutOfRangeException(nameof(value), 5, \"too large\"); } }")]
    [InlineData("class C { void M(string value) { throw new ArgumentNullException(paramName: \"value\", message: \"must not be null\"); } }", "class C { void M(string value) { throw new ArgumentNullException(paramName: nameof(value), message: \"must not be null\"); } }")]
    [InlineData("class C { void M(string value) { throw new ArgumentException(\"value\", \"value\"); } }", "class C { void M(string value) { throw new ArgumentException(\"value\", nameof(value)); } }")]
    [InlineData("class C { void M(string value, System.Exception inner) { throw new ArgumentException(\"Bad\", \"value\", inner); } }", "class C { void M(string value, System.Exception inner) { throw new ArgumentException(\"Bad\", nameof(value), inner); } }")]
    [InlineData("class C { void M(string value) { throw new ArgumentException(paramName: \"value\", message: \"value\"); } }", "class C { void M(string value) { throw new ArgumentException(paramName: nameof(value), message: \"value\"); } }")]
    [InlineData("class C { void M(int value) { throw new System.ComponentModel.InvalidEnumArgumentException(argumentName: \"value\", invalidValue: 1, enumClass: typeof(int)); } }", "class C { void M(int value) { throw new System.ComponentModel.InvalidEnumArgumentException(argumentName: nameof(value), invalidValue: 1, enumClass: typeof(int)); } }")]
    public void LiteralNamingAParameterInScope_BecomesNameOf(string input, string expected) => Assert.AreEqual(expected, _converter.Apply(input));

    [Fact]
    public void TopLevelStatementsFile_ConvertsOnlyLocalFunctionAndMemberParameters()
    {
        string input =
            "using System;\r\n" +
            "\r\n" +
            "if (args.Length == 0) throw new ArgumentNullException(\"args\");\r\n" +
            "Check(args[0]);\r\n" +
            "\r\n" +
            "static void Check(string path)\r\n" +
            "{\r\n" +
            "    if (path.Length == 0) throw new ArgumentNullException(\"path\");\r\n" +
            "}\r\n" +
            "\r\n" +
            "class Guard\r\n" +
            "{\r\n" +
            "    public static void NotNull(object value) { if (value == null) throw new ArgumentNullException(\"value\"); }\r\n" +
            "}\r\n";
        string expected = input
            .Replace("ArgumentNullException(\"path\")", "ArgumentNullException(nameof(path))")
            .Replace("ArgumentNullException(\"value\")", "ArgumentNullException(nameof(value))");

        Assert.AreEqual(expected, _converter.Apply(input));
    }

    [Theory]
    [InlineData("\r\n")]
    [InlineData("\n")]
    public void TriviaAroundTheLiteral_IsPreserved(string newLine)
    {
        string input =
            "class C" + newLine +
            "{" + newLine +
            "\t/// <param name=\"value\">The value.</param>" + newLine +
            "\tvoid M(string value)" + newLine +
            "\t{" + newLine +
            "\t\t// \"value\" must not be null" + newLine +
            "\t\tthrow new ArgumentNullException(" + newLine +
            "\t\t\t/* name */ \"value\" /* end */); // trailing" + newLine +
            "\t}" + newLine +
            "}" + newLine;
        string expected = input.Replace("/* name */ \"value\" /* end */", "/* name */ nameof(value) /* end */");

        Assert.AreEqual(expected, _converter.Apply(input));
    }

    [Fact]
    public void FileWithSyntaxErrors_ConvertsTheValidCallAndKeepsTheRestVerbatim()
    {
        string input = "class C { void M(string value) { throw new ArgumentNullException(\"value\"); } void N( { int x = ; } }";
        string expected = "class C { void M(string value) { throw new ArgumentNullException(nameof(value)); } void N( { int x = ; } }";

        Assert.AreEqual(expected, _converter.Apply(input));
    }

    [Fact]
    public async Task ConvertedLiterals_CompileWithoutNewErrors()
    {
        string input =
            "using System;\r\n" +
            "class C\r\n" +
            "{\r\n" +
            "    public C(string name) { if (name == null) throw new ArgumentNullException(\"name\"); }\r\n" +
            "    public void M(int count, string label)\r\n" +
            "    {\r\n" +
            "        if (count < 0) throw new ArgumentOutOfRangeException(\"count\", count, \"Must be positive.\");\r\n" +
            "        Func<string, Exception> make = text => new ArgumentException(\"Bad\", \"text\");\r\n" +
            "        void Local(string inner) { throw new ArgumentException(\"label\", \"inner\"); }\r\n" +
            "        Local(label);\r\n" +
            "    }\r\n" +
            "}\r\n";
        Microsoft.CodeAnalysis.Document document = CompilingTestProject.CreateDocument(input);
        string expected = input
            .Replace("ArgumentNullException(\"name\")", "ArgumentNullException(nameof(name))")
            .Replace("ArgumentOutOfRangeException(\"count\",", "ArgumentOutOfRangeException(nameof(count),")
            .Replace("ArgumentException(\"Bad\", \"text\")", "ArgumentException(\"Bad\", nameof(text))")
            .Replace("ArgumentException(\"label\", \"inner\")", "ArgumentException(\"label\", nameof(inner))");

        string output = _converter.Apply(input);

        Assert.AreEqual(expected, output);
        Assert.IsEmpty(await CompilingTestProject.GetCompileErrorsAsync(document, output));
    }
}
