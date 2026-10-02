namespace Oracle.Ext
{
    public static class StringExtensions
    {
        public static bool IsBlank(this string? s) => string.IsNullOrWhiteSpace(s);

        public static int Double(this int x) => x * 2;
    }

    public class UsesExtensions
    {
        public bool Check(string s) => s.IsBlank() || 2.Double() > 3;
    }
}
