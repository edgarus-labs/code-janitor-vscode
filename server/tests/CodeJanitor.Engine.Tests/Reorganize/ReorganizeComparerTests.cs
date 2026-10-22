using System.Text.Json.Nodes;
using CodeJanitor.Engine.Reorganize;
using Xunit;

namespace CodeJanitor.Engine.Tests.Reorganize;

/// <summary>The order the reorganizer gives members of different kinds and access levels.</summary>
public sealed class ReorganizeComparerTests
{
    private static SortableMember Member(string name, int offset, MemberKind kind = MemberKind.Field, AccessLevel access = AccessLevel.Private, bool isStatic = false, bool isConstant = false, bool isReadOnly = false, bool isExplicitInterface = false) =>
        new(kind, name, access, isStatic, isConstant, isReadOnly, isExplicitInterface, offset);

    private static string[] Sorted(IEnumerable<SortableMember> members, ReorganizeSettings? settings = null)
    {
        var list = members.ToList();
        list.Sort(new MemberComparer(settings ?? new ReorganizeSettings()));

        return list.Select(member => member.Name).ToArray();
    }

    [Fact]
    public void SortsItemsOfTheSameTypeByName()
    {
        Assert.True(new MemberComparer(new ReorganizeSettings()).Compare(Member("a", 2), Member("b", 1)) < 0);
    }

    [Fact]
    public void SortsItemsOfTheSameTypeByOffsetWhenNotAlphabetizing()
    {
        Assert.True(new MemberComparer(new ReorganizeSettings { AlphabetizeMembersOfTheSameGroup = false }).Compare(Member("a", 2), Member("b", 1)) > 0);
    }

    [Fact]
    public void SortsByGroupType()
    {
        Assert.True(new MemberComparer(new ReorganizeSettings()).Compare(Member("z", 2), Member("a", 1, MemberKind.Method)) < 0);
    }

    [Fact]
    public void SortsAnExplicitInterfaceMemberByTheMemberNameAfterTheInterface()
    {
        var z = Member("Interface.Z", 1, MemberKind.Method, isExplicitInterface: true);
        var x = Member("X", 2, MemberKind.Method);

        Assert.True(new MemberComparer(new ReorganizeSettings { ExplicitMembersAtEnd = false }).Compare(x, z) < 0);
    }

    [Fact]
    public void PlacesExplicitInterfaceMembersAtTheEndOfTheirGroup()
    {
        var a = Member("Interface.A", 1, MemberKind.Method, isExplicitInterface: true);
        var b = Member("B", 2, MemberKind.Method);

        Assert.True(new MemberComparer(new ReorganizeSettings { ExplicitMembersAtEnd = true }).Compare(b, a) < 0);
    }

    [Fact]
    public void OrdersAccessLevelsPublicToPrivateByDefaultPrivateToPublicWhenReversed()
    {
        var items = new[]
        {
            Member("a", 1, MemberKind.Method, AccessLevel.Private),
            Member("b", 2, MemberKind.Method, AccessLevel.Public),
            Member("c", 3, MemberKind.Method, AccessLevel.Protected),
            Member("d", 4, MemberKind.Method, AccessLevel.Internal),
            Member("e", 5, MemberKind.Method, AccessLevel.ProtectedInternal),
            Member("f", 6, MemberKind.Method, AccessLevel.PrivateProtected),
        };

        Assert.Equal(["b", "d", "e", "c", "f", "a"], Sorted(items));
        Assert.Equal(["a", "f", "c", "e", "d", "b"], Sorted(items, new ReorganizeSettings { ReverseOrderByAccessLevel = true }));
    }

