#nullable disable
using CodeJanitor.Engine.Commands;
using Xunit;
using Assert = CodeJanitor.Engine.Tests.Steps.Support.MsAssert;

namespace CodeJanitor.Engine.Tests.Commands;

public sealed class RemoveXmlDocumentationLogicTests
{
    [Fact]
    public void TryRemoveXmlDocumentation_RemovesSingleLineDocCommentsFromClassAndMethod()
    {
        string input = @"namespace Demo;

/// <summary>
/// Sample class summary.
/// </summary>
public class Sample
{
    /// <summary>
    /// Computes the sum of two integers.
    /// </summary>
    /// <param name=""a"">The first number.</param>
    /// <param name=""b"">The second number.</param>
    /// <returns>The total.</returns>
    public int Add(int a, int b)
    {
        return a + b;
    }
}
";

        bool changed = RemoveXmlDocumentationLogic.TryRemoveXmlDocumentation(input, out string result);

        Assert.IsTrue(changed);
        Assert.DoesNotContain("/// <summary>", result);
        Assert.DoesNotContain("Sample class summary.", result);
        Assert.DoesNotContain("Computes the sum of two integers.", result);
        Assert.DoesNotContain("<param", result);
        Assert.DoesNotContain("<returns", result);
        Assert.Contains("public class Sample", result);
        Assert.Contains("    public int Add(int a, int b)", result);
    }

    [Fact]
    public void TryRemoveXmlDocumentation_RemovesMultiLineDocComments()
    {
        string input = @"namespace Demo;

/**
 * <summary>
 * Multi-line documentation comment.
 * </summary>
 */
public interface IService
{
    void Execute();
}
";

        bool changed = RemoveXmlDocumentationLogic.TryRemoveXmlDocumentation(input, out string result);

        Assert.IsTrue(changed);
        Assert.DoesNotContain("Multi-line documentation comment.", result);
        Assert.Contains("public interface IService", result);
    }

    [Fact]
    public void TryRemoveXmlDocumentation_PreservesRegularComments()
    {
        string input = @"namespace Demo;

// Regular single line comment
/* Regular block comment */
public class Sample
{
    // Implementation note
    /// <summary>
    /// Method summary to remove.
    /// </summary>
    public void DoWork()
    {
        // Inside method body
    }
}
";

        bool changed = RemoveXmlDocumentationLogic.TryRemoveXmlDocumentation(input, out string result);

        Assert.IsTrue(changed);
        Assert.DoesNotContain("Method summary to remove.", result);
        Assert.Contains("// Regular single line comment", result);
        Assert.Contains("/* Regular block comment */", result);
        Assert.Contains("// Implementation note", result);
        Assert.Contains("// Inside method body", result);
    }

    [Fact]
    public void TryRemoveXmlDocumentation_ReturnsFalseWhenNoXmlDocPresent()
    {
        string input = @"namespace Demo;

public class CleanClass
{
    // Just a regular comment
    public void CleanMethod()
    {
    }
}
";

        bool changed = RemoveXmlDocumentationLogic.TryRemoveXmlDocumentation(input, out string result);

        Assert.IsFalse(changed);
        Assert.AreEqual(input, result);
    }

    [Fact]
    public void TryRemoveXmlDocumentation_HandlesNullOrWhitespace()
    {
        Assert.IsFalse(RemoveXmlDocumentationLogic.TryRemoveXmlDocumentation(null, out string r1));
        Assert.IsNull(r1);

        Assert.IsFalse(RemoveXmlDocumentationLogic.TryRemoveXmlDocumentation("   ", out string r2));
        Assert.AreEqual("   ", r2);
    }
}
