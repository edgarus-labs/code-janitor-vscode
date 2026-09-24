namespace Oracle.Directives
{
    public class Conditional
    {
#if DEBUG
        private int debugOnly;
#endif

        #region Members

        public int Value() =>
#if DEBUG
            debugOnly +
#endif
            1;

        #endregion

#pragma warning disable CS0168
        public void Unused()
        {
            int x;
        }
#pragma warning restore CS0168
    }
}
