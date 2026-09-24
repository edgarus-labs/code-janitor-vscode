namespace Oracle.Interfaces
{
    public interface IGreeter
    {
        string Name { get; }

        string Greet() => "Hello " + Name;

        static abstract IGreeter Create();

        private static string Prefix() => ">";

        static string Decorated(IGreeter g) => Prefix() + g.Greet();
    }

    public class Greeter : IGreeter
    {
        public string Name => "greeter";

        public static IGreeter Create() => new Greeter();

        // Implements an interface member implicitly: must not become static.
        public string Greet() => "Hi";
    }

    public interface IClock
    {
        DateTime Now();
    }

    public class FixedClock : IClock, IDisposable
    {
        DateTime IClock.Now() => new DateTime(2000, 1, 1);

        public void Dispose() { }
    }
}
