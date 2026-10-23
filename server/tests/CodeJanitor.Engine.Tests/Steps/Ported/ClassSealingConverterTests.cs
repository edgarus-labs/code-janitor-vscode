#nullable disable
using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Composition.Hosting;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using CodeJanitor.Engine.Steps.Transformations;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Host;
using Microsoft.CodeAnalysis.Host.Mef;
using Microsoft.CodeAnalysis.Text;
using Xunit;
using Assert = CodeJanitor.Engine.Tests.Steps.Support.MsAssert;

namespace CodeJanitor.Engine.Tests.Steps;

/// <summary>
/// Unit tests for <see cref="ClassSealingConverter" />. A top-level class or record class is sealed only when the
/// semantic model proves it is not designed or used for inheritance anywhere in the solution: it has no virtual or
/// protected members (constructors included), no class of the solution derives from it and no generic constraint of
/// the solution names it. Every sealed result must compile without errors and without CS0628 (new protected member
/// declared in sealed type).
/// </summary>
public sealed class ClassSealingConverterTests
{
    [Fact]
    public async Task InternalClassWithoutDerivedTypes_BecomesSealed() => Assert.AreEqual("internal sealed class Foo { }", await SealAsync("internal class Foo { }"));

    [Fact]
    public async Task ClassWithNoAccessModifier_BecomesSealed() => Assert.AreEqual("sealed class Foo { }", await SealAsync("class Foo { }"));

    [Fact]
    public async Task PublicClass_BecomesSealed() => Assert.AreEqual("public sealed class Foo { }", await SealAsync("public class Foo { }"));

    [Fact]
    public async Task PublicRecordClass_BecomesSealed() => Assert.AreEqual("public sealed record Person(string Name);", await SealAsync("public record Person(string Name);"));

    [Fact]
    public async Task FileScopedNamespace_SealsTopLevelClass() => Assert.AreEqual("namespace N;\r\nsealed class Foo { }", await SealAsync("namespace N;\r\nclass Foo { }"));

    [Fact]
    public async Task ClassImplementingInterface_BecomesSealed() => Assert.AreEqual(
            "internal sealed class Foo : System.IDisposable { public void Dispose() { } }",
            await SealAsync("internal class Foo : System.IDisposable { public void Dispose() { } }"));

    [Fact]
    public async Task NestedClass_IsNotSealed_OnlyTopLevelConsidered() => Assert.AreEqual(
            "internal sealed class Outer { internal class Inner { } }",
            await SealAsync("internal class Outer { internal class Inner { } }"));

    [Fact]
    public async Task ProtectedOverride_DoesNotPreventSealing() => Assert.AreEqual(
            "public class B { protected virtual void M() { } } public sealed class A : B { protected override void M() { } }",
            await SealAsync("public class B { protected virtual void M() { } } public class A : B { protected override void M() { } }"));

    [Fact]
    public async Task PublicOverride_DoesNotPreventSealing() => Assert.AreEqual(
            "public sealed class A { public override string ToString() => \"A\"; }",
            await SealAsync("public class A { public override string ToString() => \"A\"; }"));

    [Theory]
    [InlineData("internal sealed class Foo { }")]
    [InlineData("internal abstract class Foo { }")]
    [InlineData("internal static class Foo { }")]
    [InlineData("internal partial class Foo { }")]
    [InlineData("public record struct Point(int X, int Y);")]
    [InlineData("public struct Point { }")]
    [InlineData("public interface IFoo { }")]
    public async Task TypeThatCannotOrNeedNotBeSealed_IsUnchanged(string input) => Assert.AreEqual(input, await SealAsync(input));

    [Theory]
    [InlineData("public class Example\r\n{\r\n    protected Example()\r\n    {\r\n    }\r\n}\r\n")]
    [InlineData("public class Example { private protected Example() { } }")]
    [InlineData("public class Example { protected internal Example() { } }")]
    [InlineData("public class Example { public Example() { } protected Example(int value) { } }")]
    [InlineData("public class Example { protected void M() { } }")]
    [InlineData("public class Example { protected int _value; }")]
    [InlineData("public class Example { protected int Value { get; set; } }")]
    [InlineData("public class Example { public int Value { get; protected set; } }")]
    [InlineData("public class Example { protected event System.EventHandler Changed; }")]
    [InlineData("public class Example { protected class Nested { } }")]
    [InlineData("public class Example { protected const int Value = 1; }")]
    [InlineData("public class Example { protected static void M() { } }")]
    [InlineData("public class Example { protected static int _count; }")]
    [InlineData("public class Example { public int this[int i] { get => i; protected set { } } }")]
    [InlineData("public record Example(string Name) { protected Example(Example original) { Name = original.Name; } }")]
    public async Task ClassWithProtectedMember_StaysUnsealed(string input) => Assert.AreEqual(input, await SealAsync(input));

    [Theory]
    [InlineData("public class Foo { public virtual void DoWork() { } }")]
    [InlineData("public class Foo { public virtual int Value { get; set; } }")]
    [InlineData("public class Foo { public virtual int this[int i] => i; }")]
    [InlineData("public class Foo { public virtual event System.EventHandler Changed; }")]
    [InlineData("public class Foo : SomeUnresolvedBase { public virtual int Value { get; } }")]
    public async Task ClassWithVirtualMember_StaysUnsealed(string input) => Assert.AreEqual(input, await SealAsync(input));

    [Fact]
    public async Task ClassWithDerivedClassInSameFile_BaseStaysUnsealed_DerivedBecomesSealed() => Assert.AreEqual(
            "public class Animal { } public sealed class Dog : Animal { }",
            await SealAsync("public class Animal { } public class Dog : Animal { }"));

    [Fact]
    public async Task ClassWithDerivedClassInAnotherFile_StaysUnsealed()
    {
        string input = "namespace Demo { public class Result { } }";

        Assert.AreEqual(input, await SealAsync(input, "namespace Demo { public class Result<T> : Result { } }"));
    }

    [Fact]
    public async Task ClassWithDerivedClassInAnotherProject_StaysUnsealed()
    {
        string input = "namespace Demo { public class Result { } }";
        Document derivingDocument = CompilingTestProject.CreateDocumentReferencingProject(
            "namespace Consumer { public class Special : Demo.Result { } }",
            new[] { input });
        Document document = derivingDocument.Project.Solution.Projects
            .Single(project => project.Name == "ReferencedProject")
            .Documents.Single();

        Assert.AreEqual(input, await SealAsync(document));
    }

