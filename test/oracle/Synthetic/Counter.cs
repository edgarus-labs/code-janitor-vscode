using System.Diagnostics;

namespace Oracle.Members
{
    internal class Counter
    {
        private int count;
        private static int total;
        private readonly List<int> history = new List<int>();

        public event EventHandler? Changed;

        public int Count => count;

        public static int Total => total;

        public void Increment()
        {
            count++;
            total++;
            history.Add(count);
            if (Changed != null)
            {
                Changed(this, EventArgs.Empty);
            }
        }

        // Uses no instance state, but is called on another instance below: making it static breaks callers.
        public int Twice(int value) => value * 2;

        public int UseOther(Counter other) => other.Twice(3) + this.Twice(1);

        private int Helper(int value) => value + 1;

        public int CallHelper() => this.Helper(2) + Helper(3);

        public Func<int, int> HelperAsDelegate() => this.Helper;

        public void Subscribe(Counter source) => source.Changed += OnChanged;

        private void OnChanged(object? sender, EventArgs e) => Debug.WriteLine(sender);

        public override string ToString() => $"{count}/{total}";

        public virtual int Virtual() => 1;
    }
}
