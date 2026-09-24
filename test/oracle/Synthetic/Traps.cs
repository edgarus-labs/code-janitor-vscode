using System.Threading;
using System.Threading.Tasks;
using System.Linq.Expressions;

namespace Oracle.Traps
{
    public class Traps
    {
        private readonly object gate = new object();
        private int age;
        private int total;

        // Private, no instance state, but called on another instance: making it static is CS0176.
        private int Twice(int value) => value * 2;

        public int UseOther(Traps other) => other.Twice(3);

        public void Enter()
        {
            Monitor.Enter(gate);
            Monitor.Exit(gate);
        }

        public ref int AgeRef() => ref age;

        public int Age
        {
            get { return age; }
            set { age = value; }
        }

        public Task RunAsync() => Task.Run(() => Work());

        private static Task Work() => Task.CompletedTask;

        public int Natural()
        {
            var square = (int a) => a * a;
            return square(3);
        }

        public int Reassigned(bool flag)
        {
            Func<int, int> f = x => x + 1;
            if (flag)
            {
                f = x => x - 1;
            }

            return f(1);
        }

        public bool IsTrue(bool? flag) => flag == true;

        public Expression<Func<object, bool>> NotStringTree = o => !(o is string);

        public string Shadowed(object o)
        {
            string s = "outer";
            if (o is string)
            {
                return (string)o + s;
            }

            return s;
        }

        public Options Initialize()
        {
            var options = new Options();
            options.Size = 3;
            options.Name = options.Size.ToString();
            return options;
        }

        public void Collide(int Value)
        {
            int value = Value;
            total += value;
        }

        public int Switch(int x)
        {
            const int limit = 3;
            switch (x)
            {
                case limit:
                    return 1;
                default:
                    return 0;
            }
        }

        public int WithDefault(int x = maxItems) => x + total;

        private const int maxItems = 5;
    }

    public class Options
    {
        public int Size { get; set; }
        public string Name { get; set; } = "";
    }
}