    [Fact]
    public async Task GenericBase_DerivedThroughClosedConstruction_StaysUnsealed() => Assert.AreEqual(
            "public class Box<T> { } public sealed class IntBox : Box<int> { }",
            await SealAsync("public class Box<T> { } public class IntBox : Box<int> { }"));

    [Fact]
    public async Task QualifiedBaseTypes_IdentifyTheBaseClass() => Assert.AreEqual(
            "namespace N { class Animal { } sealed class Dog : global::N.Animal { } sealed class Cat : N.Animal { } }",
            await SealAsync("namespace N { class Animal { } class Dog : global::N.Animal { } class Cat : N.Animal { } }"));

    [Fact]
    public async Task SameNameInAnotherNamespace_DoesNotPreventSealing() => Assert.AreEqual(
            "namespace X { public class A { } } namespace Y { public sealed class A { } public sealed class D : X.A { } }",
            await SealAsync("namespace X { public class A { } } namespace Y { public class A { } public class D : X.A { } }"));

    [Fact]
    public async Task ClassUsedInGenericConstraintInSameFile_StaysUnsealed() => Assert.AreEqual(
            "public class Result { } public sealed class Handler<T> where T : Result { }",
            await SealAsync("public class Result { } public class Handler<T> where T : Result { }"));

    [Fact]
    public async Task ClassUsedInNullableGenericConstraintInSameFile_StaysUnsealed() => Assert.AreEqual(
            "#nullable enable\r\npublic class Result { } public sealed class Handler<T> where T : Result? { }",
            await SealAsync("#nullable enable\r\npublic class Result { } public class Handler<T> where T : Result? { }"));

    [Fact]
    public async Task ClassUsedInGenericMethodConstraintInAnotherFile_StaysUnsealed()
    {
        string input = "namespace Demo { public class Result { } }";

        Assert.AreEqual(input, await SealAsync(input, "namespace Demo { public static class Handler { public static void Handle<T>(T value) where T : Result { } } }"));
    }

    [Fact]
    public async Task ClassUsedInGenericConstraintInAnotherProject_StaysUnsealed()
    {
        string input = "namespace Demo { public class Result { } }";
        Document constrainingDocument = CompilingTestProject.CreateDocumentReferencingProject(
            "namespace Consumer { public class Handler<T> where T : Demo.Result { } }",
            new[] { input });
        Document document = constrainingDocument.Project.Solution.Projects
            .Single(project => project.Name == "ReferencedProject")
            .Documents.Single();

        Assert.AreEqual(input, await SealAsync(document));
    }

    [Fact]
    public async Task GenericClassUsedInConstraintThroughClosedConstruction_StaysUnsealed() => Assert.AreEqual(
            "public class Box<T> { } public sealed class Handler<T> where T : Box<int> { }",
            await SealAsync("public class Box<T> { } public class Handler<T> where T : Box<int> { }"));

    [Fact]
    public async Task GenericClassWithOwnConstraints_BecomesSealed() => Assert.AreEqual(
            "public sealed class Repository<T> where T : class, new() { public T Create() => new T(); }",
            await SealAsync("public class Repository<T> where T : class, new() { public T Create() => new T(); }"));

    [Fact]
    public async Task FileLocalClass_BecomesSealed() => Assert.AreEqual("file sealed class Helper { }", await SealAsync("file class Helper { }"));

    [Fact]
    public async Task FileLocalClassWithDerivedFileLocalClass_BaseStaysUnsealed() => Assert.AreEqual(
            "file class Base { } file sealed class Derived : Base { }",
            await SealAsync("file class Base { } file class Derived : Base { }"));

    [Fact]
    public async Task ClassInFileWithCompileErrors_IsSealedWithoutAddingErrors() => Assert.AreEqual(
            "public sealed class Foo { public void M() { int x = ; } }",
            await SealAsync("public class Foo { public void M() { int x = ; } }"));

    [Fact]
    public async Task ClassWithProtectedMemberInFileWithCompileErrors_StaysUnsealed()
    {
        string input = "public class Foo { protected Foo() { } public void M() { UnknownType x = null; } }";

        Assert.AreEqual(input, await SealAsync(input));
    }

    [Fact]
    public async Task ClassDerivedFromInFileWithCompileErrors_BaseStaysUnsealed_DerivedBecomesSealed()
    {
        string input = "public class Base { } public class Derived : Base { public void M() { int x = ; } }";

        Assert.AreEqual("public class Base { } public sealed class Derived : Base { public void M() { int x = ; } }", await SealAsync(input));
    }

    [Fact]
    public async Task FileCompiledByTwoProjects_IsSealedOnlyWhenSafeInBoth()
    {
        string input = "namespace Demo { public class Result { } }";
        Solution solution = new AdhocWorkspace().CurrentSolution;
        Document first = AddProject(ref solution, "First", input, "namespace Demo { public class Other { } }");
        Document second = AddProject(ref solution, "Second", input, "namespace Demo { public class Derived : Result { } }");

        string result = await new ClassSealingConverter().SealWhenSafeAsync(
            new[] { solution.GetDocument(first.Id), solution.GetDocument(second.Id) },
            CancellationToken.None);

        Assert.AreEqual(input, result);
    }

    [Fact]
    public async Task FileCompiledByTwoProjects_IsSealedWhenSafeInBoth()
    {
        string input = "namespace Demo { public class Result { } }";
        Solution solution = new AdhocWorkspace().CurrentSolution;
        Document first = AddProject(ref solution, "First", input);
        Document second = AddProject(ref solution, "Second", input);

        string result = await new ClassSealingConverter().SealWhenSafeAsync(
            new[] { solution.GetDocument(first.Id), solution.GetDocument(second.Id) },
            CancellationToken.None);

        Assert.AreEqual("namespace Demo { public sealed class Result { } }", result);
    }

    [Fact]
    public async Task NullDocumentList_Throws()
    {
        ArgumentException exception = await Assert.ThrowsAsync<ArgumentException>(
            () => new ClassSealingConverter().SealWhenSafeAsync(null, CancellationToken.None));

        Assert.AreEqual("documents", exception.ParamName);
    }

