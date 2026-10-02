namespace Company.App
{
#if DEBUG
    using Services;
#else
    using Shared;
#endif

    internal class OutIf
    {
#if DEBUG
        private Svc svc;
#else
        private Util util;
#endif
    }
}
