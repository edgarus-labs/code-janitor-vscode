using System;

namespace Oracle.Reorganize
{
    public class Outer
    {
        public class Inner
        {
            public void Work() { }
            public int Value = 1;

            public class Deep
            {
                public void Go() { }
                private int _depth = 3;
                public int Depth => _depth;
            }
        }

        public delegate int Transform(int value);

        public enum Kind { A, B }

        public struct Pair
        {
            public int Second;
            public int First;
        }

        private Inner? _inner;

        public Inner? Get() => _inner;

        public static Outer Create() => new Outer();

        public Outer() { }

        protected class Hidden { public string Text = "hidden"; }

        internal interface IPlugin { void Run(); }
    }

    public class Sibling
    {
        public int Z() => 1;
        public int A = 1;
    }
}
