using System.Text;

namespace Oracle.Text
{
    public class Strings
    {
        public string Verbatim = @"C:\temp
    indented line
";

        public string Raw = """
            {
              "a": 1
            }
            """;

        public string Interpolated(int x) => $@"value
    {x}
done";

        public string Format(int a, int b) => string.Format("{0} + {1}", a, b);

        public bool Contains(string s) => s.IndexOf("x") >= 0;

        public bool StartsWithChar(string s) => s.StartsWith("a");

        public string Build()
        {
            var sb = new StringBuilder();
            sb.Append("x");
            sb.Append(",");
            return sb.ToString();
        }

        public string Tail(string s) => s.Substring(1);

        public char Last(string s) => s[s.Length - 1];

        public ReadOnlySpan<byte> Utf8() => new byte[] { 0x61, 0x62 };

        public void Check(string name)
        {
            if (name == null)
            {
                throw new ArgumentNullException("name");
            }
        }
    }
}
