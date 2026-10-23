using CodeJanitor.Engine.Contracts;

namespace CodeJanitor.Engine.Reorganize;

/// <summary>
/// The cleanup settings reorganizing reads: the blank line padding it applies around members that get new neighbours,
/// and <c>updateEndRegionDirectives</c> for the regions it inserts.
/// </summary>
public sealed class ReorganizeCleanup
{
    /// <summary>The keys and the defaults of the extension's <c>CleanupSettings</c>.</summary>
    public static readonly IReadOnlyDictionary<string, bool> Defaults = new Dictionary<string, bool>
    {
        ["insertBlankLinePaddingBeforeClasses"] = true,
        ["insertBlankLinePaddingAfterClasses"] = true,
        ["insertBlankLinePaddingBeforeDelegates"] = true,
        ["insertBlankLinePaddingAfterDelegates"] = true,
        ["insertBlankLinePaddingBeforeEnumerations"] = true,
        ["insertBlankLinePaddingAfterEnumerations"] = true,
        ["insertBlankLinePaddingBeforeEvents"] = true,
        ["insertBlankLinePaddingAfterEvents"] = true,
        ["insertBlankLinePaddingBeforeFieldsMultiLine"] = true,
        ["insertBlankLinePaddingAfterFieldsMultiLine"] = true,
        ["insertBlankLinePaddingBeforeFieldsSingleLine"] = false,
        ["insertBlankLinePaddingAfterFieldsSingleLine"] = false,
        ["insertBlankLinePaddingBeforeInterfaces"] = true,
        ["insertBlankLinePaddingAfterInterfaces"] = true,
        ["insertBlankLinePaddingBeforeMethods"] = true,
        ["insertBlankLinePaddingAfterMethods"] = true,
        ["insertBlankLinePaddingBeforeNamespaces"] = true,
        ["insertBlankLinePaddingAfterNamespaces"] = true,
        ["insertBlankLinePaddingBeforePropertiesMultiLine"] = true,
        ["insertBlankLinePaddingAfterPropertiesMultiLine"] = true,
        ["insertBlankLinePaddingBeforePropertiesSingleLine"] = false,
        ["insertBlankLinePaddingAfterPropertiesSingleLine"] = false,
        ["insertBlankLinePaddingBeforeStructs"] = true,
        ["insertBlankLinePaddingAfterStructs"] = true,
        ["insertBlankLinePaddingBeforeRegionTags"] = true,
        ["insertBlankLinePaddingAfterRegionTags"] = true,
        ["insertBlankLinePaddingBeforeEndRegionTags"] = true,
        ["insertBlankLinePaddingAfterEndRegionTags"] = true,
        ["updateEndRegionDirectives"] = true,
    };

    private readonly Func<string, bool> _flag;

    public ReorganizeCleanup(Func<string, bool> flag)
    {
        _flag = flag;
    }

    /// <summary>The extension's defaults.</summary>
    public static ReorganizeCleanup Default { get; } = new(key => Defaults[key]);

    /// <summary>The defaults with every blank line padding off: blank lines then come only from the source.</summary>
    public static ReorganizeCleanup WithoutPadding { get; } = new(key => !key.StartsWith("insertBlankLinePadding", StringComparison.Ordinal) && Defaults[key]);

    public static ReorganizeCleanup From(IEffectiveSettings settings) => new(settings.GetBool);

    /// <summary>The value of a boolean cleanup setting.</summary>
    public bool Flag(string key) => _flag(key);

    public bool UpdateEndRegionDirectives => _flag("updateEndRegionDirectives");

    public bool BeforeRegionTags => _flag("insertBlankLinePaddingBeforeRegionTags");

    public bool AfterRegionTags => _flag("insertBlankLinePaddingAfterRegionTags");

    public bool BeforeEndRegionTags => _flag("insertBlankLinePaddingBeforeEndRegionTags");

    public bool AfterEndRegionTags => _flag("insertBlankLinePaddingAfterEndRegionTags");

    /// <summary>The padding before and after a member of the kind.</summary>
    public (bool Before, bool After) PaddingOf(MemberInfo info)
    {
        var name = info.Kind switch
        {
            MemberKind.Class => "Classes",
            MemberKind.Delegate => "Delegates",
            MemberKind.Enum => "Enumerations",
            MemberKind.Event => "Events",
            MemberKind.Field => info.IsMultiLine ? "FieldsMultiLine" : "FieldsSingleLine",
            MemberKind.Interface => "Interfaces",
            MemberKind.Namespace => "Namespaces",
            MemberKind.Constructor or MemberKind.Destructor or MemberKind.Method => "Methods",
            MemberKind.Indexer or MemberKind.Property => info.IsMultiLine ? "PropertiesMultiLine" : "PropertiesSingleLine",
            _ => "Structs",
        };

        return (_flag("insertBlankLinePaddingBefore" + name), _flag("insertBlankLinePaddingAfter" + name));
    }
}
