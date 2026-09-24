using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Threading.Tasks;

namespace Oracle.ReviewFindings
{
    public class AccessorLambdas
    {
        private int stored;

        // IDE0320: `value` is the setter's parameter; a static lambda cannot capture it (CS8820).
        public int Value
        {
            get => stored;
            set
            {
                Invoke(() => Console.WriteLine(value));
                stored = value;
            }
        }

        private static void Invoke(Action action) => action();

        // IDE0320: already static, block-bodied async lambdas get no second `static`.
        public Func<int, Task> Wait = static async delay => { await Task.Delay(delay); };
    }

    public static class Initializers
    {
        // IDE0059: the local function reads `x` before the assignment (CS0165 without the initializer).
        public static int ReadByLocalFunction()
        {
            int x = 0;
            x = Next();
            return x;

            int Next() => x + 1;
        }

        // IDE0303: Create(items, start, length) copies a range; `[items, 0, 2]` does not compile.
        public static ImmutableArray<int> Range(int[] items) => ImmutableArray.Create(items, 0, 2);

        // IDE0305: `["a"]` would create an object[] instead of the string[] ToArray returns.
        public static object[] Covariant() => new[] { "a" }.ToArray();

        public static List<object> Widened() => new List<string> { "b" }.ToList<object>();
    }
}
