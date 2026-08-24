using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using CodeJanitor.Logic.Ai;
using System;
using System.Collections.Generic;
using System.Linq;

namespace CodeJanitor.UnitTests.Ai;

/// <summary>
/// Unit tests for <see cref="XmlDocumentationGenerator" />, ported from the Visual Studio
/// extension's AiXmlDocumentationLogicTests. The source tests reached the logic through
/// reflection (the members were private); here the engine exposes them directly, so the
/// reflection plumbing is gone while the scenarios and assertions are unchanged.
/// </summary>
[TestClass]
public sealed class XmlDocumentationGeneratorTests
{
    [TestMethod]
    [TestCategory("Ai UnitTests")]
    public void GenerateXmlDocumentationForSource_InsertsSummaryParamReturnsAndException()
    {
        var source = @"
namespace Demo;

public class Sample
{
public string BuildName(string firstName, string lastName)
{
    if (string.IsNullOrWhiteSpace(firstName))
    {
        throw new ArgumentException(nameof(firstName));
    }

    return firstName + "" "" + lastName;
}
}
";

        var updated = XmlDocumentationGenerator.GenerateXmlDocumentationForSource(source, _ => "Builds a combined display name.", 10);

        StringAssert.Contains(updated, "/// <summary>");
        StringAssert.Contains(updated, "/// Builds a combined display name.");
        StringAssert.Contains(updated, "<param name=\"firstName\">The first name.</param>");
        StringAssert.Contains(updated, "<param name=\"lastName\">The last name.</param>");
        StringAssert.Contains(updated, "<returns>The string result.</returns>");
        StringAssert.Contains(updated, "<exception cref=\"ArgumentException\">");
    }

    [TestMethod]
    [TestCategory("Ai UnitTests")]
    public void GenerateXmlDocumentationForSource_DocumentsPositionalRecordWithParamTags()
    {
        var source = @"namespace RecipeVault.Application.Abstractions.CQRS;

public sealed record CreateRecipeCommand(
    string Title,
    string Description,
    Guid AuthorId,
    List<CreateIngredientDto> Ingredients,
    List<CreateStepDto> Steps
) : ICommand<CreateRecipeResponse>;
";

        var updated = XmlDocumentationGenerator.GenerateXmlDocumentationForSource(source, _ => "Represents a command to create a new recipe with the specified details.", 10);

        StringAssert.Contains(updated, "/// <summary>");
        StringAssert.Contains(updated, "/// Represents a command to create a new recipe with the specified details.");
        StringAssert.Contains(updated, "<param name=\"Title\">The title.</param>");
        StringAssert.Contains(updated, "<param name=\"Description\">The description.</param>");
        StringAssert.Contains(updated, "<param name=\"AuthorId\">The unique identifier of the author.</param>");
        StringAssert.Contains(updated, "<param name=\"Ingredients\">The collection of ingredients.</param>");
        StringAssert.Contains(updated, "<param name=\"Steps\">The collection of steps.</param>");
    }

    [TestMethod]
    [TestCategory("Ai UnitTests")]
    public void GenerateXmlDocumentationForSource_PlacesBlockDirectlyAboveMemberKeepingIndent()
    {
        var source = "namespace Demo;\r\n\r\npublic class Sample\r\n{\r\n    public int Get(int x)\r\n    {\r\n        return x;\r\n    }\r\n}\r\n";

        var updated = XmlDocumentationGenerator.GenerateXmlDocumentationForSource(source, _ => "Gets a value.", 10);

        var lines = updated.Replace("\r\n", "\n").Split('\n');
        var memberIndex = Array.FindIndex(lines, x => x.Contains("public int Get"));

        Assert.IsTrue(memberIndex > 0, "Method declaration not found.");
        StringAssert.Contains(lines[memberIndex - 1], "///", "A blank line separates the documentation from the member.");
        Assert.AreEqual("    public int Get(int x)", lines[memberIndex], "The member lost its original indentation.");
        StringAssert.StartsWith(lines[memberIndex - 1], "    ///", "The documentation block is not aligned with the member.");
    }

