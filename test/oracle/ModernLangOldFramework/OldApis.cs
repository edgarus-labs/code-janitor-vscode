using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;

namespace OldFramework
{
    public class OldApis
    {
        private readonly object gate = new object();

        public string Tail(string s) => s.Substring(1);

        public string Middle(string s) => s.Substring(1, s.Length - 2);

        public char Last(string s) => s[s.Length - 1];

        public int LastItem(int[] items) => items[items.Length - 1];

        public bool HasA(string s) => s.IndexOf("a") >= 0;

        public bool ContainsA(string s) => s.Contains("a");

        public bool StartsWithA(string s) => s.StartsWith("a");

        public bool EndsWithA(string s) => s.EndsWith("a");

        public int IndexOfA(string s) => s.IndexOf("a");

        public string Build()
        {
            var sb = new StringBuilder();
            sb.Append("x");
            return sb.ToString();
        }

        public int Count(List<int> items) => items.Count();

        public bool Any(List<int> items) => items.Any();

        public int[] Empty() => new int[0];

        public void Locked(Action action)
        {
            lock (gate)
            {
                action();
            }
        }

        public string Named() => nameof(List<int>);

        public byte[] Utf8() => new byte[] { 0x61 };
    }
}
