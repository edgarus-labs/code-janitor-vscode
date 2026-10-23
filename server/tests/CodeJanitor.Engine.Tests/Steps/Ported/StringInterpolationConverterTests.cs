#nullable disable
using CodeJanitor.Engine.Steps.Transformations;
using Xunit;
using Assert = CodeJanitor.Engine.Tests.Steps.Support.MsAssert;

namespace CodeJanitor.Engine.Tests.Steps;

/// <summary>
/// Unit tests for <see cref="StringInterpolationConverter" />.
/// </summary>
public sealed class StringInterpolationConverterTests
{
    private StringInterpolationConverter _converter;

    public StringInterpolationConverterTests() => _converter = new StringInterpolationConverter();

    [Fact]
    public void Name_IsNotEmpty() => Assert.IsFalse(string.IsNullOrWhiteSpace(_converter.Name));

    [Fact]
    public void Apply_SimpleStringFormat_ConvertsToInterpolatedString()
    {
        string input = @"
public class C
{
    public string M(string name, int count)
    {
        return string.Format(""Hello {0}, you have {1} messages."", name, count);
    }
}";
        string expected = @"
public class C
{
    public string M(string name, int count)
    {
        return $""Hello {name}, you have {count} messages."";
    }
}";

        string result = _converter.Apply(input);

        Assert.AreEqual(expected, result);
    }

    [Fact]
    public void Apply_StringFormatWithFormatSpecifier_ConvertsProperly()
    {
        string input = @"
public class C
{
    public string M(double price)
    {
        return string.Format(""Price: {0:C2}"", price);
    }
}";
        string expected = @"
public class C
{
    public string M(double price)
    {
        return $""Price: {price:C2}"";
    }
}";

        string result = _converter.Apply(input);

        Assert.AreEqual(expected, result);
    }

    [Fact]
    public void Apply_StringFormatWithAlignment_ConvertsProperly()
    {
        string input = @"
public class C
{
    public string M(int id)
    {
        return string.Format(""ID: {0,5}"", id);
    }
}";
        string expected = @"
public class C
{
    public string M(int id)
    {
        return $""ID: {id,5}"";
    }
}";

        string result = _converter.Apply(input);

        Assert.AreEqual(expected, result);
    }

