namespace Oracle.Nulls
{
    public class Nulls
    {
        private string? name;

        public string Name
        {
            get
            {
                if (name == null)
                {
                    throw new InvalidOperationException();
                }

                return name;
            }
        }

        public void SetName(string? value)
        {
            if (value == null)
            {
                throw new ArgumentNullException(nameof(value));
            }

            name = value;
        }

        public int Length(string? s) => s != null ? s.Length : 0;

        public string OrDefault(string? s) => s != null ? s : "";

        public bool IsSet(object? o) => !(o is null);

        public bool Same(object a, object b) => ReferenceEquals(a, null) || object.Equals(a, b);
    }
}
