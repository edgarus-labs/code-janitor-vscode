import { describe, expect, it } from 'vitest';
import { resolveEditorConfigProperties } from '../src/cleanup/editorconfig';
import { ProjectInfo } from '../src/cleanup/projectInfo';
import { createEditorConfigCodeStyleConverter } from '../src/cleanup/transformations/editorConfigCodeStyle';

function lines(...text: string[]): string {
  return `${text.join('\n')}\n`;
}

/** A project without files on disk: only its target frameworks matter to these rules. */
function targeting(...targetFrameworks: string[]): ProjectInfo {
  return { directory: '/nonexistent-cj-project', targetFrameworks };
}

/** `project` null: no project was found for the file. */
function cleanup(source: string, rules: string, project: ProjectInfo | null = targeting('net8.0')): { output: string; issues: string[] } {
  const props = resolveEditorConfigProperties([{ directory: '/repo', text: `root = true\n[*.cs]\n${rules}\n` }], '/repo/src/Sample.cs');
  const issues: string[] = [];
  const output = createEditorConfigCodeStyleConverter(props, (issue) => issues.push(issue), { project: project ?? undefined }).apply(source);

  return { output, issues };
}

/** Wraps statements in a method of a class. */
function method(...body: string[]): string {
  return lines('using System;', 'using System.Collections.Generic;', 'using System.Linq;', 'using System.Text;', 'class C', '{', '    void M(string s, int[] a, List<int> l, IEnumerable<int> e)', '    {', ...body.map((line) => `        ${line}`), '    }', '}');
}

/** Asserts `before` becomes `after` while the rule is a warning and stays unchanged (unreported) while it is not enforced. */
function expectRewrite(diagnosticId: string, before: string, after: string): void {
  expect(cleanup(before, `dotnet_diagnostic.${diagnosticId}.severity = warning`)).toEqual({ output: after, issues: [] });
  for (const rules of ['', `dotnet_diagnostic.${diagnosticId}.severity = none`, `dotnet_diagnostic.${diagnosticId}.severity = silent`]) {
    expect(cleanup(before, rules)).toEqual({ output: before, issues: [] });
  }
}

describe('CA1805 do not initialize unnecessarily', () => {
  it('removes initializers that assign the default value', () => {
    expectRewrite(
      'CA1805',
      lines(
        'class C',
        '{',
        '    private int _count = 0;',
        '    private bool _done = false;',
        '    private string _name = null;',
        '    private double _ratio = 0.0, _other = 1;',
        '    public int Total { get; set; } = default;',
        '    public void Reset() { _count = 1; _done = true; _name = "x"; _ratio = 2; }',
        '}'
      ),
      lines(
        'class C',
        '{',
        '    private int _count;',
        '    private bool _done;',
        '    private string _name;',
        '    private double _ratio, _other = 1;',
        '    public int Total { get; set; }',
        '    public void Reset() { _count = 1; _done = true; _name = "x"; _ratio = 2; }',
        '}'
      )
    );
  });

  it('keeps initializers that are not defaults and reports the unprovable ones', () => {
    const source = lines(
      'class C',
      '{',
      '    private const int Zero = 0;',
      '    private int? _maybe = 0;',
      '    private object _boxed = 0;',
      '    private string _name = null!;',
      '    private Kind _kind = 0;',
      '    private readonly int _never = 0;',
      '    public int Read() => _never + (int)_kind;',
      '}',
      'struct S',
      '{',
      '    private int _field = 0;',
      '    public S() { }',
      '}'
    );

    const result = cleanup(source, 'dotnet_diagnostic.CA1805.severity = warning');

    expect(result.output).toBe(source);
    expect(result.issues).toEqual([
      expect.stringMatching(/^CA1805 line 7: '_kind' .*'Kind'/),
      expect.stringMatching(/^CA1805 line 8: '_never' .*CS0649/),
    ]);
  });
});

