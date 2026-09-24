import { describe, expect, it } from 'vitest';
import { resolveEditorConfigProperties } from '../src/cleanup/editorconfig';
import { createEditorConfigCodeStyleConverter } from '../src/cleanup/transformations/editorConfigCodeStyle';

function lines(...text: string[]): string {
  return `${text.join('\n')}\n`;
}

/** A method body wrapped in a class with a few typed members the rules can rely on. */
function method(...body: string[]): string {
  return lines(
    'using System;',
    '',
    'class Sample',
    '{',
    '    private string _name;',
    '',
    '    void M(string s, object o, int i, int? n, bool b, bool c, Action handler, Sample other, Uri uri)',
    '    {',
    ...body.map((line) => (line ? `        ${line}` : '')),
    '    }',
    '}'
  );
}

function codeStyle(source: string, rules: string): string {
  const props = resolveEditorConfigProperties([{ directory: '/repo', text: `root = true\n[*.cs]\n${rules}\n` }], '/repo/Sample.cs');

  return createEditorConfigCodeStyleConverter(props, () => undefined).apply(source);
}

/** Asserts the option rewrites `before` to `after` while enforced and changes nothing while silent. */
function expectRewrite(setting: string, before: string, after: string): void {
  expect(codeStyle(before, `${setting}:warning`)).toBe(after);
  expect(codeStyle(before, `${setting}:silent`)).toBe(before);
  expect(codeStyle(before, setting)).toBe(before);
}

describe('IDE0047 / IDE0048 dotnet_style_parentheses_in_*', () => {
  it('adds parentheses that clarify precedence within a group', () => {
    expectRewrite(
      'dotnet_style_parentheses_in_arithmetic_binary_operators = always_for_clarity',
      method('var a = i + i * 2;', 'var d = i * 2 - 1;', 'var e = i + i - 1;', 'var f = i < 2 == b;'),
      method('var a = i + (i * 2);', 'var d = (i * 2) - 1;', 'var e = i + i - 1;', 'var f = i < 2 == b;')
    );
    expectRewrite(
      'dotnet_style_parentheses_in_relational_binary_operators = always_for_clarity',
      method('var f = i < 2 == b;'),
      method('var f = (i < 2) == b;')
    );
    expectRewrite('dotnet_style_parentheses_in_other_binary_operators = always_for_clarity', method('var g = b || c && b;'), method('var g = b || (c && b);'));
  });

  it('removes parentheses around primary expressions and standalone expressions', () => {
    expectRewrite(
      'dotnet_style_parentheses_in_other_operators = never_if_unnecessary',
      method('var a = (s).Length;', 'var d = (b ? 1 : 2);', 'var e = (int)(i);', 'Use((c ? s : null));', 'var f = (i + 1) * 2;', 'var g = (1).ToString();', 'var h = (other?._name).Length;'),
      method('var a = s.Length;', 'var d = b ? 1 : 2;', 'var e = (int)i;', 'Use(c ? s : null);', 'var f = (i + 1) * 2;', 'var g = (1).ToString();', 'var h = (other?._name).Length;')
    );
  });

  it('removes binary parentheses only where the grouping stays the same', () => {
    expectRewrite(
      'dotnet_style_parentheses_in_arithmetic_binary_operators = never_if_unnecessary',
      method('var a = i + (i * 2);', 'var d = (i - 1) - 2;', 'var e = i - (i - 1);', 'var f = (i + 1) * 2;', 'var g = (i + 1);'),
      method('var a = i + i * 2;', 'var d = i - 1 - 2;', 'var e = i - (i - 1);', 'var f = (i + 1) * 2;', 'var g = i + 1;')
    );
  });
});

