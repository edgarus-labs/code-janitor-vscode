using System;

namespace CodeStyleFixtures.ExpressionBodies;

public class Samples
{
    private int _value;

    public Samples() => _value = 1;

    public Samples(int value)
    {
        _value = value;
    }

    public int Method() => _value + 1;

    public int Block()
    {
        return _value + 2;
    }

    public int Property
    {
        get { return _value; }
    }

    public int Indexer(int index) => index;

    public int this[int index]
    {
        get { return _value + index; }
    }

    public int Accessors
    {
        get { return _value; }
        set { _value = value; }
    }

    public int Twice(int value)
    {
        int Local(int x) => x * 2;

        return Local(value);
    }

    public static Samples operator +(Samples left, Samples right)
    {
        return new Samples(left._value + right._value);
    }
}

public struct Vector
{
    public int X;

    public static Vector operator -(Vector left, Vector right) => new Vector { X = left.X - right.X };
}
