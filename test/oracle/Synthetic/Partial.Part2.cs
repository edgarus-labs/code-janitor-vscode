namespace Oracle.Partials
{
    public partial class Split
    {
        private int changes;

        partial void OnChanged() => changes += state;

        public int Changes => changes;
    }
}
