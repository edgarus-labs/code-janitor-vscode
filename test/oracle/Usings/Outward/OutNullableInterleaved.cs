using System;
#nullable enable
namespace Company.App
{
    using Services;

    internal class OutNullableInterleaved
    {
        private Svc svc = new();
        private Action? action;
    }
}
