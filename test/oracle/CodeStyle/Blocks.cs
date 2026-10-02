using System;
using System.IO;

namespace CodeStyleFixtures.Blocks;

public class BlockSamples
{
    public int Get(bool open)
    {
        if (open)
            return 1;
        for (var i = 0; i < 3; i++)
            Console.WriteLine(i);
        return 0;
    }

    public int FirstByte(string path)
    {
        using (var stream = File.OpenRead(path))
        {
            return stream.ReadByte();
        }
    }

    public int Apply(int value)
    {
        Func<int, int> convert = v => Double(v);

        return convert(value);
    }

    private static int Double(int value)
    {
        return value * 2;
    }
}
