using Vendor;

namespace Company.App
{
    // `Helpers` passes over Company.App.Helpers<T> and is found through the file-level `using Vendor;`; next to it
    // inside the namespace it would not be.
    using static Helpers;

    internal class InHiddenGenericArity
    {
        public int Doubled() => Twice(2);
    }
}
