using System;
using System.Collections.Generic;

namespace CodeStyleFixtures.ModernExpressions;

public class Dependency
{
}

public class Service
{
    private readonly Dependency _dependency;

    public Service(Dependency dependency)
    {
        _dependency = dependency;
    }

    public Dependency Get()
    {
        return _dependency;
    }
}

public class Person
{
    public string Name { get; set; } = "";

    public int Age { get; set; }
}

public class ModernSamples
{
    private readonly Dependency _other = new Dependency();
    private int _count;

    private int _age;

    public int Count
    {
        get { return _count; }
    }

    public int Age
    {
        get { return _age; }
        set { _age = value; }
    }

    public int Last(int[] values)
    {
        return values[values.Length - 1];
    }

    public string Tail(string text)
    {
        return text.Substring(1);
    }

    public void Swap(ref int a, ref int b)
    {
        var temp = a;
        a = b;
        b = temp;
    }

    public (int, string) Pair()
    {
        return (1, "a");
    }

    public int Deconstruct()
    {
        var point = (x: 1, y: 2);

        return point.x + point.y;
    }

    public int Defaults()
    {
        return default(int);
    }

    public void Grow(int step)
    {
        _count = _count + step;
    }

    public bool Simplify(bool flag, bool other)
    {
        return flag ? true : (other ? flag : false);
    }

    public string Format(int value)
    {
        return $"{value.ToString()} items";
    }

    public Person Initialize()
    {
        var person = new Person();
        person.Name = "Ann";
        person.Age = 30;

        return person;
    }

    public List<int> Collect()
    {
        var list = new List<int>();
        list.Add(1);
        list.Add(2);

        return list;
    }

    public int ExplicitNames()
    {
        (int Left, int Right) tuple = (1, 2);

        return tuple.Item1 + tuple.Right;
    }

    public object Inferred(int left, int right)
    {
        var tuple = (left: left, right: right);
        var anonymous = new { Name = Initialize().Name, Right = right };

        return (tuple, anonymous);
    }

    public byte[] Bytes()
    {
        return new byte[] { 104, 101, 108, 108, 111 };
    }

    public int Unused()
    {
        int result = Compute();
        result = Compute();

        return result;
    }

    private static int Compute()
    {
        return 42;
    }
}
