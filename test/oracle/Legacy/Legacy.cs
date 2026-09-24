using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;

namespace Legacy
{
    public class Legacy
    {
        private readonly object gate = new object();
        private string name;

        public string Name
        {
            get
            {
                if (name == null)
                {
                    throw new InvalidOperationException();
                }

                return name;
            }
        }

        public string Kind(int value)
        {
            switch (value)
            {
                case 1:
                    return "one";
                default:
                    return "other";
            }
        }

        public bool NotString(object o) => !(o is string);

        public bool InRange(int x) => x > 1 && x < 10;

        public string Tail(string s) => s.Substring(1);

        public char Last(string s) => s[s.Length - 1];

        public bool HasA(string s) => s.IndexOf("a") >= 0;

        public bool StartsWithA(string s) => s.StartsWith("a");

        public string Build()
        {
            var sb = new StringBuilder();
            sb.Append("x");
            return sb.ToString();
        }

        public List<int> Numbers()
        {
            var list = new List<int>();
            list.Add(1);
            return list;
        }

        public int[] Empty() => new int[0];

        public string OrDefault(string s)
        {
            if (s == null)
            {
                s = "";
            }

            return s;
        }

        public void Swap(ref int a, ref int b)
        {
            int tmp = a;
            a = b;
            b = tmp;
        }

        public Dictionary<string, int> Map()
        {
            Dictionary<string, int> map = new Dictionary<string, int>();
            return map;
        }

        public void Locked(Action action)
        {
            lock (gate)
            {
                action();
            }
        }

        public int Count(List<int> items) => items.Count();

        public bool Any(List<int> items) => items.Any();

        public string Named() => nameof(List<int>);

        public void Check(string value)
        {
            if (value == null)
            {
                throw new ArgumentNullException("value");
            }

            name = value;
        }

        public int Local(int x)
        {
            int Add(int y) => y + 1;
            return Add(x);
        }

        public Func<int, int> Lambda() => (int a) => a * 2;

        public int Default() => default(int);
    }
}