describe('CA1825 avoid zero-length array allocations', () => {
  it('uses Array.Empty', () => {
    expectRewrite(
      'CA1825',
      lines('using System;', 'class C', '{', '    private int[] _none = new int[0];', '    string[] M() => new string[] { };', '}'),
      lines('using System;', 'class C', '{', '    private int[] _none = Array.Empty<int>();', '    string[] M() => Array.Empty<string>();', '}')
    );
  });

  it('qualifies Array without a using directive and skips attributes', () => {
    const source = lines('class C', '{', '    [Values(new int[0])]', '    object M() => new object[0];', '}');

    expect(cleanup(source, 'dotnet_diagnostic.CA1825.severity = warning').output).toBe(
      lines('class C', '{', '    [Values(new int[0])]', '    object M() => System.Array.Empty<object>();', '}')
    );
  });

  it('reports what it cannot prove', () => {
    const source = lines('class C', '{', '    object M() => new object[0];', '    object N() => Run(() => new int[0]);', '}');

    const unknown = cleanup(source, 'dotnet_diagnostic.CA1825.severity = warning', null);
    expect(unknown.output).toBe(source);
    expect(unknown.issues).toEqual([
      expect.stringMatching(/^CA1825 line 3: .*target framework/),
      expect.stringMatching(/^CA1825 line 4: .*target framework/),
    ]);

    const lambda = cleanup(source, 'dotnet_diagnostic.CA1825.severity = warning');
    expect(lambda.output).toBe(source.replace('new object[0]', 'System.Array.Empty<object>()'));
    expect(lambda.issues).toEqual([expect.stringMatching(/^CA1825 line 4: .*expression tree/)]);

    expect(cleanup(source, 'dotnet_diagnostic.CA1825.severity = warning', targeting('net45'))).toEqual({ output: source, issues: [] });
  });
});

describe('Count/Any rules', () => {
  it('CA1829 uses Length or Count instead of Count()', () => {
    expectRewrite(
      'CA1829',
      method('var n = a.Count() + l.Count() + s.Count();', 'if (l.Count() > 0) { }', 'var m = e.Count();'),
      method('var n = a.Length + l.Count + s.Length;', 'if (l.Count > 0) { }', 'var m = e.Count();')
    );
  });

  it('CA1827 uses Any() for Count() comparisons', () => {
    expectRewrite(
      'CA1827',
      method('if (e.Count() > 0 || e.Count() == 0) { }', 'var b = 0 < e.Count() && e.Where(x => x > 1).Count() != 0;', 'var c = l.Count(x => x > 1) >= 1;'),
      method('if (e.Any() || !e.Any()) { }', 'var b = e.Any() && e.Where(x => x > 1).Any();', 'var c = l.Any(x => x > 1);')
    );
  });

  it('CA1827 reports comparisons on receivers of unknown type', () => {
    const source = method('if (Items().Count() > 0) { }');

    const result = cleanup(source, 'dotnet_diagnostic.CA1827.severity = warning');
    expect(result.output).toBe(source);
    expect(result.issues).toEqual([expect.stringMatching(/^CA1827 line 9: .*Items\(\)/)]);
  });

  it('CA1828 uses AnyAsync() for awaited CountAsync() comparisons with Entity Framework', () => {
    const before = lines(
      'using Microsoft.EntityFrameworkCore;',
      'class C',
      '{',
      '    async Task<bool> M(IQueryable<int> q) => await q.CountAsync() > 0 && await q.LongCountAsync(x => x > 1) == 0;',
      '}'
    );

    expectRewrite(
      'CA1828',
      before,
      lines('using Microsoft.EntityFrameworkCore;', 'class C', '{', '    async Task<bool> M(IQueryable<int> q) => await q.AnyAsync() && !await q.AnyAsync(x => x > 1);', '}')
    );

    const withoutEf = before.replace('using Microsoft.EntityFrameworkCore;\n', '');
    const result = cleanup(withoutEf, 'dotnet_diagnostic.CA1828.severity = warning');
    expect(result.output).toBe(withoutEf);
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0]).toMatch(/^CA1828 line 3: .*Entity Framework/);
  });

  it('CA1860 uses Length, Count or IsEmpty instead of Any()', () => {
    expectRewrite(
      'CA1860',
      method('if (a.Any() && !l.Any()) { }', 'var b = s.Any().ToString();', 'var c = e.Any();'),
      method('if (a.Length != 0 && l.Count == 0) { }', 'var b = (s.Length != 0).ToString();', 'var c = e.Any();')
    );
  });
});

