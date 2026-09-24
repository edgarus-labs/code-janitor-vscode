namespace Oracle.Fields
{
    public class Fields
    {
        private int assignedInCtor;
        private int assignedInLambda;
        private int passedByRef;
        private int unused;
        private int onlyWritten;
        private int assignedInLocalFunction;

        public Fields()
        {
            assignedInCtor = 1;
            Action a = () => assignedInLambda = 2;
            a();
            void Local() => assignedInLocalFunction = 3;
            Local();
        }

        public int Use()
        {
            onlyWritten = 5;
            Interlocked(ref passedByRef);
            return assignedInCtor + assignedInLambda + assignedInLocalFunction;
        }

        private static void Interlocked(ref int value) => value++;

        private void NeverCalled() { }

        private Fields(int ignored) : this() { }

        public static Fields Create() => new Fields(0);
    }

    public class Singleton
    {
        private Singleton() { }

        public static Singleton Instance { get; } = new Singleton();
    }
}
