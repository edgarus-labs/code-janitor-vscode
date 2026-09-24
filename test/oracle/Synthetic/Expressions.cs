namespace Oracle.Expressions
{
    public class Expressions
    {
        public int Conditional(bool flag)
        {
            int value;
            if (flag)
            {
                value = 1;
            }
            else
            {
                value = 2;
            }

            return value;
        }

        public bool Returns(int x)
        {
            if (x > 0)
            {
                return true;
            }
            else
            {
                return false;
            }
        }

        public int Compound(int x)
        {
            x = x + 1;
            x = x * 2;
            return x;
        }

        public string Coalesce(string? a, string b) => a != null ? a : b;

        public int? Propagate(string? s) => s == null ? null : s.Length;

        public bool Simplify(bool a) => a == true;

        public bool Pattern(object o) => o is int && (int)o > 1;

        public bool Range(int x) => x > 1 && x < 10;

        public bool Not(object o) => !(o is string);

        public int Parens(int a, int b, int c) => a + b * c;
    }
}
