namespace Oracle.Reorganize
{
    public partial class Invoice
    {
        public static int Created;

        partial void OnCreated() { Created++; }

        public decimal Tax => Amount / 10;

        private string Describe() => "invoice";

        public void Note(string note) { _notes.Add(note); }
    }
}
