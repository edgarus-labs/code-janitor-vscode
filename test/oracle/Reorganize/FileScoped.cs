namespace Oracle.Reorganize.Scoped;

public class Zed
{
    public void Run() { }
    public int Field = 4;
}

public delegate int Operation(int left, int right);

public record Person(string Name)
{
    public string Greet() => "hi " + Name;
    public int Age { get; init; } = 30;
}

public interface IThing
{
    void Do();
    int Size { get; }
}

public enum Shade { Dark, Light }

public struct Vec
{
    public void Reset() { X = 0; }
    public int X;
}

public record struct Tag(string Text)
{
    public string Upper() => Text.ToUpperInvariant();
    public int Length => Text.Length;
}
