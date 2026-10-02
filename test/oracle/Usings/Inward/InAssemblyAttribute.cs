using System;
using System.Runtime.CompilerServices;

[assembly: InternalsVisibleTo("Company.App.Tests")]

namespace Company.App
{
    internal class InAssemblyAttribute
    {
        private Action action;
    }
}
