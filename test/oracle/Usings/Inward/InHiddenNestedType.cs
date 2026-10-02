using static Company.App.Models.Holder;

namespace Company.App
{
    // `Inner` is a nested type found through the file-level `using static`; next to it inside the namespace it would not be.
    using Held = Inner;

    internal class InHiddenNestedType
    {
        public Held Value;
    }
}
