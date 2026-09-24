namespace Oracle.Structs
{
    public ref struct SpanHolder
    {
        private Span<int> span;

        public SpanHolder(Span<int> span) { this.span = span; }

        public int First() => span[0];

        public void Clear() => span.Clear();
    }

    public struct Mutable
    {
        public int Value;

        public void Bump() { Value++; }
    }

    public struct Immutable
    {
        private readonly int value;

        public Immutable(int value) { this.value = value; }

        public int Get() => value;
    }

    public unsafe struct FixedBuffer
    {
        public fixed byte Data[16];
    }
}
