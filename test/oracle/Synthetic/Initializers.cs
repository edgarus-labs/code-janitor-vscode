namespace Oracle.Init
{
    public class Options
    {
        public int Size { get; set; }
        public string Name { get; set; } = "";
        public List<string> Tags { get; } = new List<string>();
    }

    public class Initializers
    {
        private readonly Dictionary<string, int> map = new Dictionary<string, int>();

        public Options Make()
        {
            var options = new Options();
            options.Size = 3;
            options.Name = "n";
            return options;
        }

        public List<int> Fill()
        {
            var list = new List<int>();
            list.Add(1);
            list.Add(2);
            return list;
        }

        public int Defaulted(int? value = default(int?)) => value ?? default(int);

        public int Lookup(string key)
        {
            int result;
            if (map.TryGetValue(key, out result))
            {
                return result;
            }

            return -1;
        }

        public Options WithTags() => new Options { Size = 1, Tags = { "a", "b" } };
    }
}