    [TestMethod]
    [TestCategory("Ai UnitTests")]
    public void NormalizeSentence_StripsThinkingProcessAndDraftsFromReasoningModels()
    {
        var rawThinking = "Thinking Process: 1. **Analyze the Request:** * Input: C# type information. 2. **Determine Meaning:** Interface for CQRS. 3. **Drafting:** * Draft 1: Represents a command. * Draft 2: Defines a command contract.";
        Assert.AreEqual("Defines a command contract.", XmlDocumentationGenerator.NormalizeSentence(rawThinking));

        var rawXmlThink = "<think>\nLet's analyze this method.\nIt calculates the sum.\n</think>\nCalculates the sum of two integers.";
        Assert.AreEqual("Calculates the sum of two integers.", XmlDocumentationGenerator.NormalizeSentence(rawXmlThink));

        var rawPreamble = "Here is the summary sentence: Performs the validation of the given request.";
        Assert.AreEqual("Performs the validation of the given request.", XmlDocumentationGenerator.NormalizeSentence(rawPreamble));
    }

    [TestMethod]
    [TestCategory("Ai UnitTests")]
    public void GenerateXmlDocumentationForSource_RespectsMethodLimit()
    {
        var source = @"
namespace Demo;

public class Sample
{
public int First(int x)
{
    return x + 1;
}

public int Second(int y)
{
    return y + 2;
}
}
";

        var updated = XmlDocumentationGenerator.GenerateXmlDocumentationForSource(source, m => "Summary for " + GetMemberName(m) + ".", 1);

        Assert.AreEqual(1, CountOccurrences(updated, "/// <summary>"), "Only one member should be documented when the limit is 1.");
        StringAssert.Contains(updated, "Summary for Sample.");
        Assert.IsFalse(updated.Contains("Summary for Second."));
    }

    [TestMethod]
    [TestCategory("Ai UnitTests")]
    public void GenerateXmlDocumentationForSource_DocumentsTypesAndPropertiesWithoutMethods()
    {
        var source = "namespace Demo;\r\n\r\npublic class WriteRelationsRequest\r\n{\r\n    public string Name { get; set; }\r\n\r\n    public int Count { get; }\r\n}\r\n";

        var updated = XmlDocumentationGenerator.GenerateXmlDocumentationForSource(source, m => "Summary for " + GetMemberName(m) + ".", 10);

        Assert.AreEqual(3, CountOccurrences(updated, "/// <summary>"), "The type and both properties should be documented.");
        StringAssert.Contains(updated, "Summary for WriteRelationsRequest.");
        StringAssert.Contains(updated, "Summary for Name.");
        StringAssert.Contains(updated, "Summary for Count.");
    }

    [TestMethod]
    [TestCategory("Ai UnitTests")]
    public void GenerateXmlDocumentationForSource_DocumentsPublicConstAndPublicStaticMembers()
    {
        var source = @"namespace Demo;

public class ConfigClass
{
    public const string Version = ""1.0"";

    public static readonly string DefaultName = ""Test"";

    public static int StaticCounter { get; set; }

    public static string StaticExpressionProp => ""Hello"";
}
";

        var updated = XmlDocumentationGenerator.GenerateXmlDocumentationForSource(source, m => "Summary for " + GetMemberName(m) + ".", 10);

        Assert.AreEqual(5, CountOccurrences(updated, "/// <summary>"), "Class, const field, static readonly field, static property, and static expression property should all be documented.");
        StringAssert.Contains(updated, "Summary for ConfigClass.");
        StringAssert.Contains(updated, "Summary for Version.");
        StringAssert.Contains(updated, "Summary for DefaultName.");
        StringAssert.Contains(updated, "Summary for StaticCounter.");
        StringAssert.Contains(updated, "Summary for StaticExpressionProp.");
    }

    [TestMethod]
    [TestCategory("Ai UnitTests")]
    public void GenerateXmlDocumentationForSource_DocumentsPublicFieldsAndSkipsPrivateFields()
    {
        var source = @"namespace Demo;

public class FieldSample
{
    public string PublicField;

    public int PublicNumber = 42;

    private string _privateField;

    int _unspecifiedPrivate;
}
";

        var updated = XmlDocumentationGenerator.GenerateXmlDocumentationForSource(source, m => "Summary for " + GetMemberName(m) + ".", 10);

        Assert.AreEqual(3, CountOccurrences(updated, "/// <summary>"), "Should document class and 2 public fields, but skip 2 private fields.");
        StringAssert.Contains(updated, "Summary for FieldSample.");
        StringAssert.Contains(updated, "Summary for PublicField.");
        StringAssert.Contains(updated, "Summary for PublicNumber.");
        Assert.IsFalse(updated.Contains("Summary for _privateField."));
        Assert.IsFalse(updated.Contains("Summary for _unspecifiedPrivate."));
    }

