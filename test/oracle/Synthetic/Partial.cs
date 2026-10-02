namespace Oracle.Partials
{
    public partial class Split
    {
        private int state;

        public int State => state;

        partial void OnChanged();

        public void Change()
        {
            state++;
            OnChanged();
        }
    }
}
