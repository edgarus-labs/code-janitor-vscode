using CodeJanitor.Engine.Diagnostics;
using CodeJanitor.Engine.Tests.Steps.Support;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;
using Xunit;

namespace CodeJanitor.Engine.Tests.Diagnostics;

/// <summary>The using directives of <c>usingStatementsToReinsertWhenRemoved</c> come back where they were, in the line ending of the file.</summary>
public sealed class ReinsertUsingsTests
{
    [Theory]
    [InlineData("using System;\nusing System.Linq;\nusing System.Text;\n\nclass C\n{\n}\n", "class C\n{\n}\n", new[] { "using System;", "using System.Linq;" }, "using System;\nusing System.Linq;\n\nclass C\n{\n}\n")]
    [InlineData("using System.Linq;\nusing System.Text;\n\nnamespace N\n{\n    class C\n    {\n    }\n}\n", "namespace N\n{\n    class C\n    {\n    }\n}\n", new[] { "using System.Linq;" }, "using System.Linq;\n\nnamespace N\n{\n    class C\n    {\n    }\n}\n")]
    [InlineData("namespace N\n{\n    using System.Linq;\n    using System.Text;\n\n    class C\n    {\n    }\n}\n", "namespace N\n{\n    class C\n    {\n    }\n}\n", new[] { "using System.Linq;" }, "namespace N\n{\n    using System.Linq;\n\n    class C\n    {\n    }\n}\n")]
    [InlineData("using System.Linq;\n\nnamespace N;\n\nclass C\n{\n}\n", "namespace N;\n\nclass C\n{\n}\n", new[] { "using System.Linq;" }, "using System.Linq;\n\nnamespace N;\n\nclass C\n{\n}\n")]
    [InlineData("using System;\nusing System.Linq;\nusing System.Text;\n\nclass C\n{\n    StringBuilder builder;\n}\n", "using System.Text;\n\nclass C\n{\n    StringBuilder builder;\n}\n", new[] { "using System.Linq;" }, "using System.Linq;\nusing System.Text;\n\nclass C\n{\n    StringBuilder builder;\n}\n")]
    [InlineData("using System.Text;\nusing System.Linq;\n\nclass C\n{\n    StringBuilder builder;\n}\n", "using System.Text;\n\nclass C\n{\n    StringBuilder builder;\n}\n", new[] { "using System.Linq;" }, "using System.Text;\nusing System.Linq;\n\nclass C\n{\n    StringBuilder builder;\n}\n")]
    [InlineData("using System.Linq;\r\nusing System.Text;\r\n\r\nclass C\r\n{\r\n}\r\n", "class C\r\n{\r\n}\r\n", new[] { "using System.Linq;" }, "using System.Linq;\r\n\r\nclass C\r\n{\r\n}\r\n")]
    [InlineData("// header\nusing System.Text;\nusing System.Linq;\n\nclass C\n{\n}\n", "// header\nusing System.Text;\n\nclass C\n{\n}\n", new[] { "using System.Linq;" }, "// header\nusing System.Text;\nusing System.Linq;\n\nclass C\n{\n}\n")]
    [InlineData("// header\nusing System.Linq;\nusing System.Text;\n\nclass C\n{\n}\n", "// header\nusing System.Text;\n\nclass C\n{\n}\n", new[] { "using System.Linq;" }, "// header\nusing System.Linq;\nusing System.Text;\n\nclass C\n{\n}\n")]
    public async Task KeptDirectives_AreReinsertedAtTheirPlaceInTheirContainer(string original, string afterRemoval, string[] keep, string expected)
    {
        var document = StepHarness.Document(original);
        var kept = await RoslynRulesStep.KeptUsingsAsync(document, keep, CancellationToken.None);
        var removed = document.WithText(SourceText.From(afterRemoval));

        var solution = await RoslynRulesStep.ReinsertUsingsAsync(removed.Project.Solution, removed.Id, kept, CancellationToken.None);

        Assert.Equal(expected, (await solution.GetDocument(removed.Id)!.GetTextAsync()).ToString());
    }

    [Fact]
    public async Task KeptDirectives_ThatAreStillThere_AreNotInsertedAgain()
    {
        var document = StepHarness.Document("using System.Linq;\nusing System.Text;\n\nclass C\n{\n}\n");
        var kept = await RoslynRulesStep.KeptUsingsAsync(document, ["using System.Linq;"], CancellationToken.None);

        var solution = await RoslynRulesStep.ReinsertUsingsAsync(document.Project.Solution, document.Id, kept, CancellationToken.None);

        Assert.Same(document.Project.Solution, solution);
    }

    [Fact]
    public async Task WithoutDirectivesToKeep_NothingIsKept()
    {
        var document = StepHarness.Document("using System.Linq;\n\nclass C\n{\n}\n");

        Assert.Empty(await RoslynRulesStep.KeptUsingsAsync(document, [], CancellationToken.None));
        Assert.Empty(await RoslynRulesStep.KeptUsingsAsync(document, ["using System.Text;"], CancellationToken.None));
    }
}
