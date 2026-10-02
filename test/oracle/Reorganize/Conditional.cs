namespace Oracle.Reorganize
{
    public class Diagnostics
    {
        public void Log(string message) { }

#if DEBUG
        private int _debugCalls;

        public void DebugOnly() { _debugCalls++; }
#endif

        // Explains Mode.
#if TRACE
        public static readonly string Mode = "trace";
#else
        public static readonly string Mode = "notrace";
#endif

#pragma warning disable CS0169
        private int _unused;
#pragma warning restore CS0169

        public int Count => 1;

        public int Inside()
        {
#if DEBUG
            return 1;
#else
            return 2;
#endif
        }

        public static readonly int Flag = 1;
    }
}
