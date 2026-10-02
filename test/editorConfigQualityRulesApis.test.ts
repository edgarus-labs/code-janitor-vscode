import { describe, expect, it } from 'vitest';
import { resolveEditorConfigProperties } from '../src/cleanup/editorconfig';
import { ProjectInfo } from '../src/cleanup/projectInfo';
import { createEditorConfigCodeStyleConverter } from '../src/cleanup/transformations/editorConfigCodeStyle';

function lines(...text: string[]): string {
  return `${text.join('\n')}\n`;
}

/** A project without files on disk: only its target frameworks matter to these rules. */
function targeting(...targetFrameworks: string[]): ProjectInfo {
  return { directory: '/nonexistent-cj-project', targetFrameworks, languageVersion: 12 };
}

function cleanup(source: string, rules: string, project: ProjectInfo | null = targeting('net8.0')): { output: string; issues: string[] } {
  const props = resolveEditorConfigProperties([{ directory: '/repo', text: `root = true\n[*.cs]\n${rules}\n` }], '/repo/src/Sample.cs');
  const issues: string[] = [];
  const output = createEditorConfigCodeStyleConverter(props, (issue) => issues.push(issue), { project: project ?? undefined }).apply(source);

  return { output, issues };
}

const USINGS = [
  'using System;',
  'using System.Collections.Concurrent;',
  'using System.Collections.Generic;',
  'using System.IO;',
  'using System.Linq;',
  'using System.Runtime.InteropServices;',
  'using System.Text.Json;',
  'using System.Threading;',
  'using System.Threading.Tasks;',
];

/** Wraps statements in a method of a class. */
function method(parameters: string, ...body: string[]): string {
  return lines(...USINGS, 'class C', '{', `    object M(${parameters})`, '    {', ...body.map((line) => `        ${line}`), '    }', '}');
}

/** Asserts `before` becomes `after` while the rule is a warning and stays unchanged (unreported) while it is not enforced. */
function expectRewrite(diagnosticId: string, before: string, after: string, project?: ProjectInfo): void {
  expect(cleanup(before, `dotnet_diagnostic.${diagnosticId}.severity = warning`, project)).toEqual({ output: after, issues: [] });
  for (const rules of ['', `dotnet_diagnostic.${diagnosticId}.severity = none`]) {
    expect(cleanup(before, rules, project)).toEqual({ output: before, issues: [] });
  }
}

function expectReport(diagnosticId: string, source: string, ...patterns: RegExp[]): void {
  const result = cleanup(source, `dotnet_diagnostic.${diagnosticId}.severity = warning`);
  expect(result.output).toBe(source);
  expect(result.issues).toEqual(patterns.map((pattern) => expect.stringMatching(pattern)));
}

describe('CA1854 prefer TryGetValue', () => {
  it('turns a ContainsKey guard and the indexer reads into TryGetValue', () => {
    expectRewrite(
      'CA1854',
      method('Dictionary<string, int> d, string k', 'if (d.ContainsKey(k))', '{', '    Console.WriteLine(d[k] + d[k]);', '}', 'return d.ContainsKey("x") ? d["x"] : 0;'),
      method(
        'Dictionary<string, int> d, string k',
        'if (d.TryGetValue(k, out var value))',
        '{',
        '    Console.WriteLine(value + value);',
        '}',
        'return d.TryGetValue("x", out var value1) ? value1 : 0;'
      )
    );
  });

  it('keeps the guard when the body changes the dictionary or the key, or reads it in a lambda', () => {
    expectReport(
      'CA1854',
      method(
        'Dictionary<string, int> d, string k',
        'if (d.ContainsKey(k)) { d[k] = d[k] + 1; }',
        'if (d.ContainsKey(k)) { k = "y"; Console.WriteLine(d[k]); }',
        'if (d.ContainsKey(k)) { Func<int> f = () => d[k]; }',
        'return null;'
      ),
      /^CA1854 line 14: .*d\[k\]/,
      /^CA1854 line 15: /,
      /^CA1854 line 16: /
    );
  });

  it('reports a guard on a dictionary whose type is unknown and ignores guards without a read', () => {
    expectReport(
      'CA1854',
      lines(...USINGS, 'class C', '{', '    object M(string k)', '    {', '        if (Cache.ContainsKey(k)) return Cache[k];', '        if (_d.ContainsKey(k)) _d.Remove(k);', '        return null;', '    }', '    private readonly Dictionary<string, object> _d = new();', '}'),
      /^CA1854 line 14: .*Cache/
    );
  });

  it('picks an unused name for the value, never the implicit value of a setter', () => {
    expectRewrite(
      'CA1854',
      lines(
        'using System.Collections.Generic;',
        'class C',
        '{',
        '    private readonly Dictionary<string, int> _d = new();',
        '    private int _total;',
        '    public int this[string key]',
        '    {',
        '        set { if (_d.ContainsKey(key)) { _total = _d[key] + value; } }',
        '    }',
        '    int M(string key)',
        '    {',
        '        var value = 1;',
        '        return _d.ContainsKey(key) ? _d[key] + value : 0;',
        '    }',
        '}'
      ),
      lines(
        'using System.Collections.Generic;',
        'class C',
        '{',
        '    private readonly Dictionary<string, int> _d = new();',
        '    private int _total;',
        '    public int this[string key]',
        '    {',
        '        set { if (_d.TryGetValue(key, out var value1)) { _total = value1 + value; } }',
        '    }',
        '    int M(string key)',
        '    {',
        '        var value = 1;',
        '        return _d.TryGetValue(key, out var value1) ? value1 + value : 0;',
        '    }',
        '}'
      )
    );
  });
});

