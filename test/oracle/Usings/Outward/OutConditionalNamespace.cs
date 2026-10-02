namespace Company.App
{
    // Without LEGACY, Archive is the global namespace; Company.App.Archive (Conditional.cs) exists only in builds that define it.
    using Archive;

    internal class OutConditionalNamespace
    {
        private readonly Entry entry = new();

        public string Describe() => entry.GlobalEntry;
    }
}