describe('CA1507 use nameof in place of string', () => {
  it('replaces parameter and property names passed as paramName or propertyName', () => {
    expectRewrite(
      'CA1507',
      lines(
        'class C',
        '{',
        '    public string Name { get; set; }',
        '    void M(string value, int count)',
        '    {',
        '        if (value == null) throw new ArgumentNullException("value");',
        '        if (count < 0) throw new ArgumentOutOfRangeException("count", "negative");',
        '        if (count > 9) throw new ArgumentException("too big", "count");',
        '        ArgumentNullException.ThrowIfNull(value, "value");',
        '        Raise(new PropertyChangedEventArgs("Name"));',
        '        Check(paramName: "count");',
        '        throw new ArgumentException("value");',
        '    }',
        '}'
      ),
      lines(
        'class C',
        '{',
        '    public string Name { get; set; }',
        '    void M(string value, int count)',
        '    {',
        '        if (value == null) throw new ArgumentNullException(nameof(value));',
        '        if (count < 0) throw new ArgumentOutOfRangeException(nameof(count), "negative");',
        '        if (count > 9) throw new ArgumentException("too big", nameof(count));',
        '        ArgumentNullException.ThrowIfNull(value, nameof(value));',
        '        Raise(new PropertyChangedEventArgs(nameof(Name)));',
        '        Check(paramName: nameof(count));',
        '        throw new ArgumentException("value");',
        '    }',
        '}'
      )
    );
  });

  it('matches lambda parameters and ignores names that are not in scope', () => {
    expectRewrite(
      'CA1507',
      lines('class C', '{', '    Action<string> A = input => throw new ArgumentNullException("input");', '    void M() => throw new ArgumentNullException("other");', '}'),
      lines('class C', '{', '    Action<string> A = input => throw new ArgumentNullException(nameof(input));', '    void M() => throw new ArgumentNullException("other");', '}')
    );
  });
});

describe('CA1507 scopes', () => {
  it('does not name parameters outside a static local function or lambda (CS8421)', () => {
    const source = lines(
      'class C',
      '{',
      '    void M(string value)',
      '    {',
      '        static void Check(string other) => throw new ArgumentNullException("value");',
      '        Func<string, int> f = static s => throw new ArgumentNullException("value");',
      '    }',
      '}'
    );

    expect(cleanup(source, 'dotnet_diagnostic.CA1507.severity = warning')).toEqual({ output: source, issues: [] });
  });
});

