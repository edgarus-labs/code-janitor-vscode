using System.Collections.Generic;

namespace Oracle.Reorganize
{
    public partial class Invoice
    {
        partial void OnCreated();

        public decimal Total() => Amount + Tax;

        public Invoice() { OnCreated(); }

        public decimal Amount { get; set; } = 10m;

        private readonly List<string> _notes = new List<string>();

        public int NoteCount => _notes.Count;
    }
}
