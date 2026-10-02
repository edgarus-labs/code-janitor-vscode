using System;

namespace CodeStyleFixtures.Modifiers;

public class ModifierSamples
{
    static public int Counter;
    readonly private int _seed = 1;

    public int Use(int x)
    {
        int Local(int y)
        {
            return y + 1;
        }

        Func<int, int> twice = y => y * 2;

        return Local(x) + twice(x) + _seed + Counter;
    }
}

public struct ImmutablePoint
{
    public ImmutablePoint(int x, int y)
    {
        X = x;
        Y = y;
    }

    public int X { get; }

    public int Y { get; }

    public int Sum()
    {
        return X + Y;
    }
}

public struct Tally
{
    private int _value;

    public int Current()
    {
        return _value;
    }

    public void Increment()
    {
        _value++;
    }
}
