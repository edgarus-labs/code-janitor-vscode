using X = System.Text.StringBuilder;

namespace Company.App
{
    // AliasRival.X, imported here, wins over the file-level alias; side by side, the alias would win.
    using AliasRival;

    internal class OutAliasImport
    {
        public int Only() => new X().Only;
    }
}
