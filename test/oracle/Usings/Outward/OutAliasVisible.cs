namespace Company.App.Aliased
{
    using Timer = Clocks.Timer;

    internal class AliasUser
    {
        private Timer clock = new();
    }
}

namespace Company.App.Other
{
    using System.Threading;

    internal class ThreadingUser
    {
        // System.Threading.Timer here; an alias moved to file level would win over it.
        private Timer timer = new(_ => { });
    }
}