    [Fact]
    public async Task EmptyDocumentList_Throws()
    {
        ArgumentException exception = await Assert.ThrowsAsync<ArgumentException>(
            () => new ClassSealingConverter().SealWhenSafeAsync(new Document[0], CancellationToken.None));

        Assert.AreEqual("documents", exception.ParamName);
    }

    [Theory]
    [InlineData("")]
    [InlineData("  \r\n\t\r\n")]
    [InlineData("// just a comment\r\n")]
    [InlineData("namespace Demo { public enum Kind { A } public delegate void Handler(); }")]
    public async Task FileWithoutCandidates_IsReturnedUnchanged(string input) => Assert.AreEqual(input, await SealAsync(input));

    [Fact]
    public async Task ClassReferencedOutsideConstraints_BecomesSealed() => Assert.AreEqual(
            "public sealed class Settings { } public sealed class Consumer { Settings _s = new Settings(); System.Collections.Generic.List<Settings> _all; Settings Get() => (Settings)null; }",
            await SealAsync(
                "public class Settings { } public class Consumer { Settings _s = new Settings(); System.Collections.Generic.List<Settings> _all; Settings Get() => (Settings)null; }"));

    [Theory]
    [InlineData("object M(Foo foo) => (IBar)foo;")]
    [InlineData("object M(Foo foo) => foo as IBar;")]
    [InlineData("bool M(Foo foo) => foo is IBar;")]
    [InlineData("bool M(Foo foo) => foo is IBar bar;")]
    [InlineData("int M(Foo foo) { switch (foo) { case IBar bar: return 1; default: return 0; } }")]
    [InlineData("int M(Foo foo) => foo switch { IBar bar => 1, _ => 0 };")]
    [InlineData("bool M(Foo[] foos) => foos is IBar[];")]
    [InlineData("object M(IBar bar) => (Foo)bar;")]
    [InlineData("bool M(IBar bar) => bar is Foo foo;")]
    [InlineData("void M(Foo[] foos) { foreach (IBar bar in foos) { } }")]
    [InlineData("int M(Foo foo) { switch (foo) { case IBar: return 1; default: return 0; } }")]
    [InlineData("bool M(Foo foo, IBar bar) => foo == bar;")]
    [InlineData("bool M(IBar bar, Foo foo) => bar != foo;")]
    [InlineData("object M(Foo foo) => ((IBar, int))(foo, 1);")]
    [InlineData("object M((int, Foo) pair) => ((int, IBar))pair;")]
    [InlineData("object M(System.Func<Foo> make) => (System.Func<IBar>)make;")]
    [InlineData("object M(System.Func<Foo>[] makers) => (System.Func<IBar>[])makers;")]
    [InlineData("object M(Foo[] foos) => (System.Collections.Generic.IList<IBar>)foos;")]
    [InlineData("object M(Foo[] foos) => foos as System.Collections.Generic.IEnumerable<IBar>;")]
    [InlineData("object M(System.Collections.Generic.IList<IBar> bars) => (Foo[])bars;")]
    [InlineData("object M(System.Collections.Generic.IReadOnlyList<IBar> bars) => bars as Foo[];")]
    public async Task ClassConvertedToAnInterfaceItDoesNotImplement_StaysUnsealed(string use)
    {
        string input = "public class Foo { }";

        Assert.AreEqual(input, await SealAsync(input, "public interface IBar { } public static class Use { public static " + use + " }"));
    }

    [Theory]
    [InlineData("object M(System.Collections.Generic.IEnumerable<Foo> foos) => (System.Collections.Generic.IEnumerable<IBar>)foos;")]
    [InlineData("bool M(System.Collections.Generic.IEnumerable<Foo> foos) => foos is System.Collections.Generic.IEnumerable<IBar>;")]
    [InlineData("object M(System.Action<IBar> use) => (System.Action<Foo>)use;")]
    public async Task ClassConvertedOnlyThroughAnInterfaceOrContravariantTypeArgument_BecomesSealed(string use) => Assert.AreEqual(
            "public sealed class Foo { }",
            await SealAsync("public class Foo { }", "public interface IBar { } public static class Use { public static " + use + " }"));

    [Theory]
    [InlineData("object M(Foo[] foos) => (System.Collections.Generic.IList<Foo>)foos;")]
    [InlineData("object M(System.Collections.Generic.IList<Foo> foos) => (Foo[])foos;")]
    [InlineData("object M(System.Collections.Generic.IList<IBar> bars) => (IBar[])bars;")]
    public async Task ClassInArrayConvertedWithAGenericInterfaceOfItself_BecomesSealed(string use) => Assert.AreEqual(
            "public sealed class Foo { }",
            await SealAsync("public class Foo { }", "public interface IBar { } public static class Use { public static " + use + " }"));

    [Fact]
    public async Task ClassOfAProjectReferencedByANonCSharpProject_StaysUnsealed()
    {
        // The converter cannot see derivations, constraints or conversions written in another language.
        string input = "namespace Demo { public class Foo { } }";
        Solution solution = new AdhocWorkspace(NonCSharpLanguageHost).CurrentSolution;
        Document target = AddProject(ref solution, "Library", input);
        ProjectId consumerId = ProjectId.CreateNewId();
        solution = solution
            .AddProject(ProjectInfo.Create(consumerId, VersionStamp.Create(), "Consumer", "Consumer", LanguageNames.VisualBasic))
            .AddProjectReference(consumerId, new ProjectReference(target.Project.Id));

        Assert.AreEqual(input, await SealAsync(solution.GetDocument(target.Id)));
    }

    [Theory]
    [InlineData("Library")]
    [InlineData("Middle")]
    public async Task ClassOfAProjectUsedByAProjectOutsideTheWorkspace_StaysUnsealed(string referencedOutside)
    {
        // A C++/CLI project, for example, is not in the Roslyn workspace: its derived classes go unseen.
        string input = "namespace Demo { public class Foo { } }";
        Solution solution = new AdhocWorkspace().CurrentSolution;
        Document target = AddProject(ref solution, "Library", input);
        Document middle = AddProject(ref solution, "Middle", "public class Other { }");
        solution = solution
            .AddProjectReference(middle.Project.Id, new ProjectReference(target.Project.Id))
            .WithProjectFilePath(target.Project.Id, @"C:\Repo\Library\Library.csproj")
            .WithProjectFilePath(middle.Project.Id, @"C:\Repo\Middle\Middle.csproj");

        string result = await new ClassSealingConverter().SealWhenSafeAsync(
            new[] { solution.GetDocument(target.Id) },
            new[] { $@"c:\repo\{referencedOutside.ToLowerInvariant()}\{referencedOutside}.csproj" },
            CancellationToken.None);

        Assert.AreEqual(input, result);
    }

