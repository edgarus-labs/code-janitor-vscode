namespace Oracle.NamingTraps
{
    public class NamingTraps
    {
        private int count;
        private int _count;
        private static readonly int s_limit = 2;
        private static readonly int limit = 3;

        public int Sum() => count + _count + s_limit + limit;

        public Func<int, int> Identity() => (int A) => A;

        public T First<T, U>(T a, U b) => a;

        public int Shadow(int Total)
        {
            Func<int, int> add = total => total + 1;
            return add(Total);
        }

        public int Nested()
        {
            int Result = 1;
            void Bump() => Result++;
            Bump();
            return Result;
        }

        public string Interpolated() => $"{count} {nameof(count)}";
    }
}
