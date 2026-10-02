using Beta;

namespace Company.App
{
    internal class InGlobalCollision
    {
        // Beta.T and the global using of Alpha both provide T: the name is ambiguous, so this file spells it out.
        private Beta.T value;
    }
}