describe('IDE0054 dotnet_style_prefer_compound_assignment', () => {
  it('uses compound assignment when the target is repeated as the left operand', () => {
    expectRewrite(
      'dotnet_style_prefer_compound_assignment = true',
      method('i = i + 1;', '_name = _name ?? s;', 'this._name = this._name + s;', 'i = 1 + i;', 'i = i - 1 - 2;', 'i = i * (i + 1);', 'Use(_name ?? (_name = s));'),
      method('i += 1;', '_name ??= s;', 'this._name += s;', 'i = 1 + i;', 'i = i - 1 - 2;', 'i *= (i + 1);', 'Use(_name ??= s);')
    );
  });
});

describe('IDE0075 dotnet_style_prefer_simplified_boolean_expressions', () => {
  it('simplifies conditionals with boolean literals when both sides are bool', () => {
    expectRewrite(
      'dotnet_style_prefer_simplified_boolean_expressions = true',
      method('var a = i > 0 ? true : false;', 'var d = b ? false : true;', 'var e = b ? true : i == 2;', 'var f = b || c ? c : false;', 'var g = o is string ? Check() : false;'),
      method('var a = i > 0;', 'var d = !b;', 'var e = b || i == 2;', 'var f = (b || c) && c;', 'var g = o is string ? Check() : false;')
    );
  });
});

describe('IDE0029 / IDE0030 dotnet_style_coalesce_expression', () => {
  it('uses ?? when the checked value has no user-defined equality', () => {
    expectRewrite(
      'dotnet_style_coalesce_expression = true',
      method('var a = s != null ? s : "x";', 'var d = _name == null ? s : _name;', 'var e = n.HasValue ? n.Value : 0;', 'var f = uri != null ? uri : null;', 'var g = o is null ? s : o;', 'var h = other != null ? other : this;'),
      method('var a = s ?? "x";', 'var d = _name ?? s;', 'var e = n ?? 0;', 'var f = uri != null ? uri : null;', 'var g = o ?? s;', 'var h = other ?? this;')
    );
  });

  it('uses ?? for classes declared in the file without operator ==', () => {
    const source = lines('class Node', '{', '    Node Next(Node node, Node fallback) => node != null ? node : fallback;', '}');

    expect(codeStyle(source, 'dotnet_style_coalesce_expression = true:warning')).toBe(source.replace('node != null ? node : fallback', 'node ?? fallback'));
  });
});

describe('IDE0031 dotnet_style_null_propagation', () => {
  it('uses ?. for access chains on the checked value', () => {
    expectRewrite(
      'dotnet_style_null_propagation = true',
      method('var a = s != null ? s.Trim() : null;', 'var d = o is null ? null : o.ToString().Length;', 'var e = uri != null ? uri.Host : null;', 'var f = s != null ? s.Length : 0;', 'var g = other != null ? other._name : null;'),
      method('var a = s?.Trim();', 'var d = o?.ToString().Length;', 'var e = uri != null ? uri.Host : null;', 'var f = s != null ? s.Length : 0;', 'var g = other?._name;')
    );
  });

  it('leaves possible expression trees alone', () => {
    const source = method('Expression<Func<string, string>> e = x => x != null ? x.Trim() : null;');

    expect(codeStyle(source, 'dotnet_style_null_propagation = true:warning')).toBe(source);
  });
});

describe('IDE1005 csharp_style_conditional_delegate_call', () => {
  it('invokes delegates with ?.Invoke', () => {
    expectRewrite(
      'csharp_style_conditional_delegate_call = true',
      method('if (handler != null) handler();', 'if (handler != null)', '{', '    handler.Invoke();', '}', 'if (handler != null) handler(); else Use(s);'),
      method('handler?.Invoke();', 'handler?.Invoke();', 'if (handler != null) handler(); else Use(s);')
    );
  });
});

