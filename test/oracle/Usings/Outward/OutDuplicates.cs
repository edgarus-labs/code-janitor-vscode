using System;
using System.Text;

namespace Company.App
{
    using System.Text; // needed for StringBuilder
    using Services;

    internal class OutDuplicates
    {
        private StringBuilder builder = new();
        private Svc svc = new();
        private Action action = () => { };
    }
}