describe('CA1841 prefer ContainsKey and ContainsValue', () => {
  it('calls the dictionary methods instead of Keys.Contains and Values.Contains', () => {
    expectRewrite(
      'CA1841',
      method('Dictionary<string, int> d, SortedDictionary<int, int> s', 'return d.Keys.Contains("a") || d.Values.Contains(1) || s.Keys.Contains(2);'),
      method('Dictionary<string, int> d, SortedDictionary<int, int> s', 'return d.ContainsKey("a") || d.ContainsValue(1) || s.ContainsKey(2);')
    );
  });

  it('reports dictionaries whose Keys or Values collection may compare differently', () => {
    expectReport(
      'CA1841',
      method('IDictionary<string, int> d, ConcurrentDictionary<string, int> c', 'return d.Keys.Contains("a") || c.Keys.Contains("b") || d.Keys.Contains("a", StringComparer.Ordinal);'),
      /^CA1841 line 14: d\.Keys\.Contains\("a"\)/,
      /^CA1841 line 14: c\.Keys\.Contains\("b"\)/
    );
  });
});

describe('CA1836 prefer IsEmpty over Count', () => {
  it('tests IsEmpty on concurrent collections and spans', () => {
    expectRewrite(
      'CA1836',
      method('ConcurrentQueue<int> q, ConcurrentBag<int> b, ReadOnlySpan<char> span', 'return q.Count == 0 || b.Count > 0 || 0 != span.Length || q.Count() == 0;'),
      method('ConcurrentQueue<int> q, ConcurrentBag<int> b, ReadOnlySpan<char> span', 'return q.IsEmpty || !b.IsEmpty || !span.IsEmpty || q.IsEmpty;')
    );
  });
});

describe('CA1864 prefer TryAdd', () => {
  it('replaces a ContainsKey guard around Add with TryAdd', () => {
    expectRewrite(
      'CA1864',
      method('Dictionary<string, int> d, string k', 'if (!d.ContainsKey(k))', '{', '    d.Add(k, 1);', '}', 'if (!d.ContainsKey("x")) { d.Add("x", 2); Console.WriteLine("added"); }', 'return null;'),
      method('Dictionary<string, int> d, string k', 'd.TryAdd(k, 1);', 'if (d.TryAdd("x", 2)) { Console.WriteLine("added"); }', 'return null;')
    );
  });

  it('reports a value computed only when the key is missing and skips frameworks without TryAdd', () => {
    const source = method('Dictionary<string, object> d, string k', 'if (!d.ContainsKey(k)) d.Add(k, new object());', 'return null;');
    expectReport('CA1864', source, /^CA1864 line 14: .*new object\(\)/);
    const old = method('Dictionary<string, int> d, string k', 'if (!d.ContainsKey(k)) d.Add(k, 1);', 'return null;');
    expect(cleanup(old, 'dotnet_diagnostic.CA1864.severity = warning', targeting('net472'))).toEqual({ output: old, issues: [] });
  });
});

describe('CA1868 unnecessary Contains before Add or Remove', () => {
  it('uses the result of Add and Remove', () => {
    expectRewrite(
      'CA1868',
      method('HashSet<string> set, List<int> list, string x', 'if (!set.Contains(x)) set.Add(x);', 'if (set.Contains(x)) { set.Remove(x); Console.WriteLine(x); }', 'if (list.Contains(1)) list.Remove(1);', 'return null;'),
      method('HashSet<string> set, List<int> list, string x', 'set.Add(x);', 'if (set.Remove(x)) { Console.WriteLine(x); }', 'list.Remove(1);', 'return null;')
    );
  });
});

