namespace Company.App.One
{
    using System.Text;
    using Services;

    internal class One
    {
        private StringBuilder builder = new();
        private Svc svc = new();
    }
}

namespace Company.App.Two
{
    using System.Text;
    using Shared;

    internal class Two
    {
        private StringBuilder builder = new();
        private Util util = new();
    }
}