    [Fact]
    public async Task ClassOfAProjectNotUsedByTheProjectsOutsideTheWorkspace_BecomesSealed()
    {
        Solution solution = new AdhocWorkspace().CurrentSolution;
        Document target = AddProject(ref solution, "Library", "namespace Demo { public class Foo { } }");
        solution = solution.WithProjectFilePath(target.Project.Id, @"C:\Repo\Library\Library.csproj");

        string result = await new ClassSealingConverter().SealWhenSafeAsync(
            new[] { solution.GetDocument(target.Id) },
            new[] { @"C:\Repo\Other\Other.csproj" },
            CancellationToken.None);

        Assert.AreEqual("namespace Demo { public sealed class Foo { } }", result);
    }

    [Fact]
    public async Task ClassOfAProjectNotReferencedByTheNonCSharpProject_BecomesSealed()
    {
        Solution solution = new AdhocWorkspace(NonCSharpLanguageHost).CurrentSolution;
        Document target = AddProject(ref solution, "Library", "namespace Demo { public class Foo { } }");
        solution = solution.AddProject(ProjectInfo.Create(ProjectId.CreateNewId(), VersionStamp.Create(), "Other", "Other", LanguageNames.VisualBasic));

        Assert.AreEqual("namespace Demo { public sealed class Foo { } }", await SealAsync(solution.GetDocument(target.Id)));
    }

    [Fact]
    public async Task FilesOfTheSameSolution_AreSealedAsWhenAnalyzedOneByOne()
    {
        Solution solution = new AdhocWorkspace().CurrentSolution;
        Document converted = AddProject(
            ref solution,
            "Library",
            "public class Foo { }",
            "public interface IBar { } public static class Use { public static object M(Foo foo) => (IBar)foo; }");
        Document free = solution.GetProject(converted.Project.Id).AddDocument("Free.cs", SourceText.From("public class Free { }"));
        solution = free.Project.Solution;
        Document inactive = AddProject(ref solution, "Legacy", "public class Widget { }", "#if LEGACY\r\npublic class OldWidget : Widget { }\r\n#endif\r\n");
        Document[] documents = { solution.GetDocument(converted.Id), solution.GetDocument(inactive.Id), solution.GetDocument(free.Id) };
        string[] expected = { "public class Foo { }", "public class Widget { }", "public sealed class Free { }" };
        ClassSealingConverter shared = new ClassSealingConverter();

        foreach (int index in new[] { 2, 0, 1, 2, 1, 0 })
        {
            Assert.AreEqual(expected[index], await shared.SealWhenSafeAsync(new[] { documents[index] }, CancellationToken.None));
            Assert.AreEqual(expected[index], await new ClassSealingConverter().SealWhenSafeAsync(new[] { documents[index] }, CancellationToken.None));
        }
    }

    [Fact]
    public async Task ConverterReusedOnAChangedSolution_SeesTheChange()
    {
        Solution solution = new AdhocWorkspace().CurrentSolution;
        Document target = AddProject(ref solution, "Library", "public class Foo { }", "public interface IBar { }", "public static class Use { }");
        DocumentId useId = solution.GetProject(target.Project.Id).Documents.Single(document => document.Name == "Library1.cs").Id;
        Solution converting = solution.WithDocumentText(useId, SourceText.From("public static class Use { public static object M(Foo foo) => (IBar)foo; }"));
        Solution inactive = solution.WithDocumentText(useId, SourceText.From("#if LEGACY\r\npublic static class Use { static object M(Foo foo) => foo; }\r\n#endif\r\n"));
        ClassSealingConverter shared = new ClassSealingConverter();

        Assert.AreEqual("public sealed class Foo { }", await shared.SealWhenSafeAsync(new[] { solution.GetDocument(target.Id) }, CancellationToken.None));
        Assert.AreEqual("public class Foo { }", await shared.SealWhenSafeAsync(new[] { converting.GetDocument(target.Id) }, CancellationToken.None));
        Assert.AreEqual("public class Foo { }", await shared.SealWhenSafeAsync(new[] { inactive.GetDocument(target.Id) }, CancellationToken.None));
        Assert.AreEqual("public sealed class Foo { }", await shared.SealWhenSafeAsync(new[] { solution.GetDocument(target.Id) }, CancellationToken.None));
    }

    [Fact]
    public async Task ConversionScanOfAnUnchangedProject_IsReusedAcrossSolutionSnapshots()
    {
        // A batch sees a new snapshot after every rewritten file (and one with the text of the file being cleaned):
        // the scan of a project that did not change must not be repeated for each of them.
        Solution solution = new AdhocWorkspace().CurrentSolution;
        Document library = AddProject(ref solution, "Library", "public class Foo { }", "public interface IBar { }", "public static class Use { public static object M(Foo foo) => (IBar)foo; }");
        Document other = AddProject(ref solution, "Other", "public class Unrelated { }");
        Solution otherProjectChanged = solution.WithDocumentText(other.Id, SourceText.From("public class Unrelated { int _value; }"));
        ClassSealingConverter converter = new ClassSealingConverter();

        ClassSealingConverter.ConvertedClasses first = await converter.GetConvertedClassesAsync(solution.GetProject(library.Project.Id), CancellationToken.None);
        ClassSealingConverter.ConvertedClasses second = await converter.GetConvertedClassesAsync(otherProjectChanged.GetProject(library.Project.Id), CancellationToken.None);

        Assert.IsNotNull(first);
        Assert.AreSame(first, second);
    }

