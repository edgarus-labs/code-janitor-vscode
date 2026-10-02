namespace Company.App
{
    using Services;
    using Shared;
    using System.Text;

    internal class OutRelative
    {
        // `Services` is Company.App.Services here (a global Services exists too): only it has AppOnly.
        private readonly Svc svc = new();
        private readonly Util util = new();
        private readonly StringBuilder builder = new();

        public string Describe() => svc.AppOnly + builder.Length + util;
    }
}
