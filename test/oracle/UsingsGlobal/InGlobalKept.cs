global using System.Collections.Generic;

using System;
using Company.App.Services;

namespace Company.App
{
    internal class InGlobalKept
    {
        private Action action;
        private Svc svc = new();
        private List<int> numbers = new();
    }
}