    [Fact]
    public async Task ConversionScanOfAProject_IsRepeatedWhenItsOwnTextChanges()
    {
        Solution solution = new AdhocWorkspace().CurrentSolution;
        Document library = AddProject(ref solution, "Library", "public class Foo { }", "public interface IBar { }", "public static class Use { }");
        DocumentId useId = solution.GetProject(library.Project.Id).Documents.Single(document => document.Name == "Library1.cs").Id;
        Solution changed = solution.WithDocumentText(useId, SourceText.From("public static class Use { public static object M(Foo foo) => (IBar)foo; }"));
        ClassSealingConverter converter = new ClassSealingConverter();

        ClassSealingConverter.ConvertedClasses before = await converter.GetConvertedClassesAsync(solution.GetProject(library.Project.Id), CancellationToken.None);
        ClassSealingConverter.ConvertedClasses after = await converter.GetConvertedClassesAsync(changed.GetProject(library.Project.Id), CancellationToken.None);

        Assert.AreNotSame(before, after);
        Assert.IsEmpty(before.Classes);
        Assert.HasCount(1, after.Classes);
    }

    [Fact]
    public async Task ConversionScanOfAProject_IsRepeatedWhenAProjectItReferencesChanges()
    {
        // The symbols of the scan belong to the compilation of the project, which is built against the referenced one.
        Solution solution = new AdhocWorkspace().CurrentSolution;
        Document library = AddProject(ref solution, "Library", "namespace Demo { public class Foo { } public interface IBar { } }");
        Document consumer = AddProject(ref solution, "Consumer", "namespace Consumer { public static class Use { public static object M(Demo.Foo foo) => (Demo.IBar)foo; } }");
        solution = solution.AddProjectReference(consumer.Project.Id, new ProjectReference(library.Project.Id));
        Solution libraryChanged = solution.WithDocumentText(library.Id, SourceText.From("namespace Demo { public class Foo { int _value; } public interface IBar { } }"));
        ClassSealingConverter converter = new ClassSealingConverter();

        ClassSealingConverter.ConvertedClasses before = await converter.GetConvertedClassesAsync(solution.GetProject(consumer.Project.Id), CancellationToken.None);
        ClassSealingConverter.ConvertedClasses after = await converter.GetConvertedClassesAsync(libraryChanged.GetProject(consumer.Project.Id), CancellationToken.None);

        Assert.AreNotSame(before, after);
        Assert.HasCount(1, before.Classes);
        Assert.HasCount(1, after.Classes);
    }

    [Fact]
    public async Task ConversionScan_ReadsSourceGeneratedDocuments()
    {
        // Source generators run in every build: a conversion in their output removes the explicit conversion of the
        // class just as one in a written file does.
        Solution solution = new AdhocWorkspace().CurrentSolution;
        Document library = AddProject(ref solution, "Library", "public class Foo { }", "public interface IBar { }");
        solution = AddSourceGenerator(solution, library.Project.Id, "public static class Use { public static object M(Foo foo) => (IBar)foo; }");
        Project project = solution.GetProject(library.Project.Id);

        ClassSealingConverter.ConvertedClasses scan = await new ClassSealingConverter().GetConvertedClassesAsync(project, CancellationToken.None);

        Assert.HasCount(1, await project.GetSourceGeneratedDocumentsAsync(CancellationToken.None), "The generator must add its file.");
        Assert.AreEqual("Foo", scan.Classes.Single().Name);
    }

    [Fact]
    public async Task InactiveCodeOfASourceGeneratedDocument_KeepsTheClassUnsealed()
    {
        // Inactive code of generated files is compiled by the builds that define its symbols, like written files.
        Solution solution = new AdhocWorkspace().CurrentSolution;
        Document library = AddProject(ref solution, "Library", "public class Widget { }");
        solution = AddSourceGenerator(solution, library.Project.Id, "#if LEGACY\r\npublic class OldWidget : Widget { }\r\n#endif\r\n");

        Assert.HasCount(1, await solution.GetProject(library.Project.Id).GetSourceGeneratedDocumentsAsync(CancellationToken.None), "The generator must add its file.");
        Assert.AreEqual("public class Widget { }", await SealAsync(solution.GetDocument(library.Id)));
    }

    [Fact]
    public async Task AnalysisCache_ComputesEachKeyOnce_AndSharesTheValueWithConcurrentCallers()
    {
        ClassSealingConverter.AsyncCache<object, string> cache = new ClassSealingConverter.AsyncCache<object, string>();
        object key = new object();
        VersionStamp version = VersionStamp.Create();
        TaskCompletionSource<string> gate = new TaskCompletionSource<string>();
        int computations = 0;

        Task<string> first = cache.GetOrComputeAsync(key, version, _ =>
        {
            computations++;

            return gate.Task;
        }, CancellationToken.None);
        Task<string> concurrent = cache.GetOrComputeAsync(key, version, _ =>
        {
            computations++;

            return Task.FromResult("concurrent");
        }, CancellationToken.None);
        gate.SetResult("first");

        Assert.AreEqual("first", await first);
        Assert.AreEqual("first", await concurrent);
        Assert.AreEqual("first", await cache.GetOrComputeAsync(key, version, _ =>
        {
            computations++;

            return Task.FromResult("later");
        }, CancellationToken.None));
        Assert.AreEqual(1, computations);
        Assert.AreEqual("other", await cache.GetOrComputeAsync(new object(), version, _ => Task.FromResult("other"), CancellationToken.None));
    }

    [Fact]
    public async Task AnalysisCache_NewVersionOfAKey_ReplacesTheValue()
    {
        ClassSealingConverter.AsyncCache<object, string> cache = new ClassSealingConverter.AsyncCache<object, string>();
        object key = new object();
        VersionStamp version = VersionStamp.Create();
        VersionStamp newer = version.GetNewerVersion();

        Assert.AreEqual("old", await cache.GetOrComputeAsync(key, version, _ => Task.FromResult("old"), CancellationToken.None));
        Assert.AreEqual("new", await cache.GetOrComputeAsync(key, newer, _ => Task.FromResult("new"), CancellationToken.None));
        Assert.AreEqual("new", await cache.GetOrComputeAsync(key, newer, _ => Task.FromResult("never"), CancellationToken.None));
    }

