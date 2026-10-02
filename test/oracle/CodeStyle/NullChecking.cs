using System;

namespace CodeStyleFixtures.NullChecking;

public class NullSamples
{
    private readonly string _name;
    private Action? _callback;

    public NullSamples(string name)
    {
        if (name == null)
        {
            throw new ArgumentNullException(nameof(name));
        }

        _name = name;
    }

    public string Coalesce(string? value)
    {
        return value != null ? value : "";
    }

    public string Coalesce2(string? value)
    {
        if (value == null)
        {
            return "none";
        }

        return value;
    }

    public string? Upper(string? value)
    {
        return value == null ? null : value.ToUpperInvariant();
    }

    public void Raise()
    {
        if (_callback != null)
        {
            _callback();
        }
    }
}
