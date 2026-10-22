using CodeJanitor.Engine.Reorganize;
using Xunit;
using static CodeJanitor.Engine.Tests.Reorganize.ReorganizeHarness;

namespace CodeJanitor.Engine.Tests.Reorganize;

public sealed class ReorganizeRegionsTests
{

    private static readonly string Regions = Lines("class C",
      "{",
      "    #region Methods",
      "    public void B() { }",
      "    public void A() { }",
      "    #endregion",
      "",
      "    #region Fields",
      "    private int _b;",
      "    private int _a;",
      "    #endregion",
      "}",
      "");

    // reorganize: members and existing regions
    [Fact]
    public void SortsTheMembersInsideEachRegionAndLeavesTheRegionsWhereTheyAre()
    {
        Assert.Equal(Lines("class C",
            "{",
            "    #region Methods",
            "    public void A() { }",
            "    public void B() { }",
            "    #endregion",
            "",
            "    #region Fields",
            "    private int _a;",
            "    private int _b;",
            "    #endregion",
            "}",
            ""), Run(Regions));
    }

    [Fact]
    public void SortsTheMembersThatAreOutsideOfRegionsAmongThemselves()
    {
        var source = "class C\n{\n    void B() { }\n    #region R\n    int _b;\n    int _a;\n    #endregion\n    int _c;\n}\n";

        Assert.Equal("class C\n{\n    int _c;\n    #region R\n    int _a;\n    int _b;\n    #endregion\n    void B() { }\n}\n", Run(source));
    }

    [Fact]
    public void SortsMembersAcrossRegionsLeavingTheDirectivesInPlaceWhenNotKeepingMembersWithinRegions()
    {
        Assert.Equal(Lines("class C",
            "{",
            "    #region Methods",
            "    private int _a;",
            "    private int _b;",
            "    #endregion",
            "",
            "    #region Fields",
            "    public void A() { }",
            "    public void B() { }",
            "    #endregion",
            "}",
            ""), Run(Regions, new ReorganizeSettings { KeepMembersWithinRegions = false }));
    }

    [Fact]
    public void SortsInsideNestedRegions()
    {
        var source = "class C\n{\n    #region Outer\n    #region Inner\n    void B() { }\n    void A() { }\n    #endregion\n    #endregion\n}\n";

        Assert.Equal("class C\n{\n    #region Outer\n    #region Inner\n    void A() { }\n    void B() { }\n    #endregion\n    #endregion\n}\n", Run(source));
    }

    [Fact]
    public void LeavesAFileWhoseRegionsAreAlreadyInOrderByteForByte()
    {
        var source = "class C\r\n{\r\n\r\n    #region Fields\r\n\r\n    int _a;\r\n\r\n    #endregion Fields\r\n\r\n}\r\n";

        Assert.Equal(source, Run(source));
    }

    // reorganize: removing existing regions
    private static readonly string RemovalSource = Lines("class C",
      "{",
      "    #region Helpers",
      "    void B() { }",
      "    void A() { }",
      "    #endregion",
      "",
      "    #region Fields",
      "    int _b;",
      "    int _a;",
      "    #endregion",
      "}",
      "");

    [Fact]
    public void RemovesTheRegionsWhoseNameIsNotTheNameOfAGroupOfTheirMembersKeepingTheOthers()
    {
        Assert.Equal(Lines("class C", "{", "    void A() { }", "    void B() { }", "", "    #region Fields", "    int _a;", "    int _b;", "    #endregion", "}", ""), Run(RemovalSource, new ReorganizeSettings { RegionsRemoveExistingRegions = true }));
    }

    [Fact]
    public void RemovesTheNestedRegionsOfARemovedRegionToo()
    {
        var nested = "class C\n{\n    #region Outer\n    #region Inner\n    void B() { }\n    void A() { }\n    #endregion\n    #endregion\n}\n";

        Assert.Equal("class C\n{\n    void A() { }\n    void B() { }\n}\n", Run(nested, new ReorganizeSettings { RegionsRemoveExistingRegions = true }));
    }

