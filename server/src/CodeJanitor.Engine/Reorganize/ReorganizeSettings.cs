using System.Text.Json.Nodes;

namespace CodeJanitor.Engine.Reorganize;

/// <summary>The member types the order can be configured for, one per <c>Reorganizing_MemberType*</c> setting of Visual Studio.</summary>
public enum MemberTypeKey
{
    Classes,
    Constructors,
    Delegates,
    Destructors,
    Enums,
    Events,
    Fields,
    Indexers,
    Interfaces,
    Methods,
    Properties,
    Structs,
}

/// <summary>
/// Where a member type goes and what its region is called. Member types sharing an order form one group:
/// they are sorted together and share a region (named after the first of the group).
/// </summary>
public sealed record MemberTypeSetting(int Order, string Name);

/// <summary><c>Reorganizing_PerformWhenPreprocessorConditionals</c>.</summary>
public enum PreprocessorPolicy
{
    Ask,
    Yes,
    No,
}

/// <summary>The <c>reorganize</c> settings object, with the defaults of the Visual Studio extension.</summary>
public sealed record ReorganizeSettings
{
    /// <summary>The member types in declaration order of <see cref="MemberTypeKey"/>.</summary>
    public static readonly IReadOnlyList<MemberTypeKey> AllMemberTypes = Enum.GetValues<MemberTypeKey>();

    private static readonly IReadOnlyDictionary<MemberTypeKey, int> DefaultOrder = new Dictionary<MemberTypeKey, int>
    {
        [MemberTypeKey.Fields] = 1,
        [MemberTypeKey.Constructors] = 2,
        [MemberTypeKey.Destructors] = 3,
        [MemberTypeKey.Delegates] = 4,
        [MemberTypeKey.Events] = 5,
        [MemberTypeKey.Enums] = 6,
        [MemberTypeKey.Interfaces] = 7,
        [MemberTypeKey.Properties] = 8,
        [MemberTypeKey.Indexers] = 9,
        [MemberTypeKey.Methods] = 10,
        [MemberTypeKey.Structs] = 11,
        [MemberTypeKey.Classes] = 12,
    };

    public bool AlphabetizeMembersOfTheSameGroup { get; init; } = true;

    public bool ExplicitMembersAtEnd { get; init; }

    public bool KeepMembersWithinRegions { get; init; } = true;

    public PreprocessorPolicy PerformWhenPreprocessorConditionals { get; init; } = PreprocessorPolicy.Ask;

    public bool PrimaryOrderByAccessLevel { get; init; }

    public bool ReverseOrderByAccessLevel { get; init; }

    public bool RunAtStartOfCleanup { get; init; }

    public bool RegionsIncludeAccessLevel { get; init; }

    public bool RegionsIncludeAccessLevelForMethodsOnly { get; init; }

    public bool RegionsInsertKeepEvenIfEmpty { get; init; }

    public bool RegionsInsertNewRegions { get; init; }

    public bool RegionsRemoveExistingRegions { get; init; }

    public IReadOnlyDictionary<MemberTypeKey, MemberTypeSetting> MemberTypes { get; init; } = DefaultMemberTypes();

    /// <summary>The default name of a member type (<c>Fields</c>, <c>Methods</c>, ...).</summary>
    public static string DefaultName(MemberTypeKey key) => key.ToString();

    /// <summary>The camelCase key of a member type in the settings (<c>fields</c>, <c>methods</c>, ...).</summary>
    public static string JsonKey(MemberTypeKey key)
    {
        var name = key.ToString();

        return char.ToLowerInvariant(name[0]) + name[1..];
    }

    public static Dictionary<MemberTypeKey, MemberTypeSetting> DefaultMemberTypes() =>
        AllMemberTypes.ToDictionary(key => key, key => new MemberTypeSetting(DefaultOrder[key], DefaultName(key)));