describe('CA1858 use StartsWith instead of IndexOf', () => {
  it('rewrites ordinal comparisons of IndexOf with zero', () => {
    expectRewrite(
      'CA1858',
      method('string s', 'return s.IndexOf("ab", StringComparison.Ordinal) == 0 || s.IndexOf(\'c\') != 0 || 0 == s.IndexOf("d", StringComparison.OrdinalIgnoreCase);'),
      method('string s', 'return s.StartsWith("ab", StringComparison.Ordinal) || !s.StartsWith(\'c\') || s.StartsWith("d", StringComparison.OrdinalIgnoreCase);')
    );
  });

  it('reports culture-sensitive IndexOf, where ignorable characters make StartsWith differ', () => {
    expectReport('CA1858', method('string s', 'return s.IndexOf("ab") == 0;'), /^CA1858 line 14: s\.IndexOf\("ab"\) == 0 /);
  });
});

describe('CA1862 compare strings case-insensitively without changing case', () => {
  it('compares ToUpperInvariant with an upper-case ASCII literal ordinally ignoring case', () => {
    expectRewrite(
      'CA1862',
      method('string s', 'return s.ToUpperInvariant() == "ABC" || "X-1" != s.ToUpperInvariant();'),
      method('string s', 'return string.Equals(s, "ABC", StringComparison.OrdinalIgnoreCase) || !string.Equals(s, "X-1", StringComparison.OrdinalIgnoreCase);')
    );
  });

  it('reports the comparisons StringComparison would not reproduce exactly', () => {
    expectReport(
      'CA1862',
      method('string s, string t', 'return s.ToLower() == t.ToLower() || s.ToLowerInvariant() == "k";'),
      /^CA1862 line 14: s\.ToLower\(\) == t\.ToLower\(\)/,
      /^CA1862 line 14: s\.ToLowerInvariant\(\) == "k"/
    );
  });
});

describe('CA1305 / CA1307 / CA1310 report calls without a culture or comparison', () => {
  it('reports each call and changes nothing', () => {
    const source = method('string s, string t, int n', 'Console.WriteLine(string.Compare(s, t) + s.IndexOf("x") + n.ToString() + int.Parse(s) + string.Format("{0}", n));', 'return s.Equals(t) || s.StartsWith("a");');
    expectReport('CA1310', source, /^CA1310 line 14: string\.Compare\(s, t\)/, /^CA1310 line 14: s\.IndexOf\("x"\)/, /^CA1310 line 15: s\.StartsWith\("a"\)/);
    expectReport('CA1305', source, /^CA1305 line 14: n\.ToString\(\)/, /^CA1305 line 14: int\.Parse\(s\)/, /^CA1305 line 14: string\.Format/);
    expectReport(
      'CA1307',
      source,
      /^CA1307 line 14: string\.Compare\(s, t\)/,
      /^CA1307 line 14: s\.IndexOf\("x"\)/,
      /^CA1307 line 15: s\.Equals\(t\)/,
      /^CA1307 line 15: s\.StartsWith\("a"\)/
    );
  });
});

