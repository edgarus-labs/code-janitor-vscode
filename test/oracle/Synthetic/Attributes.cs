namespace Oracle.Metadata
{
    [AttributeUsage(AttributeTargets.Class | AttributeTargets.Method, AllowMultiple = false)]
    public sealed class MarkerAttribute : Attribute
    {
        public MarkerAttribute(string name) { Name = name; }

        public string Name { get; }

        public int Order { get; set; }
    }

    [Flags]
    public enum Permissions
    {
        None = 0,
        Read = 1,
        Write = 2,
        All = Read | Write,
    }

    [Marker("type", Order = 1)]
    public class Annotated
    {
        [Marker(nameof(Run))]
        public void Run() { }

        [Obsolete("use Run")]
        public void Old() => Run();
    }
}
