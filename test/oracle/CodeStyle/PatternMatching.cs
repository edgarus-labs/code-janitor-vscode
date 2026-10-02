using System;

namespace CodeStyleFixtures.PatternMatching;

public class Address
{
    public string? City { get; set; }

    public int Zip { get; set; }
}

public class Customer
{
    public Address? Address { get; set; }

    public string Name { get; set; } = "";
}

public class PatternSamples
{
    public string Cast(object value)
    {
        if (value is string)
        {
            var text = (string)value;

            return text.ToUpperInvariant();
        }

        return "";
    }

    public int AsCheck(object value)
    {
        var text = value as string;
        if (text != null)
        {
            return text.Length;
        }

        return 0;
    }

    public bool InRange(int value)
    {
        return value == 1 || value == 2 || value == 3;
    }

    public bool NotString(object value)
    {
        return !(value is string);
    }

    public bool InZip(Customer customer)
    {
        return customer is { Address: { Zip: 100 } };
    }

    public string Describe(int value)
    {
        switch (value)
        {
            case 1:
                return "one";
            case 2:
                return "two";
            default:
                return "many";
        }
    }
}