    /// <summary>
    /// Reads the <c>reorganize</c> settings object. A value of the wrong type falls back to the default. The member types
    /// are read from <c>memberTypes.&lt;type&gt;.{order,name}</c> (the extension's settings object) or from the flat
    /// <c>&lt;type&gt;Order</c> / <c>&lt;type&gt;Name</c> keys of the <c>codeJanitor.reorganize.*</c> VS Code settings.
    /// </summary>
    public static ReorganizeSettings Parse(JsonNode? node)
    {
        if (node is not JsonObject json)
        {
            return new ReorganizeSettings();
        }

        bool Flag(string key, bool fallback) =>
            json[key] is JsonValue value && value.TryGetValue<bool>(out var flag) ? flag : fallback;

        var defaults = new ReorganizeSettings();
        var memberTypes = DefaultMemberTypes();
        var nested = json["memberTypes"] as JsonObject;
        foreach (var key in AllMemberTypes)
        {
            var jsonKey = JsonKey(key);
            var entry = nested?[jsonKey] as JsonObject;
            var order = ReadOrder(entry?["order"]) ?? ReadOrder(json[jsonKey + "Order"]);
            var name = ReadName(entry?["name"]) ?? ReadName(json[jsonKey + "Name"]);
            memberTypes[key] = new MemberTypeSetting(order ?? memberTypes[key].Order, name ?? memberTypes[key].Name);
        }

        return new ReorganizeSettings
        {
            AlphabetizeMembersOfTheSameGroup = Flag("alphabetizeMembersOfTheSameGroup", defaults.AlphabetizeMembersOfTheSameGroup),
            ExplicitMembersAtEnd = Flag("explicitMembersAtEnd", defaults.ExplicitMembersAtEnd),
            KeepMembersWithinRegions = Flag("keepMembersWithinRegions", defaults.KeepMembersWithinRegions),
            PerformWhenPreprocessorConditionals = ParsePolicy(json["performWhenPreprocessorConditionals"]) ?? defaults.PerformWhenPreprocessorConditionals,
            PrimaryOrderByAccessLevel = Flag("primaryOrderByAccessLevel", defaults.PrimaryOrderByAccessLevel),
            ReverseOrderByAccessLevel = Flag("reverseOrderByAccessLevel", defaults.ReverseOrderByAccessLevel),
            RunAtStartOfCleanup = Flag("runAtStartOfCleanup", defaults.RunAtStartOfCleanup),
            RegionsIncludeAccessLevel = Flag("regionsIncludeAccessLevel", defaults.RegionsIncludeAccessLevel),
            RegionsIncludeAccessLevelForMethodsOnly = Flag("regionsIncludeAccessLevelForMethodsOnly", defaults.RegionsIncludeAccessLevelForMethodsOnly),
            RegionsInsertKeepEvenIfEmpty = Flag("regionsInsertKeepEvenIfEmpty", defaults.RegionsInsertKeepEvenIfEmpty),
            RegionsInsertNewRegions = Flag("regionsInsertNewRegions", defaults.RegionsInsertNewRegions),
            RegionsRemoveExistingRegions = Flag("regionsRemoveExistingRegions", defaults.RegionsRemoveExistingRegions),
            MemberTypes = memberTypes,
        };
    }

    /// <summary><c>"ask"</c>, <c>"yes"</c> or <c>"no"</c>; null for anything else.</summary>
    public static PreprocessorPolicy? ParsePolicy(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue<string>(out var text)
            ? text switch
            {
                "ask" => PreprocessorPolicy.Ask,
                "yes" => PreprocessorPolicy.Yes,
                "no" => PreprocessorPolicy.No,
                _ => null,
            }
            : null;

    private static int? ReadOrder(JsonNode? node)
    {
        if (node is not JsonValue value)
        {
            return null;
        }

        if (value.TryGetValue<int>(out var order))
        {
            return order >= 0 ? order : null;
        }

        return value.TryGetValue<double>(out var number) && number >= 0 && number == Math.Floor(number) && number <= int.MaxValue ? (int)number : null;
    }

    private static string? ReadName(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue<string>(out var name) && !string.IsNullOrWhiteSpace(name) ? name.Trim() : null;
}
