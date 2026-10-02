using System;

namespace CodeStyleFixtures.PredefinedTypes;

public class TypeSamples
{
    public Int32 Number(String text, Boolean flag)
    {
        Int32 length = text.Length;

        return flag ? length : 0;
    }

    public string Join(string[] parts)
    {
        return String.Join(",", parts) + Int32.MaxValue.ToString();
    }
}