    [TestMethod]
    [TestCategory("Ai UnitTests")]
    public void GenerateXmlDocumentationForSource_DocumentsAllConstFieldsInSinglePassRegardlessOfMethodLimit()
    {
        var sb = new System.Text.StringBuilder();
        sb.AppendLine("namespace Demo;");
        sb.AppendLine("public static class LargeConstants {");
        for (var i = 0; i < 50; i++)
        {
            sb.AppendLine($"    public const int Field{i} = {i};");
        }

        sb.AppendLine("}");

        var source = sb.ToString();

        // Max methods per file set to 2, but all 50 constants plus class should be documented
        var updated = XmlDocumentationGenerator.GenerateXmlDocumentationForSource(source, m => "Summary for " + GetMemberName(m) + ".", 2);

        Assert.AreEqual(51, CountOccurrences(updated, "/// <summary>"), "All 50 const fields + class should be documented in a single pass without batching truncation.");
    }

    [TestMethod]
    [TestCategory("Ai UnitTests")]
    public void GenerateXmlDocumentationForSource_SkipsMethodsThatAlreadyHaveDocComments()
    {
        var source = @"
namespace Demo;

public class Sample
{
/// <summary>
/// Existing docs.
/// </summary>
public int Existing(int x)
{
    return x;
}

public int Missing(int y)
{
    return y;
}
}
";

        var updated = XmlDocumentationGenerator.GenerateXmlDocumentationForSource(source, _ => "Generated docs.", 10);

        Assert.AreEqual(3, CountOccurrences(updated, "/// <summary>"));
        StringAssert.Contains(updated, "Existing docs.");
        StringAssert.Contains(updated, "Generated docs.");
    }

    [TestMethod]
    [TestCategory("Ai UnitTests")]
    public void GenerateXmlDocumentationForSource_IgnoresObsoleteMethodsWhenEnabled()
    {
        var source = @"
namespace Demo;

public class Sample
{
[Obsolete]
public int Legacy(int x)
{
    return x;
}

public int Active(int y)
{
    return y;
}
}
";

        var options = XmlDocRunOptions.CreateDefault(25);
        options.IgnoreObsolete = true;

        var updated = XmlDocumentationGenerator.GenerateXmlDocumentationForSource(source, _ => "Generated docs.", options);

        Assert.AreEqual(2, CountOccurrences(updated, "/// <summary>"));
        StringAssert.Contains(updated, "public int Active");
        StringAssert.Contains(updated, "Generated docs.");
    }

    [TestMethod]
    [TestCategory("Ai UnitTests")]
    public void GenerateXmlDocumentationForSource_IgnoresLikelyTestMethodsWhenEnabled()
    {
        var source = @"
namespace Demo;

public class SampleTests
{
[Fact]
public void UsesFact()
{
}

public void AlsoATestByTypeName()
{
}

public void ProductionLike()
{
}
}

public class RealService
{
public void DoWork()
{
}
}
";

        var options = XmlDocRunOptions.CreateDefault(25);
        options.IgnoreTestMethods = true;

        var updated = XmlDocumentationGenerator.GenerateXmlDocumentationForSource(source, _ => "Generated docs.", options);

        Assert.AreEqual(2, CountOccurrences(updated, "/// <summary>"));
        StringAssert.Contains(updated, "public void DoWork()");
    }

    [TestMethod]
    [TestCategory("Ai UnitTests")]
    public void GenerateXmlDocumentationForSource_IgnoresMethodsMatchingRegex()
    {
        var source = @"
namespace Demo;

public class Sample
{
public void KeepThis()
{
}

public void SkipThisOne()
{
}
}
";

        var options = XmlDocRunOptions.CreateDefault(25);
        options.IgnorePattern = "SkipThisOne$";

        var updated = XmlDocumentationGenerator.GenerateXmlDocumentationForSource(source, _ => "Generated docs.", options);

        Assert.AreEqual(2, CountOccurrences(updated, "/// <summary>"));
        Assert.IsTrue(updated.Contains("public void KeepThis()"));
        Assert.IsTrue(updated.Contains("public void SkipThisOne()"));
    }

    [TestMethod]
    [TestCategory("Ai UnitTests")]
    public void GenerateXmlDocumentationForSource_SkipsMethodsWhenSummaryProviderReturnsNull()
    {
        var source = @"
namespace Demo;

public class Sample
{
public int First(int x)
{
    return x + 1;
}

public int Second(int y)
{
    return y + 2;
}
}
";

        var updated = XmlDocumentationGenerator.GenerateXmlDocumentationForSource(source, _ => null, XmlDocRunOptions.CreateDefault(25));

        Assert.AreEqual(0, CountOccurrences(updated, "/// <summary>"));
    }

