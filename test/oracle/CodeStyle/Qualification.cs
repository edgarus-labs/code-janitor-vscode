using System;

namespace CodeStyleFixtures.Qualification;

public class QualificationSamples
{
    private int _count;
    private int Size { get; set; }

    public event EventHandler? Changed;

    public int Total()
    {
        return this._count + this.Size + this.Twice(_count);
    }

    public void Raise()
    {
        this.Changed?.Invoke(this, EventArgs.Empty);
    }

    public int Plain()
    {
        return _count + Size + Twice(Size);
    }

    private int Twice(int value)
    {
        return value * 2;
    }
}
