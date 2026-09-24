using System.Linq;
using System.Linq.Expressions;

namespace Oracle.Lambdas
{
    public class LambdaHost
    {
        private readonly int offset = 3;

        public int Capture(int x)
        {
            int local = x * 2;
            int AddLocal(int y) => y + local;
            int Pure(int y) => y + 1;
            return AddLocal(x) + Pure(x) + offset;
        }

        public Func<int, int> MakeAdder(int n) => x => x + n;

        public Func<string?, bool> IsNull = s => s == null;

        public Expression<Func<string?, bool>> IsNullTree = s => s == null;

        public Expression<Func<List<int>, int>> CountTree = l => l.Count();

        public IEnumerable<int> Map(IEnumerable<int> xs) => xs.Select(x => Increment(x));

        private static int Increment(int x) => x + 1;

        public Action Anonymous() => delegate { Console.WriteLine(offset); };

        public int Discard()
        {
            Func<int, int> f = (int a) => a * a;
            return f(3);
        }

        public void Block(List<int> values)
        {
            values.ForEach(v =>
            {
                Console.WriteLine(v);
            });
        }
    }
}
