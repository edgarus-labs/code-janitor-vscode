using System.Threading;

namespace Company.App
{
    using Clocks;

    internal class OutBclCollision
    {
        // Inside the namespace Clocks.Timer wins over System.Threading.Timer; merged they are ambiguous.
        private Timer timer;
    }
}