describe('CA2016 forward the CancellationToken', () => {
  it('passes the token to the BCL methods that take one', () => {
    expectRewrite(
      'CA2016',
      lines(
        ...USINGS,
        'class C',
        '{',
        '    async Task M(Stream stream, HttpClient http, CancellationToken ct)',
        '    {',
        '        await Task.Delay(100);',
        '        await stream.FlushAsync();',
        '        await File.ReadAllTextAsync("a.txt");',
        '        await http.GetAsync("https://example.com");',
        '        Func<Task> later = () => Task.Delay(1);',
        '        await Task.Delay(1, CancellationToken.None);',
        '    }',
        '}'
      ),
      lines(
        ...USINGS,
        'class C',
        '{',
        '    async Task M(Stream stream, HttpClient http, CancellationToken ct)',
        '    {',
        '        await Task.Delay(100, ct);',
        '        await stream.FlushAsync(ct);',
        '        await File.ReadAllTextAsync("a.txt", ct);',
        '        await http.GetAsync("https://example.com", ct);',
        '        Func<Task> later = () => Task.Delay(1);',
        '        await Task.Delay(1, CancellationToken.None);',
        '    }',
        '}'
      )
    );
  });

  it('reports overloads the target framework may lack', () => {
    const source = lines(...USINGS, 'class C', '{', '    async Task M(StreamReader reader, CancellationToken ct)', '    {', '        await reader.ReadLineAsync();', '    }', '}');
    const result = cleanup(source, 'dotnet_diagnostic.CA2016.severity = warning', targeting('netstandard2.0'));
    expect(result.output).toBe(source);
    expect(cleanup(source, 'dotnet_diagnostic.CA2016.severity = warning', null).issues).toEqual([expect.stringMatching(/^CA2016 line 14: reader\.ReadLineAsync\(\)/)]);
  });

  it('appends the token after integer arguments and uses framework-specific overloads', () => {
    const body = (...calls: string[]): string =>
      lines(...USINGS, 'class C', '{', '    async Task M(Stream stream, Stream target, byte[] buffer, CancellationToken ct)', '    {', ...calls.map((call) => `        ${call}`), '    }', '}');
    expectRewrite(
      'CA2016',
      body('await stream.ReadAsync(buffer, 0, buffer.Length);', 'await stream.CopyToAsync(target);', 'await stream.CopyToAsync(target, 81920);', 'await stream.CopyToAsync(target, ct);'),
      body('await stream.ReadAsync(buffer, 0, buffer.Length, ct);', 'await stream.CopyToAsync(target, ct);', 'await stream.CopyToAsync(target, 81920, ct);', 'await stream.CopyToAsync(target, ct);')
    );
    const old = body('await stream.CopyToAsync(target);');
    expect(cleanup(old, 'dotnet_diagnostic.CA2016.severity = warning', targeting('net472'))).toEqual({ output: old, issues: [] });
  });

  it('reports ReadLineAsync whose Task result is not awaited directly, because the token overload returns a ValueTask', () => {
    const body = (...statements: string[]): string =>
      lines(...USINGS, 'class C', '{', '    async Task<string> M(StreamReader reader, CancellationToken ct)', '    {', ...statements.map((statement) => `        ${statement}`), '    }', '}');
    expectRewrite(
      'CA2016',
      body('var a = await reader.ReadLineAsync();', 'return await reader.ReadLineAsync().ConfigureAwait(false);'),
      body('var a = await reader.ReadLineAsync(ct);', 'return await reader.ReadLineAsync(ct).ConfigureAwait(false);')
    );
    const stored = body('var readTask = reader.ReadLineAsync();', 'var done = await Task.WhenAny(readTask, Task.Delay(1000));', 'return done == readTask ? await readTask : null;');
    const result = cleanup(stored, 'dotnet_diagnostic.CA2016.severity = warning');
    expect(result.output).toBe(body('var readTask = reader.ReadLineAsync();', 'var done = await Task.WhenAny(readTask, Task.Delay(1000, ct));', 'return done == readTask ? await readTask : null;'));
    expect(result.issues).toEqual([expect.stringMatching(/^CA2016 line 14: reader\.ReadLineAsync\(\)/)]);
  });
});

describe('CA2263 prefer the generic overload', () => {
  it('uses the generic overloads that return the same value', () => {
    expectRewrite(
      'CA2263',
      method('string s', 'var size = Marshal.SizeOf(typeof(int));', 'return (DayOfWeek)Enum.Parse(typeof(DayOfWeek), s, true);'),
      method('string s', 'var size = Marshal.SizeOf<int>();', 'return Enum.Parse<DayOfWeek>(s, true);')
    );
  });

  it('reports overloads whose generic version returns another type', () => {
    expectReport('CA2263', method('string s', 'return Enum.GetValues(typeof(DayOfWeek));'), /^CA2263 line 14: Enum\.GetValues\(typeof\(DayOfWeek\)\)/);
  });
});

describe('CA1861 constant arrays as arguments', () => {
  it('moves literal arrays passed to string methods into static readonly fields', () => {
    expectRewrite(
      'CA1861',
      lines(...USINGS, 'class C', '{', '    string[] M(string s)', '    {', '        return s.Trim(new[] { \' \', \'-\' }).Split(new char[] { \',\', \';\' });', '    }', '}'),
      lines(
        ...USINGS,
        'class C',
        '{',
        "    private static readonly char[] TrimCharacters = new[] { ' ', '-' };",
        "    private static readonly char[] Separators = new char[] { ',', ';' };",
        '',
        '    string[] M(string s)',
        '    {',
        '        return s.Trim(TrimCharacters).Split(Separators);',
        '    }',
        '}'
      )
    );
  });

  it('names the field after the naming rule for private static readonly fields', () => {
    const rules = [
      'dotnet_diagnostic.CA1861.severity = warning',
      'dotnet_naming_rule.statics.symbols = statics',
      'dotnet_naming_rule.statics.style = s_prefix',
      'dotnet_naming_rule.statics.severity = warning',
      'dotnet_naming_symbols.statics.applicable_kinds = field',
      'dotnet_naming_symbols.statics.applicable_accessibilities = private',
      'dotnet_naming_symbols.statics.required_modifiers = static',
      'dotnet_naming_style.s_prefix.capitalization = camel_case',
      'dotnet_naming_style.s_prefix.required_prefix = s_',
    ].join('\n');
    const result = cleanup(lines('class C', '{', '    string[] M(string s) => s.Split(new[] { "," }, System.StringSplitOptions.None);', '}'), rules);
    expect(result).toEqual({
      output: lines('class C', '{', '    private static readonly string[] s_separators = new[] { "," };', '', '    string[] M(string s) => s.Split(s_separators, System.StringSplitOptions.None);', '}'),
      issues: [],
    });
  });

  it('reports literal arrays passed to methods that may change them', () => {
    expectReport('CA1861', method('', 'return Enumerable.Sum(new[] { 1, 2 });'), /^CA1861 line 14: new\[\] \{ 1, 2 \}/);
  });
});

