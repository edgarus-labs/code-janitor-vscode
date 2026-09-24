namespace Oracle.Operators
{
    public readonly struct Meters : IEquatable<Meters>
    {
        private readonly double value;

        public Meters(double value) { this.value = value; }

        public static Meters operator +(Meters a, Meters b) => new Meters(a.value + b.value);

        public static bool operator ==(Meters a, Meters b) => a.value == b.value;

        public static bool operator !=(Meters a, Meters b) => !(a == b);

        public static implicit operator double(Meters m) => m.value;

        public static explicit operator Meters(double d) => new Meters(d);

        public bool Equals(Meters other) => value == other.value;

        public override bool Equals(object? obj) => obj is Meters m && Equals(m);

        public override int GetHashCode() => value.GetHashCode();
    }

    public class Grid
    {
        private readonly int[,] cells = new int[3, 3];

        public int this[int x, int y]
        {
            get { return cells[x, y]; }
            set { cells[x, y] = value; }
        }

        public double Ratio(int a, int b) => (double)a / b;

        public object Boxed(int a) => (object)a;

        public int? Maybe(bool flag) => flag ? (int?)1 : null;

        public long Widen(int a) => (long)a * a;

        public string Pick(object o) => Overload((string)o);

        private static string Overload(string s) => s;

        private static string Overload(object o) => "object";
    }
}