    [Fact]
    public async Task AnalysisCache_FailedComputation_IsSeenByConcurrentCallersButNotKept()
    {
        ClassSealingConverter.AsyncCache<object, string> cache = new ClassSealingConverter.AsyncCache<object, string>();
        object key = new object();
        VersionStamp version = VersionStamp.Create();
        TaskCompletionSource<string> gate = new TaskCompletionSource<string>();

        Task<string> first = cache.GetOrComputeAsync(key, version, _ => gate.Task, CancellationToken.None);
        Task<string> concurrent = cache.GetOrComputeAsync(key, version, _ => Task.FromResult("concurrent"), CancellationToken.None);
        gate.SetException(new InvalidOperationException("scan failed"));

        Assert.AreEqual("scan failed", (await Assert.ThrowsAsync<InvalidOperationException>(() => first)).Message);
        Assert.AreEqual("scan failed", (await Assert.ThrowsAsync<InvalidOperationException>(() => concurrent)).Message);
        Assert.AreEqual("recomputed", await cache.GetOrComputeAsync(key, version, _ => Task.FromResult("recomputed"), CancellationToken.None));
    }

    [Fact]
    public async Task AnalysisCache_ComputationCanceledByItsCaller_IsComputedAgainByAConcurrentCallerWithALiveToken()
    {
        ClassSealingConverter.AsyncCache<object, string> cache = new ClassSealingConverter.AsyncCache<object, string>();
        object key = new object();
        VersionStamp version = VersionStamp.Create();
        using CancellationTokenSource cancellation = new CancellationTokenSource();
        int waiterComputations = 0;

        Task<string> canceled = cache.GetOrComputeAsync(key, version, async token =>
        {
            await Task.Delay(Timeout.Infinite, token);

            return "never";
        }, cancellation.Token);
        Task<string> waiter = cache.GetOrComputeAsync(key, version, _ =>
        {
            waiterComputations++;

            return Task.FromResult("waiter");
        }, CancellationToken.None);
        cancellation.Cancel();

        await Assert.ThrowsAsync<OperationCanceledException>(() => canceled);
        Assert.AreEqual("waiter", await waiter);
        Assert.AreEqual(1, waiterComputations);
        Assert.AreEqual("waiter", await cache.GetOrComputeAsync(key, version, _ => Task.FromResult("later"), CancellationToken.None));
    }

    [Fact]
    public async Task AnalysisCache_ComputationCanceledByItsCaller_IsNotKept_AndCancelsAConcurrentCallerThatIsCanceledToo()
    {
        ClassSealingConverter.AsyncCache<object, string> cache = new ClassSealingConverter.AsyncCache<object, string>();
        object key = new object();
        VersionStamp version = VersionStamp.Create();
        using CancellationTokenSource computingCancellation = new CancellationTokenSource();
        using CancellationTokenSource waitingCancellation = new CancellationTokenSource();

        Task<string> canceled = cache.GetOrComputeAsync(key, version, async token =>
        {
            await Task.Delay(Timeout.Infinite, token);

            return "never";
        }, computingCancellation.Token);
        Task<string> waiter = cache.GetOrComputeAsync(key, version, _ => Task.FromResult("waiter"), waitingCancellation.Token);
        waitingCancellation.Cancel();
        computingCancellation.Cancel();

        await Assert.ThrowsAsync<OperationCanceledException>(() => canceled);
        await Assert.ThrowsAsync<OperationCanceledException>(() => waiter);
        Assert.AreEqual("again", await cache.GetOrComputeAsync(key, version, _ => Task.FromResult("again"), CancellationToken.None));
    }

    [Fact]
    public async Task ClassConvertedToAnInterfaceInAnotherProject_StaysUnsealed()
    {
        string input = "namespace Demo { public class Foo { } public interface IBar { } }";
        Document consumerDocument = CompilingTestProject.CreateDocumentReferencingProject(
            "namespace Consumer { public static class Use { public static object M(Demo.Foo foo) => (Demo.IBar)foo; } }",
            new[] { input });
        Document document = consumerDocument.Project.Solution.Projects
            .Single(project => project.Name == "ReferencedProject")
            .Documents.Single();

        Assert.AreEqual(input, await SealAsync(document));
    }

    [Fact]
    public async Task ClassConvertedToAnInterfaceItImplements_BecomesSealed() => Assert.AreEqual(
            "public interface IBar { } public sealed class Foo : IBar { }",
            await SealAsync(
                "public interface IBar { } public class Foo : IBar { }",
                "public static class Use { public static object M(Foo foo) => (IBar)foo; public static bool N(IBar bar) => bar is Foo foo; }"));

    [Fact]
    public async Task ClassDerivedFromByItsOwnNestedClass_StaysUnsealed()
    {
        string input = "public class Shape { private sealed class Circle : Shape { } }";

        Assert.AreEqual(input, await SealAsync(input));
    }

    [Fact]
    public async Task VirtualMemberOfANestedType_DoesNotPreventSealingTheOuterClass() => Assert.AreEqual(
            "public sealed class Outer { public class Inner { public virtual void M() { } } }",
            await SealAsync("public class Outer { public class Inner { public virtual void M() { } } }"));

    [Theory]
    [InlineData("public class Foo { } ", "public class Foo { }")]
    [InlineData("public class Foo { } ", "public abstract class Foo { }")]
    [InlineData("public class Foo { } ", "public sealed class Foo { }")]
    [InlineData("public class Foo { } ", "public static class Foo { }")]
    public async Task ClassDeclaredTwiceInTheProject_StaysUnsealed(string input, string otherDeclaration) => Assert.AreEqual(input, await SealAsync(input, otherDeclaration));

    [Fact]
    public async Task ExceptionWithProtectedSerializationConstructor_StaysUnsealed()
    {
        string input =
            "using System;\r\n" +
            "using System.Runtime.Serialization;\r\n" +
            "public class ParseException : Exception\r\n" +
            "{\r\n" +
            "    public ParseException(string message) : base(message) { }\r\n" +
            "    protected ParseException(SerializationInfo info, StreamingContext context) : base(info, context) { }\r\n" +
            "}\r\n";

        Assert.AreEqual(input, await SealAsync(input));
    }

    [Fact]
    public async Task ClassImplementingAnInterfaceWithADefaultMember_BecomesSealed() => Assert.AreEqual(
            "public interface IGreeter { string Name { get; } string Greet() => \"Hi \" + Name; } public sealed class Greeter : IGreeter { public string Name => \"x\"; }",
            await SealAsync("public interface IGreeter { string Name { get; } string Greet() => \"Hi \" + Name; } public class Greeter : IGreeter { public string Name => \"x\"; }"));