    [TestMethod]
    [TestCategory("Ai UnitTests")]
    public void PlanTargets_ReturnsPromptsForAiMembersAndDeterministicSummariesForTheRest()
    {
        var source = "namespace Demo;\r\n\r\npublic class Sample\r\n{\r\n    public string Name { get; set; }\r\n\r\n    public int Add(int x, int y)\r\n    {\r\n        return x + y;\r\n    }\r\n}\r\n";

        var targets = XmlDocumentationGenerator.PlanTargets(source, XmlDocRunOptions.CreateDefault(25));

        Assert.AreEqual(3, targets.Count);
        CollectionAssert.AreEqual(new[] { 0, 1, 2 }, targets.Select(x => x.Index).ToArray());
        CollectionAssert.AreEqual(new[] { "class", "property", "method" }, targets.Select(x => x.Kind).ToArray());
        CollectionAssert.AreEqual(new[] { "Sample", "Name", "Add" }, targets.Select(x => x.MemberName).ToArray());
        CollectionAssert.AreEqual(new[] { 2, 4, 6 }, targets.Select(x => x.Line).ToArray());
        CollectionAssert.AreEqual(new[] { true, false, true }, targets.Select(x => x.RequiresAi).ToArray());

        Assert.IsNull(targets[1].Prompt, "Deterministic members must not carry an AI prompt.");
        Assert.AreEqual("Gets or sets the name.", targets[1].FallbackSummary);
        StringAssert.Contains(targets[2].Prompt, "int Add(int x, int y)");
    }

    [TestMethod]
    [TestCategory("Ai UnitTests")]
    public void ApplySummaries_UsesSuppliedSummariesAndFallsBackForDeterministicMembers()
    {
        var source = "namespace Demo;\r\n\r\npublic class Sample\r\n{\r\n    public string Name { get; set; }\r\n\r\n    public int Add(int x, int y)\r\n    {\r\n        return x + y;\r\n    }\r\n}\r\n";
        var options = XmlDocRunOptions.CreateDefault(25);

        var updated = XmlDocumentationGenerator.ApplySummaries(source, options, new Dictionary<int, string>
        {
            [0] = "Represents a sample.",
            [2] = "Adds two numbers.",
        });

        StringAssert.Contains(updated, "/// Represents a sample.");
        StringAssert.Contains(updated, "/// Gets or sets the name.");
        StringAssert.Contains(updated, "/// Adds two numbers.");
        StringAssert.Contains(updated, "<param name=\"x\">The x.</param>");
        StringAssert.Contains(updated, "<returns>The int result.</returns>");
    }

    [TestMethod]
    [TestCategory("Ai UnitTests")]
    public void ApplySummaries_SkipsAiMembersWithoutASummary()
    {
        var source = "namespace Demo;\r\n\r\npublic class Sample\r\n{\r\n    public int Add(int x, int y)\r\n    {\r\n        return x + y;\r\n    }\r\n}\r\n";

        var updated = XmlDocumentationGenerator.ApplySummaries(source, XmlDocRunOptions.CreateDefault(25), new Dictionary<int, string>());

        Assert.AreEqual(0, CountOccurrences(updated, "/// <summary>"));
        Assert.AreEqual(source, updated);
    }

    private static string GetMemberName(MemberDeclarationSyntax member)
    {
        return member switch
        {
            MethodDeclarationSyntax method => method.Identifier.ValueText,
            BaseTypeDeclarationSyntax type => type.Identifier.ValueText,
            PropertyDeclarationSyntax property => property.Identifier.ValueText,
            FieldDeclarationSyntax field => field.Declaration.Variables.First().Identifier.ValueText,
            EventFieldDeclarationSyntax eventField => eventField.Declaration.Variables.First().Identifier.ValueText,
            EventDeclarationSyntax eventDeclaration => eventDeclaration.Identifier.ValueText,
            _ => "member",
        };
    }

    private static int CountOccurrences(string text, string value)
    {
        var count = 0;
        var index = text.IndexOf(value, StringComparison.Ordinal);
        while (index >= 0)
        {
            count++;
            index = text.IndexOf(value, index + value.Length, StringComparison.Ordinal);
        }

        return count;
    }
}