describe('IDE0041 dotnet_style_prefer_is_null_check_over_reference_equality_method', () => {
  it('uses is null checks', () => {
    expectRewrite(
      'dotnet_style_prefer_is_null_check_over_reference_equality_method = true',
      method('if (ReferenceEquals(o, null)) { }', 'if (!object.ReferenceEquals(null, s)) { }', 'var a = ReferenceEquals(o, s);'),
      method('if (o is null) { }', 'if (s is not null) { }', 'var a = ReferenceEquals(o, s);')
    );
  });
});

describe('IDE0083 csharp_style_prefer_not_pattern', () => {
  it('uses not patterns for simple type and constant patterns', () => {
    expectRewrite(
      'csharp_style_prefer_not_pattern = true',
      method('if (!(o is string)) { }', 'if (!(o is null) && b) { }', 'if (!(o is string t)) { }'),
      method('if (o is not string) { }', 'if (o is not null && b) { }', 'if (!(o is string t)) { }')
    );
  });
});

describe('IDE0078 csharp_style_prefer_pattern_matching', () => {
  it('combines comparisons of one value with constants into a pattern', () => {
    expectRewrite(
      'csharp_style_prefer_pattern_matching = true',
      method('var a = i == 1 || i == 2;', 'var d = i >= 0 && i <= 9;', 'var e = s == "a" || s == null;', 'var f = o == "a" || o == "b";', 'var g = i == 1 || i == 3000000000;'),
      method('var a = i is 1 or 2;', 'var d = i is >= 0 and <= 9;', 'var e = s is "a" or null;', 'var f = o == "a" || o == "b";', 'var g = i == 1 || i == 3000000000;')
    );
  });
});

describe('IDE0037 dotnet_style_prefer_inferred_*_names', () => {
  it('drops tuple element names C# infers', () => {
    expectRewrite(
      'dotnet_style_prefer_inferred_tuple_names = true',
      method('var a = (i: i, s: s);', 'var d = (Name: other._name, _name: s);', 'var e = (Rest: Rest, x: 1);'),
      method('var a = (i, s);', 'var d = (Name: other._name, _name: s);', 'var e = (Rest: Rest, x: 1);')
    );
  });

  it('drops anonymous type member names C# infers', () => {
    expectRewrite(
      'dotnet_style_prefer_inferred_anonymous_type_member_names = true',
      method('var a = new { i = i, Length = s.Length, Other = s };'),
      method('var a = new { i, s.Length, Other = s };')
    );
  });
});

describe('IDE0049 dotnet_style_predefined_type_for_*', () => {
  it('uses keywords for framework type names in declarations and member access', () => {
    const before = method('Int32 a = Int32.Parse(s);', 'System.String d = String.Empty;', 'var e = typeof(Object);', 'var f = nameof(Int32);');

    expect(codeStyle(before, 'dotnet_style_predefined_type_for_locals_parameters_members = true:warning')).toBe(
      method('int a = Int32.Parse(s);', 'string d = String.Empty;', 'var e = typeof(object);', 'var f = nameof(Int32);')
    );
    expect(codeStyle(before, 'dotnet_style_predefined_type_for_member_access = true:warning')).toBe(
      method('Int32 a = int.Parse(s);', 'System.String d = string.Empty;', 'var e = typeof(Object);', 'var f = nameof(Int32);')
    );
    expect(codeStyle(before, 'dotnet_style_predefined_type_for_member_access = true:silent')).toBe(before);
  });

  it('keeps names the file declares itself', () => {
    const source = lines('using System;', '', 'class String', '{', '    String Copy() => String.Empty;', '}');

    expect(codeStyle(source, 'dotnet_style_predefined_type_for_member_access = true:warning\ndotnet_style_predefined_type_for_locals_parameters_members = true:warning')).toBe(source);
  });
});

function issuesOf(source: string, rules: string): string[] {
  const props = resolveEditorConfigProperties([{ directory: '/repo', text: `root = true\n[*.cs]\n${rules}\n` }], '/repo/Sample.cs');
  const issues: string[] = [];
  createEditorConfigCodeStyleConverter(props, (issue) => issues.push(issue)).apply(source);

  return issues;
}