    [Fact]
    public void KeepsTheRegionsOfEveryStandardNameWhenEmptyRegionsAreKept()
    {
        var empty = "class C\n{\n    #region Constructors\n    #endregion\n    #region Mine\n    #endregion\n}\n";

        Assert.Equal("class C\n{\n    #region Constructors\n    #endregion\n}\n", Run(empty, new ReorganizeSettings { RegionsRemoveExistingRegions = true, RegionsInsertKeepEvenIfEmpty = true }));
    }

    // reorganize: inserting regions
    private const string MembersSource = "class C\n{\n    int _b;\n    void B() { }\n    int _a;\n    void A() { }\n}\n";

    [Fact]
    public void PutsARegionAroundEachGroupOfMembersWithTheEndregionNamedLikeTheRegion()
    {
        Assert.Equal(Lines("class C",
            "{",
            "    #region Fields",
            "    int _a;",
            "    int _b;",
            "    #endregion Fields",
            "    #region Methods",
            "    void A() { }",
            "    void B() { }",
            "    #endregion Methods",
            "}",
            ""), Run(MembersSource, new ReorganizeSettings { RegionsInsertNewRegions = true }, ReorganizeCleanup.WithoutPadding));
    }

    [Fact]
    public void LeavesTheEndregionUnnamedWhenTheCleanupDoesNotNameIt()
    {
        var cleanup = new ReorganizeCleanup(key => key != "updateEndRegionDirectives" && ReorganizeCleanup.WithoutPadding.Flag(key));

        Assert.Contains("    #endregion\n", Run(MembersSource, new ReorganizeSettings { RegionsInsertNewRegions = true }, cleanup));
    }

    [Fact]
    public void PadsTheRegionTagsTheWayTheCleanupPaddingSettingsAsk()
    {
        Assert.Equal(Lines("class C",
            "{",
            "    #region Fields",
            "",
            "    int _a;",
            "    int _b;",
            "",
            "    #endregion Fields",
            "",
            "    #region Methods",
            "",
            "    void A() { }",
            "",
            "    void B() { }",
            "",
            "    #endregion Methods",
            "}",
            ""), Run(MembersSource, new ReorganizeSettings { RegionsInsertNewRegions = true }, ReorganizeCleanup.Default));
    }

    [Fact]
    public void ReplacesTheExistingRegionsWhenInsertingAndRemoving()
    {
        var existing = "class C\n{\n    #region Stuff\n    int _b;\n    void B() { }\n    #endregion\n    int _a;\n}\n";

        Assert.Equal(Lines("class C", "{", "    #region Fields", "    int _a;", "    int _b;", "    #endregion Fields", "    #region Methods", "    void B() { }", "    #endregion Methods", "}", ""), Run(existing, new ReorganizeSettings { RegionsInsertNewRegions = true, RegionsRemoveExistingRegions = true }, ReorganizeCleanup.WithoutPadding));
    }

    [Fact]
    public void KeepsAnExistingRegionOfTheSameNameAndSortsInsideIt()
    {
        var existing = "class C\n{\n    #region Fields\n    int _b;\n    int _a;\n    #endregion\n    void B() { }\n}\n";

        Assert.Equal(Lines("class C", "{", "    #region Fields", "    int _a;", "    int _b;", "    #endregion", "    #region Methods", "    void B() { }", "    #endregion Methods", "}", ""), Run(existing, new ReorganizeSettings { RegionsInsertNewRegions = true }, ReorganizeCleanup.WithoutPadding));
    }

    [Fact]
    public void IncludesTheAccessLevelInTheRegionNames()
    {
        var source = "class C\n{\n    private void B() { }\n    public void A() { }\n    private int _f;\n}\n";

        Assert.Equal(Lines("class C",
            "{",
            "    #region Private Fields",
            "    private int _f;",
            "    #endregion Private Fields",
            "    #region Public Methods",
            "    public void A() { }",
            "    #endregion Public Methods",
            "    #region Private Methods",
            "    private void B() { }",
            "    #endregion Private Methods",
            "}",
            ""), Run(source, new ReorganizeSettings { RegionsInsertNewRegions = true, RegionsIncludeAccessLevel = true }, ReorganizeCleanup.WithoutPadding));
    }

