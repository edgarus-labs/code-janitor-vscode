using System.Globalization;

namespace CodeJanitor.Engine.Reorganize;

/// <summary>The kinds of code item the reorganizer orders (<c>KindCodeItem</c> of the Visual Studio extension).</summary>
public enum MemberKind
{
    Class,
    Constructor,
    Delegate,
    Destructor,
    Enum,
    Event,
    Field,
    Indexer,
    Interface,
    Method,
    Property,
    Struct,
    Namespace,
}

/// <summary>
/// Access levels in the Visual Studio <c>vsCMAccess</c> order. <c>private protected</c> has no entry in Visual Studio;
/// here it sits between protected and private.
/// </summary>
public enum AccessLevel
{
    Public,
    Internal,
    ProtectedInternal,
    Protected,
    PrivateProtected,
    Private,
}

/// <summary>What the comparer needs to know about one code item.</summary>
public sealed record SortableMember(
    MemberKind Kind,
    string Name,
    AccessLevel Access,
    bool IsStatic,
    bool IsConstant,
    bool IsReadOnly,
    bool IsExplicitInterface,
    int Offset);

/// <summary>
/// <c>CodeItemTypeComparer</c>: the order of two code items. Type and access level (whichever is primary) are compared
/// term by term rather than in the Visual Studio weighted key, where a member type order of 10 or more outweighs one
/// access step when the access level is primary.
/// </summary>
public sealed class MemberComparer : IComparer<SortableMember>
{
    private static readonly StringComparer NameComparer = StringComparer.Create(CultureInfo.GetCultureInfo("en-US"), ignoreCase: false);

    private readonly ReorganizeSettings _settings;

    public MemberComparer(ReorganizeSettings settings)
    {
        _settings = settings;
    }

    /// <summary>The member type setting a kind is ordered by; null for a namespace, which sorts before every member type.</summary>
    public static MemberTypeKey? MemberTypeOf(MemberKind kind) => kind switch
    {
        MemberKind.Class => MemberTypeKey.Classes,
        MemberKind.Constructor => MemberTypeKey.Constructors,
        MemberKind.Delegate => MemberTypeKey.Delegates,
        MemberKind.Destructor => MemberTypeKey.Destructors,
        MemberKind.Enum => MemberTypeKey.Enums,
        MemberKind.Event => MemberTypeKey.Events,
        MemberKind.Field => MemberTypeKey.Fields,
        MemberKind.Indexer => MemberTypeKey.Indexers,
        MemberKind.Interface => MemberTypeKey.Interfaces,
        MemberKind.Method => MemberTypeKey.Methods,
        MemberKind.Property => MemberTypeKey.Properties,
        MemberKind.Struct => MemberTypeKey.Structs,
        _ => null,
    };

    public int Compare(SortableMember? x, SortableMember? y)
    {
        if (x is null || y is null)
        {
            return x is null ? (y is null ? 0 : -1) : 1;
        }

        var (primaryX, secondaryX) = Keys(x);
        var (primaryY, secondaryY) = Keys(y);
        var difference = primaryX.CompareTo(primaryY);
        if (difference == 0)
        {
            difference = secondaryX.CompareTo(secondaryY);
        }

        if (difference == 0)
        {
            difference = MinorWeight(x).CompareTo(MinorWeight(y));
        }

        if (difference != 0)
        {
            return difference;
        }

        if (_settings.AlphabetizeMembersOfTheSameGroup)
        {
            var byName = NameComparer.Compare(NormalizeName(x), NormalizeName(y));
            if (byName != 0)
            {
                return byName;
            }
        }

        return x.Offset.CompareTo(y.Offset);
    }

    private (int Primary, int Secondary) Keys(SortableMember member)
    {
        var key = MemberTypeOf(member.Kind);
        var typeOrder = key is { } type ? _settings.MemberTypes[type].Order : 0;
        var accessRank = _settings.ReverseOrderByAccessLevel ? (int)AccessLevel.Private - (int)member.Access : (int)member.Access;

        return _settings.PrimaryOrderByAccessLevel ? (accessRank, typeOrder) : (typeOrder, accessRank);
    }

    /// <summary>The Visual Studio weights below type and access level: explicit interface implementation, then constant, static and read-only fields.</summary>
    private int MinorWeight(SortableMember member)
    {
        var explicitOffset = _settings.ExplicitMembersAtEnd && member.IsExplicitInterface ? 1 : 0;
        var constantOffset = member.Kind == MemberKind.Field && !member.IsConstant ? 1 : 0;
        var staticOffset = member.IsStatic ? 0 : 1;
        var readOnlyOffset = member.Kind == MemberKind.Field && !member.IsReadOnly ? 1 : 0;

        return (explicitOffset * 1000) + (constantOffset * 100) + (staticOffset * 10) + readOnlyOffset;
    }

    /// <summary>The member name after the last dot for an explicit interface implementation.</summary>
    private static string NormalizeName(SortableMember member)
    {
        if (member.IsExplicitInterface)
        {
            var dot = member.Name.LastIndexOf('.') + 1;
            if (dot > 0 && dot < member.Name.Length)
            {
                return member.Name[dot..];
            }
        }

        return member.Name;
    }
}