describe('IDE0033 dotnet_style_explicit_tuple_names', () => {
  it('uses declared element names instead of ItemN', () => {
    expectRewrite(
      'dotnet_style_explicit_tuple_names = true',
      method('(int count, string label) t = Get();', 'Use(t.Item1, t.Item2);', '(int, string) u = Get();', 'Use(u.Item1);'),
      method('(int count, string label) t = Get();', 'Use(t.count, t.label);', '(int, string) u = Get();', 'Use(u.Item1);')
    );
  });
});

describe('IDE0053 csharp_style_expression_bodied_lambdas', () => {
  it('uses expression bodies for lambdas that return a value and reports statement lambdas', () => {
    const before = method('Func<int, int> f = x => { return x + 1; };', 'Action a = () => { Use(s); };');
    const rules = 'csharp_style_expression_bodied_lambdas = true';

    expectRewrite(rules, before, method('Func<int, int> f = x => x + 1;', 'Action a = () => { Use(s); };'));
    expect(issuesOf(before, `${rules}:warning`)).toEqual([expect.stringMatching(/^IDE0053 .* line 10: the lambda body was not changed/)]);
  });
});

describe('IDE0071 dotnet_style_prefer_simplified_interpolation', () => {
  it('drops ToString calls in the holes of interpolated strings typed as string', () => {
    expectRewrite(
      'dotnet_style_prefer_simplified_interpolation = true',
      method('var a = $"{s.ToString()} and {i.ToString("N2")}";', 'Use($"{i.ToString()}");'),
      method('var a = $"{s} and {i:N2}";', 'Use($"{i.ToString()}");')
    );
  });
});

describe('IDE0170 csharp_style_prefer_extended_property_pattern', () => {
  it('uses extended property patterns for nested single-property patterns', () => {
    expectRewrite(
      'csharp_style_prefer_extended_property_pattern = true',
      method('var a = o is Uri { Host: { Length: 5 } };', 'var d = o is Uri { Host: { Length: 5, } h };'),
      method('var a = o is Uri { Host.Length: 5 };', 'var d = o is Uri { Host: { Length: 5, } h };')
    );
  });
});

describe('IDE0200 csharp_style_prefer_method_group_conversion', () => {
  const source = lines(
    'class Sample',
    '{',
    '    static void Log(string text) { }',
    '    static int Twice(int x) => x * 2;',
    '',
    '    void M(List<string> items)',
    '    {',
    '        Action<string> a = x => Log(x);',
    '        Func<int, int> f = (int x) => Twice(x);',
    '        items.ForEach(x => Log(x));',
    '    }',
    '}'
  );

  it('uses method groups where the delegate type is written and matches', () => {
    expectRewrite(
      'csharp_style_prefer_method_group_conversion = true',
      source,
      source.replace('a = x => Log(x);', 'a = Log;').replace('f = (int x) => Twice(x);', 'f = Twice;')
    );
    expect(issuesOf(source, 'csharp_style_prefer_method_group_conversion = true:warning')).toEqual([
      expect.stringMatching(/^IDE0200 .* line 10: the lambda was not replaced by 'Log'/),
    ]);
  });
});

describe('IDE0251 csharp_style_prefer_readonly_struct_member', () => {
  it('marks struct members that only read the instance readonly', () => {
    const source = lines(
      'struct Point',
      '{',
      '    private int _x;',
      '    public int X => _x;',
      '    public int Twice() { return _x * 2; }',
      '    public void Reset() { _x = 0; }',
      '    public int Next() => Twice() + 1;',
      '}'
    );

    expectRewrite(
      'csharp_style_prefer_readonly_struct_member = true',
      source,
      source.replace('public int X', 'public readonly int X').replace('public int Twice', 'public readonly int Twice').replace('public int Next', 'public readonly int Next')
    );
  });
});