    [Fact]
    public void OrdersByAccessFirstWhenThePrimaryOrderIsByAccessLevel()
    {
        var items = new[]
        {
            Member("privateMethod", 1, MemberKind.Method, AccessLevel.Private),
            Member("privateField", 2, MemberKind.Field, AccessLevel.Private),
            Member("publicMethod", 3, MemberKind.Method, AccessLevel.Public),
            Member("publicField", 4, MemberKind.Field, AccessLevel.Public),
        };

        Assert.Equal(["publicField", "privateField", "publicMethod", "privateMethod"], Sorted(items));
        Assert.Equal(["publicField", "publicMethod", "privateField", "privateMethod"], Sorted(items, new ReorganizeSettings { PrimaryOrderByAccessLevel = true }));
    }

    [Fact]
    public void OrdersFieldsConstantsStaticReadOnlyStaticInstanceReadOnlyInstance()
    {
        var items = new[]
        {
            Member("instance", 1),
            Member("instanceReadOnly", 2, isReadOnly: true),
            Member("staticField", 3, isStatic: true),
            Member("staticReadOnly", 4, isStatic: true, isReadOnly: true),
            Member("constant", 5, isStatic: true, isConstant: true),
        };

        Assert.Equal(["constant", "staticReadOnly", "staticField", "instanceReadOnly", "instance"], Sorted(items));
    }

    [Fact]
    public void OrdersStaticMembersBeforeInstanceMembersOfTheSameKind()
    {
        Assert.Equal(["b", "a"], Sorted([Member("a", 1, MemberKind.Method), Member("b", 2, MemberKind.Method, isStatic: true)]));
    }

    [Fact]
    public void FollowsAConfiguredMemberTypeOrder()
    {
        var custom = ReorganizeSettings.DefaultMemberTypes();
        custom[MemberTypeKey.Methods] = new MemberTypeSetting(1, "Methods");

        Assert.Equal(["m", "f"], Sorted([Member("f", 1), Member("m", 2, MemberKind.Method)], new ReorganizeSettings { MemberTypes = custom }));
    }

    [Fact]
    public void OrdersEveryMemberOfAMoreVisibleAccessLevelFirstWhenTheAccessLevelIsPrimaryWhateverTheMemberTypeOrder()
    {
        var items = new[]
        {
            Member("internalField", 1, MemberKind.Field, AccessLevel.Internal),
            Member("C", 2, MemberKind.Constructor, AccessLevel.Internal),
            Member("PublicClass", 3, MemberKind.Class, AccessLevel.Public),
            Member("PublicStruct", 4, MemberKind.Struct, AccessLevel.Public),
        };
        var custom = ReorganizeSettings.DefaultMemberTypes();
        custom[MemberTypeKey.Methods] = new MemberTypeSetting(1000, "Methods");
        var largeOrder = new[] { Member("internalField", 1, MemberKind.Field, AccessLevel.Internal), Member("M", 2, MemberKind.Method, AccessLevel.Public) };

        Assert.Equal(["PublicStruct", "PublicClass", "internalField", "C"], Sorted(items, new ReorganizeSettings { PrimaryOrderByAccessLevel = true }));
        Assert.Equal(["M", "internalField"], Sorted(largeOrder, new ReorganizeSettings { PrimaryOrderByAccessLevel = true, MemberTypes = custom }));
    }

    [Fact]
    public void ComparesNamesLikeACultureAwareComparer()
    {
        Assert.Equal(["_c", "a", "b", "B"], Sorted([Member("b", 1), Member("B", 2), Member("a", 3), Member("_c", 4)]));
    }
}

/// <summary>The defaults of the reorganize settings (those of the Visual Studio extension).</summary>
public sealed class ReorganizeSettingsTests
{
    [Fact]
    public void HasTheVisualStudioFlagDefaults()
    {
        var defaults = new ReorganizeSettings();

        Assert.True(defaults.AlphabetizeMembersOfTheSameGroup);
        Assert.False(defaults.ExplicitMembersAtEnd);
        Assert.True(defaults.KeepMembersWithinRegions);
        Assert.Equal(PreprocessorPolicy.Ask, defaults.PerformWhenPreprocessorConditionals);
        Assert.False(defaults.PrimaryOrderByAccessLevel);
        Assert.False(defaults.ReverseOrderByAccessLevel);
        Assert.False(defaults.RunAtStartOfCleanup);
        Assert.False(defaults.RegionsIncludeAccessLevel);
        Assert.False(defaults.RegionsIncludeAccessLevelForMethodsOnly);
        Assert.False(defaults.RegionsInsertKeepEvenIfEmpty);
        Assert.False(defaults.RegionsInsertNewRegions);
        Assert.False(defaults.RegionsRemoveExistingRegions);
    }

