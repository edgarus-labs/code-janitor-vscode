namespace Oracle.Records
{
    public record Person(string FirstName, int Age)
    {
        public string Greeting => $"Hello {FirstName}";
    }

    public record struct Point(int X, int Y)
    {
        public readonly int Sum() => X + Y;
    }

    public readonly record struct Money(decimal Amount, string Currency);

    public class Service(string name, int retries)
    {
        public string Name => name;

        public int Retries { get; } = retries;

        public string Describe() => $"{name}:{retries}";
    }

    public struct Holder(int value)
    {
        public int Value { get; set; } = value;
    }
}
