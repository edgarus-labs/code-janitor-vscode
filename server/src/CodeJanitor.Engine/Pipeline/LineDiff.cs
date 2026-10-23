namespace CodeJanitor.Engine.Pipeline;

/// <summary>
/// One run of changed lines of a line diff: lines <c>[BeforeStart, BeforeEnd)</c> of the text before became lines
/// <c>[AfterStart, AfterEnd)</c> of the text after (0-based; an empty range is a pure insertion or deletion there).
/// </summary>
public readonly record struct LineHunk(int BeforeStart, int BeforeEnd, int AfterStart, int AfterEnd);

/// <summary>A shortest line diff (Myers) over lines split at <c>\n</c>.</summary>
public static class LineDiff
{
    /// <summary>Beyond this many inserted and deleted lines, the texts are treated as one changed region.</summary>
    private const int MaxEdits = 1000;

    /// <summary>The number of separate places where <paramref name="after"/> differs from <paramref name="before"/>.</summary>
    public static int CountChangedRegions(string before, string after) => Hunks(before, after).Count;

    /// <summary>Splits a text into lines on <c>\n</c> (a <c>\r</c> stays on its line).</summary>
    public static string[] SplitLines(string text) => text.Split('\n');

    /// <summary>The runs of changed lines of a shortest line diff of the two texts, in order.</summary>
    public static IReadOnlyList<LineHunk> Hunks(string before, string after)
    {
        if (string.Equals(before, after, StringComparison.Ordinal))
        {
            return [];
        }

        var a = SplitLines(before);
        var b = SplitLines(after);
        var start = 0;
        while (start < a.Length && start < b.Length && a[start] == b[start])
        {
            start++;
        }

        var endA = a.Length;
        var endB = b.Length;
        while (endA > start && endB > start && a[endA - 1] == b[endB - 1])
        {
            endA--;
            endB--;
        }

        var whole = new LineHunk(start, endA, start, endB);
        var x = a[start..endA];
        var y = b[start..endB];
        if (x.Length == 0 || y.Length == 0)
        {
            return [whole];
        }

        var max = Math.Min(x.Length + y.Length, MaxEdits);
        var offset = max + 1;
        var v = new int[(2 * max) + 3];
        var trace = new List<int[]>();

        for (var d = 0; d <= max; d++)
        {
            trace.Add((int[])v.Clone());
            for (var k = -d; k <= d; k += 2)
            {
                var px = k == -d || (k != d && v[k - 1 + offset] < v[k + 1 + offset]) ? v[k + 1 + offset] : v[k - 1 + offset] + 1;
                var py = px - k;
                while (px < x.Length && py < y.Length && x[px] == y[py])
                {
                    px++;
                    py++;
                }

                v[k + offset] = px;
                if (px >= x.Length && py >= y.Length)
                {
                    return HunksOf(MatchedLines(trace, offset, x.Length, y.Length), x.Length, y.Length, start);
                }
            }
        }

        return [whole];
    }

    /// <summary><paramref name="before"/> with only the chosen hunks of its diff to <paramref name="after"/> applied.</summary>
    public static string ApplyHunks(string before, string after, IEnumerable<LineHunk> hunks)
    {
        var a = SplitLines(before);
        var b = SplitLines(after);
        var lines = new List<string>();
        var next = 0;
        foreach (var hunk in hunks)
        {
            lines.AddRange(a[next..hunk.BeforeStart]);
            lines.AddRange(b[hunk.AfterStart..hunk.AfterEnd]);
            next = hunk.BeforeEnd;
        }

        lines.AddRange(a[next..]);

        return string.Join('\n', lines);
    }

    private static List<(int X, int Y)> MatchedLines(List<int[]> trace, int offset, int n, int m)
    {
        var matched = new List<(int X, int Y)>();
        var px = n;
        var py = m;

        for (var d = trace.Count - 1; d > 0; d--)
        {
            var v = trace[d];
            var k = px - py;
            var previousK = k == -d || (k != d && v[k - 1 + offset] < v[k + 1 + offset]) ? k + 1 : k - 1;
            var previousX = v[previousK + offset];
            var previousY = previousX - previousK;
            var editEndX = previousX + (previousK == k - 1 ? 1 : 0);
            while (px > editEndX)
            {
                px--;
                py--;
                matched.Add((px, py));
            }

            px = previousX;
            py = previousY;
        }

        while (px > 0 && py > 0)
        {
            px--;
            py--;
            matched.Add((px, py));
        }

        matched.Reverse();

        return matched;
    }

    private static List<LineHunk> HunksOf(List<(int X, int Y)> matched, int n, int m, int shift)
    {
        var hunks = new List<LineHunk>();
        var lastX = -1;
        var lastY = -1;
        matched.Add((n, m));
        foreach (var (mx, my) in matched)
        {
            if (mx > lastX + 1 || my > lastY + 1)
            {
                hunks.Add(new LineHunk(lastX + 1 + shift, mx + shift, lastY + 1 + shift, my + shift));
            }

            lastX = mx;
            lastY = my;
        }

        return hunks;
    }
}
