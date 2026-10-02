namespace Oracle.Props
{
    public class Properties
    {
        private int age;

        public int Age
        {
            get { return age; }
            set { age = value; }
        }

        public required string Name { get; init; }

        public string Upper
        {
            get => Name.ToUpperInvariant();
        }

        public int Lazy
        {
            get { return field; }
            set { field = value > 0 ? value : 0; }
        }
    }
}