    [Fact]
    public async Task ClassWithOnlyStaticMembersAndSealedOverrides_BecomesSealed() => Assert.AreEqual(
            "public sealed class Tools { public static int Count; public static void Run() { } public sealed override string ToString() => \"t\"; }",
            await SealAsync("public class Tools { public static int Count; public static void Run() { } public sealed override string ToString() => \"t\"; }"));

    [Fact]
    public async Task TopLevelStatementsFile_SealsTheClassesDeclaredAfterTheStatements()
    {
        string input =
            "using System;\r\n" +
            "\r\n" +
            "var greeter = new Greeter();\r\n" +
            "Console.WriteLine(greeter.Greet(Name()));\r\n" +
            "\r\n" +
            "static string Name() => \"world\";\r\n" +
            "\r\n" +
            "class Greeter\r\n" +
            "{\r\n" +
            "    public string Greet(string name) => \"Hello \" + name;\r\n" +
            "}\r\n" +
            "\r\n" +
            "record Person(string Name);\r\n" +
            "\r\n" +
            "abstract class Animal { }\r\n" +
            "\r\n" +
            "class Dog : Animal { }\r\n";
        string expected = input
            .Replace("class Greeter\r\n", "sealed class Greeter\r\n")
            .Replace("record Person(", "sealed record Person(")
            .Replace("class Dog :", "sealed class Dog :");
        Document document = CompilingTestProject.CreateDocument(
            input,
            new CSharpParseOptions(LanguageVersion.Latest),
            new MetadataReference[0]);
        Document executable = document.Project
            .WithCompilationOptions(new CSharpCompilationOptions(OutputKind.ConsoleApplication))
            .GetDocument(document.Id);

        Assert.AreEqual(expected, await SealAsync(executable));
    }

    [Theory]
    [InlineData("\r\n")]
    [InlineData("\n")]
    public async Task DocCommentsAttributesAndIndentation_StayInFrontOfTheSealedModifier(string newLine)
    {
        string input =
            "namespace Demo" + newLine +
            "{" + newLine +
            "\t/// <summary>A value.</summary>" + newLine +
            "\t[System.Serializable]" + newLine +
            "\tclass Value" + newLine +
            "\t{" + newLine +
            "\t}" + newLine +
            newLine +
            "\t// Public one." + newLine +
            "\tpublic /* note */ class Other { }" + newLine +
            newLine +
            "\t#region Records" + newLine +
            "\tinternal record Item(int Id);" + newLine +
            "\t#endregion" + newLine +
            "}" + newLine;
        string expected = input
            .Replace("\tclass Value", "\tsealed class Value")
            .Replace("public /* note */ class Other", "public /* note */ sealed class Other")
            .Replace("internal record Item", "internal sealed record Item");

        Assert.AreEqual(expected, await SealAsync(input));
    }

    [Fact]
    public async Task ClassContainingAnInactivePreprocessorBranch_StaysUnsealed()
    {
        string input =
            "public class Widget\r\n" +
            "{\r\n" +
            "#if LEGACY\r\n" +
            "    public void Trace() { }\r\n" +
            "#endif\r\n" +
            "}\r\n";

        Assert.AreEqual(input, await SealAsync(input));
    }

    [Fact]
    public async Task ClassWithAModifierInAnInactivePreprocessorBranchBeforeIt_StaysUnsealed()
    {
        // In a LEGACY build the class is abstract: 'abstract sealed' would not compile.
        string input = "#if LEGACY\r\nabstract\r\n#endif\r\nclass Foo { }\r\n";

        Assert.AreEqual(input, await SealAsync(input));
    }

    [Fact]
    public async Task ClassNamedInInactiveCodeOfAnotherFile_StaysUnsealed()
    {
        string input = "public class Widget { }";

        Assert.AreEqual(input, await SealAsync(input, "#if LEGACY\r\npublic class OldWidget : Widget { }\r\n#endif\r\n"));
    }

    [Fact]
    public async Task ClassConvertedInInactiveCodeWithoutBeingNamed_StaysUnsealed()
    {
        // A TRACE_WIDGETS build casts the field to an interface Widget does not implement: CS0030 once Widget is sealed.
        string input = "public class Widget { }";

        Assert.AreEqual(
            input,
            await SealAsync(
                input,
                "public interface ITraceable { }\r\n" +
                "public static class Diagnostics\r\n" +
                "{\r\n" +
                "    public static Widget Current = new Widget();\r\n" +
                "#if TRACE_WIDGETS\r\n" +
                "    public static object Trace() => (ITraceable)Current;\r\n" +
                "#endif\r\n" +
                "}\r\n"));
    }

    [Fact]
    public async Task ClassDerivedInInactiveCodeThroughAnAlias_StaysUnsealed()
    {
        // A LEGACY build derives from Widget through the alias: CS0509 once Widget is sealed.
        string input = "public class Widget { }";

        Assert.AreEqual(input, await SealAsync(input, "using W = Widget;\r\n#if LEGACY\r\npublic class OldWidget : W { }\r\n#endif\r\n"));
    }

    [Fact]
    public async Task ClassUsedInInactiveCodeOfADependentProject_StaysUnsealed()
    {
        string input = "namespace Demo { public interface ITraceable { } public class Widget { } }";
        Document consumer = CompilingTestProject.CreateDocumentReferencingProject(
            "namespace Consumer { public static class Use { public static Demo.Widget Current;\r\n#if TRACE_WIDGETS\r\n public static object Trace() => (Demo.ITraceable)Current;\r\n#endif\r\n} }",
            new[] { input });
        Document document = consumer.Project.Solution.Projects
            .Single(project => project.Name == "ReferencedProject")
            .Documents.Single();

        Assert.AreEqual(input, await SealAsync(document));
    }

    [Fact]
    public async Task InactiveCodeOfAProjectNotReferencingTheClass_DoesNotPreventSealing()
    {
        // Only the project of the class and the projects referencing it can use the class.
        Solution solution = new AdhocWorkspace().CurrentSolution;
        Document target = AddProject(ref solution, "Library", "public class Widget { }");
        AddProject(ref solution, "Unrelated", "#if LEGACY\r\npublic class OldWidget : Widget { }\r\n#endif\r\npublic class Other { }\r\n");

        Assert.AreEqual("public sealed class Widget { }", await SealAsync(solution.GetDocument(target.Id)));
    }

