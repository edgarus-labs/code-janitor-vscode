using System.IO;
using System.Text.RegularExpressions;
using static System.Math;
using Map = System.Collections.Generic.Dictionary<string, int>;

namespace Oracle.Imports
{
    public class Imports
    {
        public Map Create() => new Map();

        public double Root(double x) => Sqrt(x);

        public bool Matches(string s) => Regex.IsMatch(s, "a+");
    }
}
