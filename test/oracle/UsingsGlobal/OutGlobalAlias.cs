namespace Company.App
{
    using Shorthand = Services.Svc;

    internal class OutGlobalAlias
    {
        // The alias of the namespace wins over the global alias of the same name; at file level they would clash.
        private Shorthand value;
    }
}
