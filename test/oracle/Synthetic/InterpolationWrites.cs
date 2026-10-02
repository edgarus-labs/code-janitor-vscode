using System.Threading;

namespace Oracle
{
    /// <summary>Fields written only inside interpolation holes: they must never become readonly.</summary>
    internal class InterpolationWrites
    {
        private int _counter;
        private int _stepped;
        private int _assigned;
        private int _parsed;
        private int _read = 5;

        public string Next() => $"id-{Interlocked.Increment(ref _counter)}";

        public string Step() => $"{_stepped++}/{--_stepped}";

        public string Assign() => $"{(_assigned = 3)} {(_assigned += 2)}";

        public string Parse(string text) => $"{int.TryParse(text, out _parsed)}:{_parsed}";

        public string Read() => $"{_read} {_read + 1:D3}";
    }
}
