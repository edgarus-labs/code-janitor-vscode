namespace CodeJanitor.Engine.Reorganize;

/// <summary>
/// Region names the way <c>GenerateRegionLogic</c> composes them. Regions are compared by name
/// (<c>RegionComparerByName</c>): two regions are the same when their names are equal.
/// </summary>
internal sealed class RegionNamer
{
    /// <summary>The access levels of the regions that are kept when empty (<c>GenerateRegionLogic.AccessModifiers</c>).</summary>
    private static readonly AccessLevel[] AllPossibleAccess =
        [AccessLevel.Public, AccessLevel.Internal, AccessLevel.ProtectedInternal, AccessLevel.Protected, AccessLevel.Private];

    private readonly ReorganizeSettings _settings;

    public RegionNamer(ReorganizeSettings settings)
    {
        _settings = settings;
    }

    public static string TitleCase(AccessLevel access) => access switch
    {
        AccessLevel.Public => "Public",
        AccessLevel.Internal => "Internal",
        AccessLevel.ProtectedInternal => "Protected Internal",
        AccessLevel.Protected => "Protected",
        AccessLevel.PrivateProtected => "Private Protected",
        _ => "Private",
    };

    /// <summary>The region a member belongs in, or null when its kind has none (namespaces).</summary>
    public string? NameOf(MemberInfo info)
    {
        if (MemberComparer.MemberTypeOf(info.Kind) is not { } key)
        {
            return null;
        }

        var name = GroupName(key);
        var isMethod = info.Kind is MemberKind.Method or MemberKind.Constructor or MemberKind.Destructor;

        return _settings.RegionsIncludeAccessLevel && (!_settings.RegionsIncludeAccessLevelForMethodsOnly || isMethod)
            ? $"{TitleCase(info.Access)} {name}"
            : name;
    }

    /// <summary>
    /// The names of a set of entries: those of their members, plus those of existing regions that hold a member of that
    /// very name (<c>ComposePresentTypesRegionsList</c>); every possible name when empty regions are kept.
    /// </summary>
    public HashSet<string> ComposedNames(IReadOnlyList<Entry> entries) =>
        _settings.RegionsInsertKeepEvenIfEmpty ? [.. AllPossibleNames()] : PresentNames(entries);

    /// <summary>All names in the order their regions appear in a sorted class.</summary>
    public List<string> AllPossibleNames()
    {
        var groups = Groups();
        var names = new List<string>();
        void Add(string name)
        {
            if (!names.Contains(name))
            {
                names.Add(name);
            }
        }

        string Variant(List<MemberTypeKey> group, AccessLevel access)
        {
            var methodLike = group.Any(key => key is MemberTypeKey.Methods or MemberTypeKey.Constructors or MemberTypeKey.Destructors);
            var name = GroupName(group[0]);

            return _settings.RegionsIncludeAccessLevel && (!_settings.RegionsIncludeAccessLevelForMethodsOnly || methodLike) ? $"{TitleCase(access)} {name}" : name;
        }

        var accessLevels = _settings.ReverseOrderByAccessLevel ? AllPossibleAccess.AsEnumerable().Reverse().ToArray() : AllPossibleAccess;
        if (_settings.PrimaryOrderByAccessLevel)
        {
            foreach (var access in accessLevels)
            {
                foreach (var group in groups)
                {
                    Add(Variant(group, access));
                }
            }
        }
        else
        {
            foreach (var group in groups)
            {
                foreach (var access in accessLevels)
                {
                    Add(Variant(group, access));
                }
            }
        }

        return names;
    }

    private HashSet<string> PresentNames(IReadOnlyList<Entry> entries)
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var entry in entries)
        {
            if (entry is MemberEntry member)
            {
                if (NameOf(member.Info) is { } name)
                {
                    names.Add(name);
                }
            }
            else if (entry is RegionEntry region && PresentNames(region.Children).Contains(region.Name))
            {
                names.Add(region.Name);
            }
        }

        return names;
    }

    /// <summary>The member types that share one order: sorted together and held by one region.</summary>
    private List<List<MemberTypeKey>> Groups() =>
        ReorganizeSettings.AllMemberTypes
            .GroupBy(key => _settings.MemberTypes[key].Order)
            .OrderBy(group => group.Key)
            .Select(group => group.ToList())
            .ToList();

    /// <summary>A group's region is named after the first member type of the group, as in the Visual Studio options dialog.</summary>
    private string GroupName(MemberTypeKey key)
    {
        var order = _settings.MemberTypes[key].Order;
        var first = ReorganizeSettings.AllMemberTypes.FirstOrDefault(candidate => _settings.MemberTypes[candidate].Order == order, key);

        return _settings.MemberTypes[first].Name;
    }
}