    [Fact]
    public async Task ProtectedMemberInsideAnActivePreprocessorBranch_KeepsTheClassUnsealed()
    {
        string input =
            "public class Widget\r\n" +
            "{\r\n" +
            "#if DEBUG\r\n" +
            "    protected virtual void Trace() { }\r\n" +
            "#endif\r\n" +
            "}\r\n";
        Solution solution = new AdhocWorkspace().CurrentSolution;
        Document release = AddProject(ref solution, "Release", input);
        Project debugProject = solution
            .AddProject("Debug", "Debug", LanguageNames.CSharp)
            .WithParseOptions(new CSharpParseOptions(LanguageVersion.Latest, preprocessorSymbols: new[] { "DEBUG" }))
            .WithCompilationOptions(new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary))
            .AddMetadataReference(MetadataReference.CreateFromFile(typeof(object).Assembly.Location));
        Document debug = debugProject.AddDocument("Target.cs", SourceText.From(input));
        solution = debug.Project.Solution;

        string releaseOnly = await new ClassSealingConverter().SealWhenSafeAsync(new[] { solution.GetDocument(release.Id) }, CancellationToken.None);
        string both = await new ClassSealingConverter().SealWhenSafeAsync(
            new[] { solution.GetDocument(release.Id), solution.GetDocument(debug.Id) },
            CancellationToken.None);

        Assert.AreEqual(input, releaseOnly);
        Assert.AreEqual(input, both);
    }

    /// <summary>
    /// Adds a source generator to the project that emits <paramref name="generatedSource" /> as a source file.
    /// </summary>
    private static Solution AddSourceGenerator(Solution solution, ProjectId projectId, string generatedSource)
        => solution.AddAnalyzerReference(projectId, new GeneratorReference(new FixedSourceGenerator(generatedSource).AsSourceGenerator()));

    /// <summary>
    /// An analyzer reference that only supplies a source generator, standing in for a generator package (which cannot
    /// be loaded from the .NET Framework test assembly: Roslyn rejects analyzer assemblies that reference mscorlib).
    /// </summary>
    private sealed class GeneratorReference : AnalyzerReference
    {
        private readonly ImmutableArray<ISourceGenerator> _generators;

        public GeneratorReference(ISourceGenerator generator)
        {
            _generators = ImmutableArray.Create(generator);
        }

        public override string FullPath => null;

        public override object Id => this;

        public override ImmutableArray<DiagnosticAnalyzer> GetAnalyzers(string language) => ImmutableArray<DiagnosticAnalyzer>.Empty;

        public override ImmutableArray<DiagnosticAnalyzer> GetAnalyzersForAllLanguages() => ImmutableArray<DiagnosticAnalyzer>.Empty;

        public override ImmutableArray<ISourceGenerator> GetGenerators(string language) => _generators;

        public override ImmutableArray<ISourceGenerator> GetGeneratorsForAllLanguages() => _generators;
    }

    /// <summary>
    /// A source generator that adds one file with a fixed source to the compilation.
    /// </summary>
    private sealed class FixedSourceGenerator : IIncrementalGenerator
    {
        private readonly string _source;

        public FixedSourceGenerator(string source)
        {
            _source = source;
        }

        public void Initialize(IncrementalGeneratorInitializationContext context)
            => context.RegisterPostInitializationOutput(output => output.AddSource("Generated.g.cs", SourceText.From(_source, Encoding.UTF8)));
    }

    private static Document AddProject(ref Solution solution, string name, string targetSource, params string[] librarySources)
    {
        Project project = solution
            .AddProject(name, name, LanguageNames.CSharp)
            .WithCompilationOptions(new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary))
            .AddMetadataReference(MetadataReference.CreateFromFile(typeof(object).Assembly.Location));

        for (int index = 0; index < librarySources.Length; index++)
        {
            project = project.AddDocument($"Library{index}.cs", SourceText.From(librarySources[index])).Project;
        }

        Document target = project.AddDocument("Target.cs", SourceText.From(targetSource));
        solution = target.Project.Solution;

        return target;
    }

    /// <summary>
    /// A host that also supports <see cref="LanguageNames.VisualBasic" /> as a language without compilation, standing in
    /// for a project whose code the C# converter cannot analyze (the Visual Basic Roslyn assemblies are not referenced).
    /// </summary>
    private static HostServices NonCSharpLanguageHost { get; } = MefHostServices.Create(
        new ContainerConfiguration()
            .WithAssemblies(MefHostServices.DefaultAssemblies)
            .WithPart<NonCSharpLanguageService>()
            .CreateContainer());

    /// <summary>
    /// Makes <see cref="LanguageNames.VisualBasic" /> a supported language of <see cref="NonCSharpLanguageHost" />.
    /// </summary>
    [ExportLanguageService(typeof(NonCSharpLanguageService), LanguageNames.VisualBasic)]
    public sealed class NonCSharpLanguageService : ILanguageService
    {
    }

    private static Task<string> SealAsync(string input, params string[] librarySources)
        => SealAsync(CompilingTestProject.CreateDocument(input, librarySources));

    /// <summary>
    /// Seals <paramref name="document" /> and, when it changed, asserts that sealing added no compile error and no
    /// CS0628 to those the input already has (the test project references only mscorlib, so for example records lack
    /// <c>IsExternalInit</c> on .NET Framework).
    /// </summary>
    private static async Task<string> SealAsync(Document document)
    {
        string input = (await document.GetTextAsync()).ToString();
        string result = await new ClassSealingConverter().SealWhenSafeAsync(new[] { document }, CancellationToken.None);

        if (result != input)
        {
            List<string> added = await GetProblemsAsync(document, result);
            foreach (string existing in await GetProblemsAsync(document, input))
            {
                added.Remove(existing);
            }

            Assert.IsEmpty(added, string.Join("\r\n", added));
        }

        return result;
    }

    private static async Task<List<string>> GetProblemsAsync(Document document, string text)
    {
        Compilation compilation = await document.WithText(SourceText.From(text)).Project.GetCompilationAsync();

        return compilation.GetDiagnostics()
            .Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error || diagnostic.Id == "CS0628")
            .Select(diagnostic => $"{diagnostic.Id}: {diagnostic.GetMessage(System.Globalization.CultureInfo.InvariantCulture)}")
            .ToList();
    }

}