describe('string and StringBuilder rules', () => {
  it('CA1834 appends a char for a single-character string', () => {
    expectRewrite(
      'CA1834',
      method('var sb = new StringBuilder();', 'sb.Append("x").Append("\\n").Append("ab");', 'new StringBuilder().Append("\'");'),
      method('var sb = new StringBuilder();', "sb.Append('x').Append('\\n').Append(\"ab\");", "new StringBuilder().Append('\\'');")
    );
  });

  it('CA1847 uses Contains(char)', () => {
    expectRewrite('CA1847', method('var b = s.Contains("x") || l.Contains(1);'), method("var b = s.Contains('x') || l.Contains(1);"));
  });

  it('CA1847 needs a framework with string.Contains(char)', () => {
    const source = method('var b = s.Contains("x");');

    expect(cleanup(source, 'dotnet_diagnostic.CA1847.severity = warning', targeting('net48'))).toEqual({ output: source, issues: [] });
    const unknown = cleanup(source, 'dotnet_diagnostic.CA1847.severity = warning', null);
    expect(unknown.output).toBe(source);
    expect(unknown.issues).toEqual([expect.stringMatching(/^CA1847 line 9: .*target framework/)]);
  });

  it('CA1865 uses the char overload for ordinal comparisons; CA1866 and CA1867 are reported', () => {
    const source = method(
      'var a1 = s.StartsWith("x", StringComparison.Ordinal);',
      'var a2 = s.IndexOf("x", 2, StringComparison.Ordinal);',
      'var a3 = s.EndsWith("x", StringComparison.InvariantCulture);',
      'var a4 = s.StartsWith("x");',
      'var a5 = s.LastIndexOf("x", StringComparison.OrdinalIgnoreCase);'
    );
    const rules = ['CA1865', 'CA1866', 'CA1867'].map((id) => `dotnet_diagnostic.${id}.severity = warning`).join('\n');

    const result = cleanup(source, rules);
    expect(result.output).toBe(
      method(
        "var a1 = s.StartsWith('x');",
        "var a2 = s.IndexOf('x', 2);",
        "var a3 = s.EndsWith('x');",
        'var a4 = s.StartsWith("x");',
        'var a5 = s.LastIndexOf("x", StringComparison.OrdinalIgnoreCase);'
      )
    );
    expect(result.issues).toEqual([expect.stringMatching(/^CA1866 line 12: /), expect.stringMatching(/^CA1867 line 13: /)]);

    expect(cleanup(source, 'dotnet_diagnostic.CA1865.severity = warning').issues).toEqual([]);
    expect(cleanup(source, '')).toEqual({ output: source, issues: [] });
  });

  it('CA2249 uses Contains instead of IndexOf comparisons', () => {
    expectRewrite(
      'CA2249',
      method(
        "var a1 = s.IndexOf('x') >= 0;",
        'var a2 = s.IndexOf("ab") == -1;',
        'var a3 = s.IndexOf("ab", StringComparison.Ordinal) != -1;',
        'var a4 = -1 == s.IndexOf("ab", StringComparison.OrdinalIgnoreCase);',
        'var a5 = s.IndexOf("ab") > 2;'
      ),
      method(
        "var a1 = s.Contains('x');",
        'var a2 = !s.Contains("ab", StringComparison.CurrentCulture);',
        'var a3 = s.Contains("ab");',
        'var a4 = !s.Contains("ab", StringComparison.OrdinalIgnoreCase);',
        'var a5 = s.IndexOf("ab") > 2;'
      )
    );
  });

  it('CA2249 reports comparisons whose argument type is unknown and needs a framework with the Contains overloads', () => {
    const source = method('var a = s.IndexOf(Pick()) >= 0;', "var b = s.IndexOf('x') == -1;");

    const result = cleanup(source, 'dotnet_diagnostic.CA2249.severity = warning');
    expect(result.output).toBe(source.replace("s.IndexOf('x') == -1", "!s.Contains('x')"));
    expect(result.issues).toEqual([expect.stringMatching(/^CA2249 line 9: .*Pick\(\)/)]);

    expect(cleanup(source, 'dotnet_diagnostic.CA2249.severity = warning', targeting('netstandard2.0'))).toEqual({ output: source, issues: [] });
  });
});

describe('IDE0004 remove unnecessary cast', () => {
  it('removes casts to the type the value already has', () => {
    expectRewrite(
      'IDE0004',
      method('int i = 1;', 'var x = (int)i + (int)0 + (long)2L;', 'var t = (string)s;', 'Func<int> f = () => { return(int)i; };', 'var y = (long)i + (int?)i + ((int)i).GetHashCode();'),
      method('int i = 1;', 'var x = i + 0 + 2L;', 'var t = s;', 'Func<int> f = () => { return i; };', 'var y = (long)i + (int?)i + ((int)i).GetHashCode();')
    );
  });
});

describe('Count rules in lambdas', () => {
  it('reports instead of rewriting where an expression tree may need the method call', () => {
    const source = method('var q = e.Where(x => a.Count() > x);');

    const result = cleanup(source, 'dotnet_diagnostic.CA1829.severity = warning');
    expect(result.output).toBe(source);
    expect(result.issues).toEqual([expect.stringMatching(/^CA1829 line 9: a\.Count\(\) .*expression tree/)]);
  });
});

describe('IDE0005 remove unnecessary using directives', () => {
  it('removes duplicates and usings of the enclosing namespace', () => {
    expectRewrite(
      'IDE0005',
      lines('using System;', 'using App;', 'using System.Text;', 'using System;', 'using App.Models;', '', 'namespace App.Models;', '', 'class C { }'),
      lines('using System;', 'using System.Text;', '', 'namespace App.Models;', '', 'class C { }')
    );
  });

  it('keeps usings the file needs outside its namespace', () => {
    const source = lines('using App;', '[assembly: Marker]', 'namespace App.Models;', 'class C { }');

    expect(cleanup(source, 'dotnet_diagnostic.IDE0005.severity = warning')).toEqual({ output: source, issues: [] });
  });
});
