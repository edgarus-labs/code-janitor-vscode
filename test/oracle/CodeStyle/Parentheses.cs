namespace CodeStyleFixtures.Parentheses;

public class ParenthesesSamples
{
    public int Arithmetic(int a, int b, int c)
    {
        return a + b * c;
    }

    public bool Relational(int a, int b, int c)
    {
        return a < b == (b < c);
    }

    public bool Other(bool a, bool b, bool c)
    {
        return a && b || c;
    }

    public int Unnecessary(int a, int b)
    {
        return ((a)) + (b);
    }
}
