using System;

namespace Company.App
{
    // `Math` is found through the file-level `using System;`; next to it inside the namespace it would not be.
    using static Math;

    internal class InHiddenBinding
    {
        public double Root() => Sqrt(4);
    }
}
