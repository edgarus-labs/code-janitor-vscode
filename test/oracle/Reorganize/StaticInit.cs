using System.Collections.Generic;

namespace Oracle.Reorganize
{
    /// <summary>Static initializers that read each other: the order they are declared in is part of the behaviour.</summary>
    public static class Settings
    {
        public static readonly int Doubled = Factor * 2;
        public static readonly int Factor = 21;
        public static readonly int Quadrupled = Factor * 4;
        public static int First = Sequence.Next();
        public static int Second = Sequence.Next();
        public static int Third = Sequence.Next();
        public static readonly string Label = $"{Factor}/{Quadrupled}";
        public static readonly int[] Table = { Factor, Quadrupled, Doubled };
        public static readonly List<string> Names = new List<string> { "b", "a" };
        public static readonly object Gate = new object();
        public static int Version { get; } = Compute();
        public const int Base = 5;
        public const int Limit = Base * 4;
        public static readonly int Seeded = _seed + Factor;
        private static int _seed = 100;
        public static readonly int SeededAfter = _seed + 1;
        private static int Compute() => Factor + First;
    }

    public static class Sequence
    {
        private static int _current = 100;

        public static int Next() => ++_current;
    }

    /// <summary>The counter is declared after the fields that use it, so they see it at zero.</summary>
    public class Counter
    {
        public static int A = Take();
        public static int B = Take();
        private static int _next = 10;
        public static int C = Take();
        private static int Take() => ++_next;
    }

    /// <summary>Instance initializers run in order too.</summary>
    public class Identified
    {
        private static int _ids;
        public int Id = NextId();
        public int Sibling = NextId();
        public string Tag = "t";
        public int Last = NextId();
        private static int NextId() => ++_ids;
    }

    public struct Vector
    {
        public static readonly Vector Zero = new Vector { X = 0, Y = 0 };
        public static readonly Vector Unit = new Vector { X = Scale, Y = Scale };
        public static readonly int Scale = 1;
        public int Y;
        public int X;
    }

    /// <summary>`Base * 2` runs the user-defined operator, which reads Scale: Doubled must stay after Scale.</summary>
    public struct Meters
    {
        public static readonly int Scale = 10;
        public static readonly Meters Base = default;
        public static readonly int Doubled = Base * 2;
        public int Value;

        public static int operator *(Meters meters, int factor) => (meters.Value + factor) * Scale;
    }
}