describe('CA1869 cache JsonSerializerOptions', () => {
  it('moves options built from constants into a static readonly field', () => {
    expectRewrite(
      'CA1869',
      method('object value', 'var options = new JsonSerializerOptions { WriteIndented = true };', 'return JsonSerializer.Serialize(value, options) + JsonSerializer.Serialize(value, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });'),
      lines(
        ...USINGS,
        'class C',
        '{',
        '    private static readonly JsonSerializerOptions JsonOptions = new JsonSerializerOptions { WriteIndented = true };',
        '    private static readonly JsonSerializerOptions JsonOptions1 = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };',
        '',
        '    object M(object value)',
        '    {',
        '        return JsonSerializer.Serialize(value, JsonOptions) + JsonSerializer.Serialize(value, JsonOptions1);',
        '    }',
        '}'
      )
    );
  });

  it('reports options that depend on the call', () => {
    expectReport(
      'CA1869',
      method('object value, bool indent', 'return JsonSerializer.Serialize(value, new JsonSerializerOptions { WriteIndented = indent });'),
      /^CA1869 line 14: new JsonSerializerOptions \{ WriteIndented = indent \}/
    );
  });

  it('caches a target-typed options local', () => {
    expectRewrite(
      'CA1869',
      method('object value', 'JsonSerializerOptions options = new(JsonSerializerDefaults.Web) { WriteIndented = true };', 'return JsonSerializer.Serialize(value, options);'),
      lines(
        ...USINGS,
        'class C',
        '{',
        '    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { WriteIndented = true };',
        '',
        '    object M(object value)',
        '    {',
        '        return JsonSerializer.Serialize(value, JsonOptions);',
        '    }',
        '}'
      )
    );
  });

  it('caches options passed to the generic serializer methods', () => {
    expectRewrite(
      'CA1869',
      method('string json, object o', 'var a = JsonSerializer.Deserialize<int[]>(json, new JsonSerializerOptions { WriteIndented = true });', 'return JsonSerializer.Serialize<object>(o, new JsonSerializerOptions { WriteIndented = true });'),
      lines(
        ...USINGS,
        'class C',
        '{',
        '    private static readonly JsonSerializerOptions JsonOptions = new JsonSerializerOptions { WriteIndented = true };',
        '    private static readonly JsonSerializerOptions JsonOptions1 = new JsonSerializerOptions { WriteIndented = true };',
        '',
        '    object M(string json, object o)',
        '    {',
        '        var a = JsonSerializer.Deserialize<int[]>(json, JsonOptions);',
        '        return JsonSerializer.Serialize<object>(o, JsonOptions1);',
        '    }',
        '}'
      )
    );
  });

  it('separates the fields it adds with the blank line padding gives a multi-line field', () => {
    expectRewrite(
      'CA1869',
      lines(
        ...USINGS,
        'class C',
        '{',
        '    private readonly int _count;',
        '',
        '    object M(string json)',
        '    {',
        '        return JsonSerializer.Deserialize<int[]>(json, new JsonSerializerOptions',
        '        {',
        '            WriteIndented = true',
        '        });',
        '    }',
        '}'
      ),
      lines(
        ...USINGS,
        'class C',
        '{',
        '    private static readonly JsonSerializerOptions JsonOptions = new JsonSerializerOptions',
        '        {',
        '            WriteIndented = true',
        '        };',
        '',
        '    private readonly int _count;',
        '',
        '    object M(string json)',
        '    {',
        '        return JsonSerializer.Deserialize<int[]>(json, JsonOptions);',
        '    }',
        '}'
      )
    );
  });
});