    [Fact]
    public void Apply_NonLiteralFormatString_Skipped()
    {
        string input = @"
public class C
{
    public string M(string template, int value)
    {
        return string.Format(template, value);
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
    public void Apply_SystemStringFormatAndStringFormat_ConvertsProperly()
    {
        string input = "public class C { public string M(int x) => System.String.Format(\"Val: {0}\", x) + String.Format(\" Other: {0}\", x); }";
        string expected = "public class C { public string M(int x) => $\"Val: {x}\" + $\" Other: {x}\"; }";

        Assert.AreEqual(expected, _converter.Apply(input));
    }

    [Fact]
    public void Apply_FormatStringWithEscapedCharacters_EscapesProperly()
    {
        string input = "public class C { public string M(string s) => string.Format(\"Quote: \\\"{0}\\\"\\r\\nTab:\\t{0}\", s); }";
        string expected = "public class C { public string M(string s) => $\"Quote: \\\"{s}\\\"\\r\\nTab:\\t{s}\"; }";

        Assert.AreEqual(expected, _converter.Apply(input));
    }

    [Theory]
    [InlineData("\\0{0}", "\\u0000{x}")]
    [InlineData("\\x1b[31m{0}", "\\u001B[31m{x}")]
    [InlineData("\\a\\b\\f\\v{0}", "\\u0007\\u0008\\u000C\\u000B{x}")]
    [InlineData("\\u0085{0}", "\\u0085{x}")]
    [InlineData("\\u200B\\u202E\\uFEFF{0}", "\\u200B\\u202E\\uFEFF{x}")]
    [InlineData("\\u2028\\u2029{0}", "\\u2028\\u2029{x}")]
    [InlineData("\\uD800{0}", "\\uD800{x}")]
    [InlineData("{0}\\uDC00", "{x}\\uDC00")]
    [InlineData("\\uDC00\\uD800{0}", "\\uDC00\\uD800{x}")]
    [InlineData("\\uD83D\\uDE00 \\u00E9{0}", "\U0001F600 \u00E9{x}")]
    public void NonPrintableCharacterInFormat_IsWrittenAsAnEscapeSequence(string format, string expected)
    {
        string input = "class C { string M(int x) => string.Format(\"" + format + "\", x); }";

        Assert.AreEqual("class C { string M(int x) => $\"" + expected + "\"; }", _converter.Apply(input));
    }

    [Theory]
    [InlineData("class C { string M(int a, int b) => string.Format(\"{0}{1}\", arg1: b, arg0: a); }")]
    [InlineData("class C { string M(int x) => string.Format(format: \"{0}\", provider: System.Globalization.CultureInfo.InvariantCulture, arg0: x); }")]
    public void FormatCallWithNamedArguments_IsUnchanged(string input) => Assert.AreEqual(input, _converter.Apply(input));

    [Fact]
    public void Apply_OutOfBoundsOrNoPlaceholder_Skipped()
    {
        string input1 = "public class C { public string M(int x) => string.Format(\"No placeholder\", x); }";
        Assert.AreEqual(input1, _converter.Apply(input1));

        string input2 = "public class C { public string M(int x) => string.Format(\"Index: {5}\", x); }";
        Assert.AreEqual(input2, _converter.Apply(input2));
    }

    [Fact]
    public void Apply_OtherTypeFormatOrSingleArgument_Skipped()
    {
        string input1 = "public class C { public string M(int x) => OtherClass.Format(\"{0}\", x); }";
        Assert.AreEqual(input1, _converter.Apply(input1));

        string input2 = "public class C { public string M(string s) => string.Format(s); }";
        Assert.AreEqual(input2, _converter.Apply(input2));
    }

    [Fact]
    public void Apply_ArgumentSpanningLines_Skipped()
    {
        // A line break inside an interpolation hole of a regular interpolated string needs C# 11 (CS8967 before).
        string input = "public class C { public string M(int a, int b) => string.Format(\"{0}\", a +\r\n    b); }";

        Assert.AreEqual(input, _converter.Apply(input));
    }

    [Theory]
    [InlineData("  \r\n\t")]
    [InlineData("using static System.String; class C { string M(int x) => Format(\"{0}\", x); }")]
    [InlineData("class C { string M(int x) => string.Concat(\"{0}\", x); }")]
    [InlineData("class C { string M(int x) => string.Format(System.Globalization.CultureInfo.InvariantCulture, \"{0}\", x); }")]
    [InlineData("class C { string M(int x) => string.Format($\"{x}{{0}}\", x); }")]
    [InlineData("class C { string M(int x) => string.Format(\"{99999999999}\", x); }")]
    [InlineData("class C { string M(int a, int b) => string.Format(\"{0} { 1}\", a, b); }")]
    [InlineData("class C { string M(int a) => string.Format(\"{0} } {x}\", a); }")]
    [InlineData("class C { string M(int x) => string.Format(\"{0}{1}\", x); }")]
    [InlineData("class C { string M(object[] a) => string.Format(\"{0}{1}\", a); }")]
    [InlineData("class C { string M(int x) => System.Text.StringBuilder.Format(\"{0}\", x); }")]
    [InlineData("class C\r\n{\r\n    // string.Format(\"{0}\", x)\r\n    string A = \"string.Format(\\\"{0}\\\", x)\";\r\n}\r\n")]
    public void CallThatCannotBecomeAnInterpolatedString_IsUnchanged(string input) => Assert.AreEqual(input, _converter.Apply(input));

    [Theory]
    [InlineData("class C { string M() => string.Format(\"{0}-{0}\", Next()); int Next() => 0; }")]
    [InlineData("class C { string M() => string.Format(\"{1}{0}\", A(), B()); int A() => 0; int B() => 0; }")]
    [InlineData("class C { string M() => string.Format(\"{0}\", A(), Log()); int A() => 0; int Log() => 0; }")]
    [InlineData("class C { string M(int x) => string.Format(\"{1}{0}\", x++, x++); }")]
    [InlineData("class C { string M(int x) => string.Format(\"{0}{0}\", x++); }")]
    [InlineData("class C { string M() => string.Format(\"{0} {0}\", System.DateTime.Now); }")]
    [InlineData("class C { string M(C c) => string.Format(\"{0}-{0}\", c.Name.Length); string Name; }")]
    [InlineData("class C { string M(C c, C d) => string.Format(\"{1} before {0}\", c.Name, d.Name); string Name; }")]
    [InlineData("class C { string M(C c, int b) => string.Format(\"{0}\", b, c.Name); string Name; }")]
    [InlineData("class C { string M(int i) => string.Format(\"{1} {0}\", i, i++); }")]
    [InlineData("class C { string M(int i) => string.Format(\"{0} {1} {0}\", i, i++); }")]
    [InlineData("class C { string M(int i, int j) => string.Format(\"{1} {0}\", i, i = j); }")]
    [InlineData("class C { string M(int i) => string.Format(\"{1} {0}\", i, Read(out i)); int Read(out int v) { v = 1; return v; } }")]
    [InlineData("class C { string M(int x) => string.Format(\"{0}\", x, Log()); int Log() => 0; }")]
    [InlineData("class C { string M(int x) => string.Format(/* keep */ \"{0}\", x); }")]
    [InlineData("class C { string M(int x) => string.Format(\"{0}\", /* keep */ x); }")]
    [InlineData("class C { string M(int x, int y) => string.Format(\"{0}\", x /* keep */, y); }")]
    [InlineData("class C { string M(int x) => string.Format(\"{0}\", x /* keep */); }")]
    [InlineData("class C { int _n; int Next => ++_n; string M() => string.Format(\"{0}-{0}\", Next); }")]
    [InlineData("using static System.DateTime; class C { string M() => string.Format(\"{0:HH}:{0:mm}\", Now); }")]
    [InlineData("class C { int _n; int Next => ++_n; string M(int x) => string.Format(\"{1}\", Next, x); }")]
    [InlineData("class C { int _n; int Next => ++_n; string M() { { var Next = 1; } return string.Format(\"{0}-{0}\", Next); } }")]
    [InlineData("class C { string M(System.Text.StringBuilder sb) => string.Format(\"{0}{1}\", sb, sb.Append(\"!\")); }")]
    [InlineData("class C { string M(int a) => string.Format(\"{1}-{0}-{1}\", Next(), a); int Next() => 0; }")]
    [InlineData("class C { string M(int i, int j) => string.Format(\"{0} {1}\", i, i++); }")]
    public void FormatCallWhoseConversionWouldChangeSideEffectsOrDropComments_IsUnchanged(string input) => Assert.AreEqual(input, _converter.Apply(input));

    [Theory]
    [InlineData("class C { string M() => string.Format(\"{0}-{0}\", 5); }", "class C { string M() => $\"{5}-{5}\"; }")]
    [InlineData("class C { string M(int a, int b) => string.Format(\"{0}\", a, b); }", "class C { string M(int a, int b) => $\"{a}\"; }")]
    [InlineData("class C { string M(int a) => string.Format(\"{0} {1}-{1}\", Next(), a); int Next() => 0; }", "class C { string M(int a) => $\"{Next()} {a}-{a}\"; int Next() => 0; }")]
    [InlineData("class C { string M(int i) => string.Format(\"{0} {1}\", i++, i); }", "class C { string M(int i) => $\"{i++} {i}\"; }")]
    [InlineData("class C { string M() { var a = Get(); return string.Format(\"{0}-{0}\", a); } int Get() => 0; }", "class C { string M() { var a = Get(); return $\"{a}-{a}\"; } int Get() => 0; }")]
    [InlineData("class C { string _s; int P { set => _s = string.Format(\"{0}{0}\", value); } }", "class C { string _s; int P { set => _s = $\"{value}{value}\"; } }")]
    [InlineData("class C { System.Func<int, string> F = x => string.Format(\"{0}-{0}\", x); }", "class C { System.Func<int, string> F = x => $\"{x}-{x}\"; }")]
    [InlineData("class C { string M(object o) => o is int n ? string.Format(\"{0}-{0}\", n) : \"\"; }", "class C { string M(object o) => o is int n ? $\"{n}-{n}\" : \"\"; }")]
    [InlineData("class C { string M(int[] items) { foreach (var item in items) { return string.Format(\"{0}{0}\", item); } return null; } }", "class C { string M(int[] items) { foreach (var item in items) { return $\"{item}{item}\"; } return null; } }")]
    [InlineData("class C { string M(int i, int j) => string.Format(\"{1} {0}\", i, j++); }", "class C { string M(int i, int j) => $\"{j++} {i}\"; }")]
    public void FormatCallWhoseEvaluationIsPreserved_BecomesAnInterpolatedString(string input, string expected) => Assert.AreEqual(expected, _converter.Apply(input));

    [Theory]
    [InlineData("class C { string M(int a, int b) => string.Format(\"{1} before {0}\", a, b); }", "class C { string M(int a, int b) => $\"{b} before {a}\"; }")]
    [InlineData("class C { string M(int a) => string.Format(\"{0}-{0}\", a); }", "class C { string M(int a) => $\"{a}-{a}\"; }")]
    [InlineData("class C { string M(double a) => string.Format(\"[{0,-10:N2}]\", a); }", "class C { string M(double a) => $\"[{a,-10:N2}]\"; }")]
    [InlineData("class C { string M(System.DateTime d) => string.Format(\"{0:yyyy-MM-dd HH:mm}\", d); }", "class C { string M(System.DateTime d) => $\"{d:yyyy-MM-dd HH:mm}\"; }")]
    [InlineData("class C { string M(int a) => string.Format(\"{{{0}}}\", a); }", "class C { string M(int a) => $\"{{{a}}}\"; }")]
    [InlineData("class C { string M(int a) => string.Format(@\"Value \"\"{0}\"\"\", a); }", "class C { string M(int a) => $\"Value \\\"{a}\\\"\"; }")]
    [InlineData("class C { string M(Item i, int[] a) => string.Format(\"{0} {1} {2} {3}\", i.Name, i?.Name, a[0], (object)i); }", "class C { string M(Item i, int[] a) => $\"{i.Name} {i?.Name} {a[0]} {(object)i}\"; }")]
    [InlineData("class C { string M(int a) => string.Format(\"{0}\", string.Format(\"<{0}>\", a)); }", "class C { string M(int a) => $\"{$\"<{a}>\"}\"; }")]
    [InlineData("class C { string M(int a) => string.Format(\"é {0} ✓\", a); }", "class C { string M(int a) => $\"é {a} ✓\"; }")]
    [InlineData("class C { System.Func<int, string> F = x => string.Format(\"{0}\", x); }", "class C { System.Func<int, string> F = x => $\"{x}\"; }")]
    [InlineData("record R(int X) { public override string ToString() => string.Format(\"R({0})\", X); }", "record R(int X) { public override string ToString() => $\"R({X})\"; }")]
    [InlineData("class C { string M(int a, int b) => string.Format(\"{0}: {1, 10}\", a, b); }", "class C { string M(int a, int b) => $\"{a}: {b,10}\"; }")]
    [InlineData("class C { string M(int x) => string.Format(\"{0 }\", x); }", "class C { string M(int x) => $\"{x}\"; }")]
    [InlineData("class C { string M(int a) => string.Format(\"[{0:}]\", a); }", "class C { string M(int a) => $\"[{a}]\"; }")]
    [InlineData("class C { string M(double a) => string.Format(\"{0 ,5}|{0, -5 :N2}\", a); }", "class C { string M(double a) => $\"{a,5}|{a,-5:N2}\"; }")]
    public void FormatCallWithLiteralFormat_BecomesAnInterpolatedString(string input, string expected) => Assert.AreEqual(expected, _converter.Apply(input));

    [Fact]
    public void TopLevelStatementsFile_ConvertsStatementsLocalFunctionsAndTypes()
    {
        string input =
            "using System;\r\n" +
            "\r\n" +
            "Console.WriteLine(string.Format(\"Hello {0}\", args.Length));\r\n" +
            "\r\n" +
            "static string Describe(int n) => String.Format(\"n={0}\", n);\r\n" +
            "\r\n" +
            "class Printer\r\n" +
            "{\r\n" +
            "    public string Print(int n) => System.String.Format(\"[{0}]\", n);\r\n" +
            "}\r\n";
        string expected = input
            .Replace("string.Format(\"Hello {0}\", args.Length)", "$\"Hello {args.Length}\"")
            .Replace("String.Format(\"n={0}\", n)", "$\"n={n}\"")
            .Replace("System.String.Format(\"[{0}]\", n)", "$\"[{n}]\"");

        Assert.AreEqual(expected, _converter.Apply(input));
    }

    [Theory]
    [InlineData("\r\n")]
    [InlineData("\n")]
    public void TriviaAroundTheCall_IsPreserved(string newLine)
    {
        string input =
            "class C" + newLine +
            "{" + newLine +
            "\t/// <summary>Formats.</summary>" + newLine +
            "\tstring M(int x)" + newLine +
            "\t{" + newLine +
            "\t\t// build it" + newLine +
            "\t\treturn /*a*/ string.Format(\"x={0}\", x) /*b*/; // trailing" + newLine +
            "\t}" + newLine +
            "#if NEVER" + newLine +
            "\tstring N(int x) => string.Format(\"{0}\", x);" + newLine +
            "#endif" + newLine +
            "}" + newLine;
        string expected = input.Replace("/*a*/ string.Format(\"x={0}\", x) /*b*/", "/*a*/ $\"x={x}\" /*b*/");

        Assert.AreEqual(expected, _converter.Apply(input));
    }

    [Fact]
    public void FileWithSyntaxErrors_ConvertsTheValidCallAndKeepsTheRestVerbatim()
    {
        string input = "class C { string M(int x) => string.Format(\"{0}\", x); void N( { int y = ; } }";
        string expected = "class C { string M(int x) => $\"{x}\"; void N( { int y = ; } }";

        Assert.AreEqual(expected, _converter.Apply(input));
    }

    [Theory]
    [InlineData("class C { string M(string n) => string.Format(\"C:\\\\temp\\\\{0}\", n); }")]
    [InlineData("class C { string M(string n) => string.Format(@\"C:\\temp\\{0}\", n); }")]
    public void BackslashInFormat_IsEscaped(string input)
    {
        string expected = "class C { string M(string n) => $\"C:\\\\temp\\\\{n}\"; }";

        Assert.AreEqual(expected, _converter.Apply(input));
    }

    [Fact]
    public void BackslashInFormatSpecifier_IsEscaped()
    {
        string input = "class C { string M(System.TimeSpan t) => string.Format(\"{0:hh\\\\:mm}\", t); }";
        string expected = "class C { string M(System.TimeSpan t) => $\"{t:hh\\\\:mm}\"; }";

        Assert.AreEqual(expected, _converter.Apply(input));
    }

    [Theory]
    [InlineData("class C { string M(bool f) => string.Format(\"{0}\", f ? \"y\" : \"n\"); }", "class C { string M(bool f) => $\"{(f ? \"y\" : \"n\")}\"; }")]
    [InlineData("class C { string M(int x) => string.Format(\"{0}\", global::System.Math.Abs(x)); }", "class C { string M(int x) => $\"{(global::System.Math.Abs(x))}\"; }")]
    public void ArgumentWithTopLevelColon_IsParenthesized(string input, string expected) => Assert.AreEqual(expected, _converter.Apply(input));

    [Theory]
    [InlineData("class C { string M(int x) => string.Format(\"{{0}} {0}\", x); }", "class C { string M(int x) => $\"{{0}} {x}\"; }")]
    [InlineData("class C { string M(int x) => string.Format(\"{{{0}}}\", x); }", "class C { string M(int x) => $\"{{{x}}}\"; }")]
    public void EscapedBracesAroundDigit_StayLiteral(string input, string expected) => Assert.AreEqual(expected, _converter.Apply(input));

    [Fact]
    public void OnlyEscapedBraces_IsUnchanged()
    {
        string input = "class C { string M(int x) => string.Format(\"{{0}}\", x); }";

        Assert.AreEqual(input, _converter.Apply(input));
    }

    [Fact]
    public async System.Threading.Tasks.Task ConvertedCalls_CompileWithoutNewErrors()
    {
        string input =
            "using System;\r\n" +
            "class Item { public string Name; }\r\n" +
            "class C\r\n" +
            "{\r\n" +
            "    public string A(Item i, int n) => string.Format(\"{0} has {1,5:N0} items\", i?.Name, n);\r\n" +
            "    public string B(int n) => String.Format(\"{{{0}}} \\\"quoted\\\"\", n);\r\n" +
            "    public string D(int n) => string.Format(\"{0}\", string.Format(\"<{0}>\", n));\r\n" +
            "    public string E(string s) => string.Format(\"{0}!\", \"text\" + s);\r\n" +
            "}\r\n";
        Microsoft.CodeAnalysis.Document document = CompilingTestProject.CreateDocument(input);
        string expected = input
            .Replace("string.Format(\"{0} has {1,5:N0} items\", i?.Name, n)", "$\"{i?.Name} has {n,5:N0} items\"")
            .Replace("String.Format(\"{{{0}}} \\\"quoted\\\"\", n)", "$\"{{{n}}} \\\"quoted\\\"\"")
            .Replace("string.Format(\"{0}\", string.Format(\"<{0}>\", n))", "$\"{$\"<{n}>\"}\"")
            .Replace("string.Format(\"{0}!\", \"text\" + s)", "$\"{\"text\" + s}!\"");

        string output = _converter.Apply(input);

        Assert.AreEqual(expected, output);
        Assert.IsEmpty(await CompilingTestProject.GetCompileErrorsAsync(document, output));
    }
}
