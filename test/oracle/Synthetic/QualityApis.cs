using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;

namespace Oracle;

// CA1305/CA1307/CA1310, CA1836, CA1841, CA1854, CA1858, CA1861, CA1862, CA1864, CA1868, CA1869,
// CA2016 and CA2263: every rewrite of these rules must still compile.
public class QualityApis
{
    private readonly Dictionary<string, int> _counts = new();
    private readonly HashSet<string> _seen = new();
    private int _total;

    public int Lookup(string key)
    {
        if (_counts.ContainsKey(key))
        {
            return _counts[key] + _counts[key];
        }

        var value = 1;
        return _counts.ContainsKey("x") ? _counts["x"] + value : 0;
    }

    public int this[string key]
    {
        get => _counts.ContainsKey(key) ? _counts[key] : -1;
        set
        {
            if (_counts.ContainsKey(key))
            {
                _total += _counts[key] + value;
            }
        }
    }

    public bool Has(Dictionary<string, int> map, SortedDictionary<int, string> sorted) =>
        map.Keys.Contains("a") || map.Values.Contains(2) || sorted.Keys.Contains(3);

    public bool Empty(ConcurrentQueue<int> queue, ConcurrentDictionary<string, int> cache, ReadOnlySpan<char> span) =>
        queue.Count == 0 || cache.Count > 0 || span.Length != 0 || queue.Count() == 0;

    public void Add(Dictionary<string, int> map, string key)
    {
        if (!map.ContainsKey(key))
        {
            map.Add(key, 1);
        }

        if (!map.ContainsKey("b")) { map.Add("b", 2); _total++; }

        if (!_seen.Contains(key)) _seen.Add(key);

        if (_seen.Contains(key)) { _seen.Remove(key); _total--; }
    }

    public bool Prefix(string text) =>
        text.IndexOf("ab", StringComparison.Ordinal) == 0 || text.IndexOf('c') != 0 || text.ToUpperInvariant() == "ABC";

    public string[] Split(string text) => text.Trim(new[] { ' ', '-' }).Split(new char[] { ',', ';' });

    public string Serialize(object value)
    {
        var options = new JsonSerializerOptions { WriteIndented = true, Converters = { new JsonStringEnumConverter() } };
        return JsonSerializer.Serialize(value, options) + JsonSerializer.Serialize(value, new JsonSerializerOptions(JsonSerializerDefaults.Web) { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
    }

    public async Task<string> ReadAsync(Stream stream, HttpClient http, SemaphoreSlim gate, StreamReader reader, CancellationToken cancellationToken)
    {
        await gate.WaitAsync();
        await Task.Delay(10);
        await stream.FlushAsync();
        var buffer = new byte[16];
        await stream.ReadAsync(buffer, 0, buffer.Length);
        await stream.CopyToAsync(Stream.Null);
        await http.GetAsync("https://example.com");
        await File.WriteAllTextAsync("a.txt", "x");
        return await reader.ReadLineAsync() ?? await http.GetStringAsync("https://example.com");
    }

    public DayOfWeek Generic(string text) => Marshal.SizeOf(typeof(int)) > 0 ? (DayOfWeek)Enum.Parse(typeof(DayOfWeek), text, true) : DayOfWeek.Monday;

    public T ParseAny<T>(string text) where T : struct => (T)Enum.Parse(typeof(T), text);

    public string Culture(string a, string b, int n) => string.Compare(a, b) + a.IndexOf("x") + n.ToString() + int.Parse(a) + string.Format("{0}", n);
}