    [Fact]
    public void IncludesTheAccessLevelForMethodsOnly()
    {
        var source = "class C\n{\n    private void B() { }\n    private int _f;\n}\n";
        var result = Run(source, new ReorganizeSettings { RegionsInsertNewRegions = true, RegionsIncludeAccessLevel = true, RegionsIncludeAccessLevelForMethodsOnly = true }, ReorganizeCleanup.WithoutPadding);

        Assert.Contains("#region Fields", result);
        Assert.Contains("#region Private Methods", result);
    }

    [Fact]
    public void InsertsTheRegionsThatAreKeptEvenWhenEmptyInTheOrderOfTheGroups()
    {
        var source = "class C\n{\n    void B() { }\n    int _f;\n}\n";
        var result = Run(source, new ReorganizeSettings { RegionsInsertNewRegions = true, RegionsInsertKeepEvenIfEmpty = true }, ReorganizeCleanup.WithoutPadding);
        var names = System.Text.RegularExpressions.Regex.Matches(result, "#region (.*)").Select(match => match.Groups[1].Value);

        Assert.Equal(new[] { "Fields", "Constructors", "Destructors", "Delegates", "Events", "Enums", "Interfaces", "Properties", "Indexers", "Methods", "Structs", "Classes" }, names);
        Assert.Contains("    #region Constructors\n    #endregion Constructors\n", result);
    }

    [Fact]
    public void InsertsEmptyRegionsIntoATypeWithoutMembers()
    {
        var result = Run("class C\n{\n}\n", new ReorganizeSettings { RegionsInsertNewRegions = true, RegionsInsertKeepEvenIfEmpty = true }, ReorganizeCleanup.WithoutPadding);

        Assert.StartsWith("class C\n{\n    #region Fields\n    #endregion Fields\n    #region Constructors\n", result);
        Assert.EndsWith("    #endregion Classes\n}\n", result);
    }

    [Fact]
    public void NamesTheRegionsOfAConfiguredGroupAfterTheFirstMemberTypeOfTheGroup()
    {
        var memberTypes = ReorganizeSettings.DefaultMemberTypes();
        memberTypes[MemberTypeKey.Properties] = new MemberTypeSetting(1, "Data");
        memberTypes[MemberTypeKey.Fields] = new MemberTypeSetting(1, "Data");
        var source = "class C\n{\n    int P { get; set; }\n    int _f;\n}\n";

        Assert.Contains("#region Data", Run(source, new ReorganizeSettings { MemberTypes = memberTypes, RegionsInsertNewRegions = true }, ReorganizeCleanup.WithoutPadding));
    }

    [Fact]
    public void DoesNotInsertRegionsAroundTheTypesOfANamespace()
    {
        var source = "namespace N\n{\n    class B { }\n    struct S { }\n}\n";

        Assert.DoesNotContain("#region", Run(source, new ReorganizeSettings { RegionsInsertNewRegions = true }));
    }

    [Fact]
    public void InsertsRegionsInStructsAndInterfacesAndKeepsTheLineEndings()
    {
        var source = "interface I\r\n{\r\n    void B();\r\n    int P { get; }\r\n}\r\n";
        var result = Run(source, new ReorganizeSettings { RegionsInsertNewRegions = true }, ReorganizeCleanup.WithoutPadding);

        Assert.Equal("interface I\r\n{\r\n    #region Properties\r\n    int P { get; }\r\n    #endregion Properties\r\n    #region Methods\r\n    void B();\r\n    #endregion Methods\r\n}\r\n", result);
    }

    [Fact]
    public void InsertsOneRegionForAGroupWhoseMembersTheLayoutOfAStructKeepsApart()
    {
        // Z, Y (an auto-property, so a field of the layout) and A keep their order: the Fields region holds all three
        // rather than a second Fields region after the property.
        var source = "struct S\n{\n    public void M() { }\n    public int Z;\n    public int Y { get; set; }\n    public int A;\n}\n";

        Assert.Equal(
            "struct S\n{\n    #region Fields\n    public int Z;\n    public int Y { get; set; }\n    public int A;\n    #endregion Fields\n    #region Methods\n    public void M() { }\n    #endregion Methods\n}\n",
            Run(source, new ReorganizeSettings { RegionsInsertNewRegions = true }, ReorganizeCleanup.WithoutPadding));
    }
}

