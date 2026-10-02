namespace RazorOracle.Services;

public sealed record Item(int Id, string Name, bool Active);

public interface ICounterService
{
    int Next();

    Task<IReadOnlyList<Item>> LoadAsync();
}

public sealed class CounterService : ICounterService
{
    private int _value;

    public int Next() => ++_value;

    public Task<IReadOnlyList<Item>> LoadAsync()
    {
        IReadOnlyList<Item> items = new List<Item> { new(1, "One", true), new(2, "Two", false) };

        return Task.FromResult(items);
    }
}
