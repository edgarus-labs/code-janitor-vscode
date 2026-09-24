namespace Oracle.Nesting
{
    public class Outer
    {
        private int secret = 42;

        private class Inner
        {
            public int Read(Outer outer) => outer.secret;
        }

        protected class ProtectedInner
        {
        }

        protected class DerivedInner : ProtectedInner
        {
        }

        public int Reveal() => new Inner().Read(this);

        public enum Mode
        {
            First,
            Second,
        }
    }
}