    [Fact]
    public void HasTheVisualStudioMemberTypeOrderAndNames()
    {
        var defaults = new ReorganizeSettings();
        var byOrder = ReorganizeSettings.AllMemberTypes.OrderBy(key => defaults.MemberTypes[key].Order).Select(ReorganizeSettings.JsonKey);

        Assert.Equal(["fields", "constructors", "destructors", "delegates", "events", "enums", "interfaces", "properties", "indexers", "methods", "structs", "classes"], byOrder);
        Assert.Equal(new MemberTypeSetting(1, "Fields"), defaults.MemberTypes[MemberTypeKey.Fields]);
        Assert.Equal(new MemberTypeSetting(12, "Classes"), defaults.MemberTypes[MemberTypeKey.Classes]);
    }

    [Fact]
    public void FallsBackToTheDefaultsForMissingOrMalformedValues()
    {
        var parsed = ReorganizeSettings.Parse(JsonNode.Parse("""
            {
              "alphabetizeMembersOfTheSameGroup": "yes",
              "performWhenPreprocessorConditionals": "maybe",
              "fieldsOrder": "x",
              "methodsOrder": 2.5,
              "classesOrder": -1,
              "propertiesName": "   ",
              "structsName": 3,
              "memberTypes": { "enums": { "order": -2, "name": "" } }
            }
            """));
        var defaults = new ReorganizeSettings();

        Assert.Equal(defaults with { MemberTypes = parsed.MemberTypes }, parsed);
        Assert.Equal(defaults.MemberTypes, parsed.MemberTypes);
    }

    [Fact]
    public void ReadsFlagsThePreprocessorPolicyAndTheOrderAndNameOfEachMemberType()
    {
        var parsed = ReorganizeSettings.Parse(JsonNode.Parse("""
            {
              "explicitMembersAtEnd": true,
              "performWhenPreprocessorConditionals": "yes",
              "regionsInsertNewRegions": true,
              "fieldsOrder": 10,
              "fieldsName": " Member Variables ",
              "methodsOrder": 1
            }
            """));

        Assert.True(parsed.ExplicitMembersAtEnd);
        Assert.Equal(PreprocessorPolicy.Yes, parsed.PerformWhenPreprocessorConditionals);
        Assert.True(parsed.RegionsInsertNewRegions);
        Assert.Equal(new MemberTypeSetting(10, "Member Variables"), parsed.MemberTypes[MemberTypeKey.Fields]);
        Assert.Equal(new MemberTypeSetting(1, "Methods"), parsed.MemberTypes[MemberTypeKey.Methods]);
        Assert.Equal(new MemberTypeSetting(12, "Classes"), parsed.MemberTypes[MemberTypeKey.Classes]);
    }

    [Fact]
    public void ReadsTheMemberTypesOfTheExtensionsSettingsObject()
    {
        var parsed = ReorganizeSettings.Parse(JsonNode.Parse("""
            { "memberTypes": { "methods": { "order": 1, "name": "Methods" }, "fields": { "order": 2, "name": "State" } } }
            """));

        Assert.Equal(new MemberTypeSetting(1, "Methods"), parsed.MemberTypes[MemberTypeKey.Methods]);
        Assert.Equal(new MemberTypeSetting(2, "State"), parsed.MemberTypes[MemberTypeKey.Fields]);
        Assert.Equal(new MemberTypeSetting(2, "Constructors"), parsed.MemberTypes[MemberTypeKey.Constructors]);
    }
}
