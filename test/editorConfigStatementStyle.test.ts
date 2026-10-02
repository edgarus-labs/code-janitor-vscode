import { describe, expect, it } from 'vitest';
import { resolveEditorConfigProperties } from '../src/cleanup/editorconfig';
import { ProjectInfo } from '../src/cleanup/projectInfo';
import { createEditorConfigCodeStyleConverter } from '../src/cleanup/transformations/editorConfigCodeStyle';

function lines(...text: string[]): string {
  return `${text.join('\n')}\n`;
}

function method(returnType: string, ...body: string[]): string {
  return lines('class Sample', '{', '    private string _name;', '', `    ${returnType} M(bool c, int i, object o)`, '    {', ...body.map((line) => (line ? `        ${line}` : '')), '    }', '}');
}

function codeStyle(source: string, rules: string, project?: ProjectInfo): string {
  const props = resolveEditorConfigProperties([{ directory: '/repo', text: `root = true\n[*.cs]\n${rules}\n` }], '/repo/Sample.cs');

  return createEditorConfigCodeStyleConverter(props, () => undefined, { project }).apply(source);
}

/** A .NET Framework project: C# 7.3, before target-typed conditionals. */
const CSHARP_7_3: ProjectInfo = { directory: '/repo', languageVersion: 7.3 };

/** Asserts the setting rewrites `before` to `after` while enforced and changes nothing while silent. */
function expectRewrite(setting: string, before: string, after: string): void {
  expect(codeStyle(before, `${setting}:warning`)).toBe(after);
  expect(codeStyle(before, `${setting}:silent`)).toBe(before);
}

describe('IDE0045 dotnet_style_prefer_conditional_expression_over_assignment', () => {
  it('assigns a conditional when the target type keeps each value unchanged', () => {
    expectRewrite(
      'dotnet_style_prefer_conditional_expression_over_assignment = true',
      method('void', 'if (c) i = 1; else i = 2;', 'int n;', 'if (c)', '{', '    n = i;', '}', 'else', '{', '    n = 0;', '}', 'object x;', 'if (c) x = 1; else x = 2L;'),
      method('void', 'i = c ? 1 : 2;', 'int n = c ? i : 0;', 'object x;', 'if (c) x = 1; else x = 2L;')
    );
  });

  it('keeps assignments that need a target-typed conditional before C# 9', () => {
    const setting = 'dotnet_style_prefer_conditional_expression_over_assignment = true:warning';
    const source = method('void', 'int? x;', 'if (c) x = 1; else x = null;', 'long z;', 'if (c) z = 1u; else z = i;');

    expect(codeStyle(source, setting, CSHARP_7_3)).toBe(source);
    expect(codeStyle(method('void', 'if (c) i = 1; else i = 2;'), setting, CSHARP_7_3)).toBe(method('void', 'i = c ? 1 : 2;'));
    expect(codeStyle(source, setting, { directory: '/repo', languageVersion: 9 })).toBe(method('void', 'int? x = c ? 1 : null;', 'long z = c ? 1u : i;'));
  });

  it('keeps comments and directives between the declaration and the if', () => {
    const setting = 'dotnet_style_prefer_conditional_expression_over_assignment = true:warning';
    for (const between of [['// keep me'], ['#region Body']]) {
      const source = method('void', 'int n;', ...between, 'if (c) n = 1; else n = 2;', ...(between[0].startsWith('#') ? ['#endregion'] : []));

      expect(codeStyle(source, setting)).toBe(source);
    }
  });
});

describe('IDE0046 dotnet_style_prefer_conditional_expression_over_return', () => {
  it('returns a conditional for if/else and if/return', () => {
    expectRewrite(
      'dotnet_style_prefer_conditional_expression_over_return = true',
      method('string', 'if (c) return "a"; else return _name;'),
      method('string', 'return c ? "a" : _name;')
    );
    expectRewrite(
      'dotnet_style_prefer_conditional_expression_over_return = true',
      method('int', 'if (c)', '{', '    return 1;', '}', '', 'return i;'),
      method('int', 'return c ? 1 : i;')
    );
  });

  it('simplifies boolean results instead of returning true or false from a conditional', () => {
    expectRewrite(
      'dotnet_style_prefer_conditional_expression_over_return = true',
      method('bool', 'if (i > 1) return true;', 'return false;'),
      method('bool', 'return i > 1;')
    );
    expectRewrite(
      'dotnet_style_prefer_conditional_expression_over_return = true',
      method('bool', 'if (c || i > 1) return false;', 'return o is string;'),
      method('bool', 'return !(c || i > 1) && o is string;')
    );
  });

  it('leaves returns of types the conditional could change alone', () => {
    const source = method('object', 'if (c) return 1; return 2L;');

    expect(codeStyle(source, 'dotnet_style_prefer_conditional_expression_over_return = true:warning')).toBe(source);
  });

  it('keeps returns that need a target-typed conditional before C# 9', () => {
    const setting = 'dotnet_style_prefer_conditional_expression_over_return = true:warning';
    const source = method('int?', 'if (c) return 1;', 'return null;');

    expect(codeStyle(source, setting, CSHARP_7_3)).toBe(source);
    expect(codeStyle(method('string', 'if (c) return "a"; else return _name;'), setting, CSHARP_7_3)).toBe(method('string', 'return c ? "a" : _name;'));
    expect(codeStyle(source, setting, { directory: '/repo', languageVersion: 9 })).toBe(method('int?', 'return c ? 1 : null;'));
  });
});

describe('IDE0017 dotnet_style_object_initializer', () => {
  it('moves member assignments after a creation into an initializer', () => {
    expectRewrite(
      'dotnet_style_object_initializer = true',
      method('void', 'var s = new Sample();', 's._name = "x";', 's.Count = i;', 's.Other = s.Count;', 'Use(s);'),
      method('void', 'var s = new Sample()', '{', '    _name = "x",', '    Count = i', '};', 's.Other = s.Count;', 'Use(s);')
    );
  });

  it('leaves the creation alone when an assigned value reads the local inside an interpolated string', () => {
    const source = method('void', 'var s = new Sample();', 's._name = "x";', 's.Other = $"{s._name}!";', 'Use(s);');

    expect(codeStyle(source, 'dotnet_style_object_initializer = true:warning')).toBe(method('void', 'var s = new Sample()', '{', '    _name = "x"', '};', 's.Other = $"{s._name}!";', 'Use(s);'));
  });
});

describe('IDE0028 dotnet_style_collection_initializer', () => {
  it('moves Add calls after a creation into a collection initializer', () => {
    expectRewrite(
      'dotnet_style_collection_initializer = true',
      method('void', 'var list = new List<int>();', 'list.Add(1);', 'list.Add(i);', 'var map = new Dictionary<string, int>(4);', 'map.Add("a", 1);', 'Use(list, map);'),
      method('void', 'var list = new List<int>()', '{', '    1,', '    i', '};', 'var map = new Dictionary<string, int>(4)', '{', '    { "a", 1 }', '};', 'Use(list, map);')
    );
  });

  it('leaves explicitly typed locals to collection expressions (IDE0306) when those are preferred', () => {
    const source = method('void', 'List<int> list = new List<int>();', 'list.Add(1);');

    expect(codeStyle(source, 'dotnet_style_collection_initializer = true:warning\ndotnet_style_prefer_collection_expression = true:warning')).toBe(
      method('void', 'List<int> list = [];', 'list.Add(1);')
    );
  });

  it('stops before an Add call that reads the local inside an interpolated string', () => {
    const source = method('void', 'var list = new List<string>();', 'list.Add($"{list.Count}");', 'Use(list);');

    expect(codeStyle(source, 'dotnet_style_collection_initializer = true:warning')).toBe(source);
  });
});

describe('interpolated strings as uses of a local', () => {
  it('keeps a tuple local read by name inside an interpolated string (IDE0042)', () => {
    const source = method('void', 'var point = (a: 1, b: 2);', 'Use(point.a, $"{point.b}");');

    expect(codeStyle(source, 'csharp_style_deconstructed_variable_declaration = true:warning')).toBe(source);
  });

  it('keeps a tuple local read inside an @$ verbatim interpolated string (IDE0042)', () => {
    const source = method('void', 'var point = (x: 1, y: 2);', 'Use(point.x);', 'Use(@$"C:\\{point}");');

    expect(codeStyle(source, 'csharp_style_deconstructed_variable_declaration = true:warning')).toBe(source);
  });

  it('keeps a swap temporary read inside an interpolated string (IDE0180)', () => {
    const source = method('void', 'int j = 0;', 'var t = i;', 'i = j;', 'j = t;', 'Use($"{t}");');

    expect(codeStyle(source, 'csharp_style_prefer_tuple_swap = true:warning')).toBe(source);
  });

  it('keeps a swap temporary read inside a global::-qualified call in an interpolated string (IDE0180)', () => {
    const source = method('void', 'int j = 0;', 'var t = i;', 'i = j;', 'j = t;', 'Use($"{global::X.F(t)}");');

    expect(codeStyle(source, 'csharp_style_prefer_tuple_swap = true:warning')).toBe(source);
  });

  it('keeps a delegate local passed as a value inside an interpolated string (IDE0039)', () => {
    const source = method('void', 'Func<int, int> f = x => x + 1;', 'Use(f(1), $"{f}");');

    expect(codeStyle(source, 'csharp_style_prefer_local_over_anonymous_function = true:warning')).toBe(source);
  });

  it('still turns a delegate local into a local function when a hole only calls it (IDE0039)', () => {
    const source = method('void', 'Func<int, int> f = x => x + 1;', 'Use(f(1));', 'Use($"{f(2)} {f(3):D2}");');

    expect(codeStyle(source, 'csharp_style_prefer_local_over_anonymous_function = true:warning')).toContain('int f(int x)');
  });

  it('keeps an as-cast local read after the null check inside an interpolated string (IDE0019)', () => {
    const source = method('void', 'var s = o as string;', 'if (s != null) Use(s);', 'Use($"{s}");');

    expect(codeStyle(source, 'csharp_style_pattern_matching_over_as_with_null_check = true:warning')).toBe(source);
  });

  it('keeps a cast local assigned inside an interpolated string (IDE0020)', () => {
    const source = method('void', 'if (o is string)', '{', '    var t = (string)o;', '    Use($"{t = "x"}");', '}');

    expect(codeStyle(source, 'csharp_style_pattern_matching_over_is_with_cast_check = true:warning')).toBe(source);
  });
});

describe('IDE0066 csharp_style_prefer_switch_expression', () => {
  it('turns a switch that returns in every section into a switch expression', () => {
    expectRewrite(
      'csharp_style_prefer_switch_expression = true',
      method('string', 'switch (i)', '{', '    case 1:', '    case 2:', '        return "low";', '    case int n when n > 9:', '        return "high";', '    default:', '        throw new ArgumentOutOfRangeException();', '}'),
      method('string', 'return i switch', '{', '    1 or 2 => "low",', '    int n when n > 9 => "high",', '    _ => throw new ArgumentOutOfRangeException(),', '};')
    );
  });

  it('assigns a switch expression and uses a following return as the default arm', () => {
    expectRewrite(
      'csharp_style_prefer_switch_expression = true',
      method('int', 'int n;', 'switch (i)', '{', '    case 1:', '        n = 10;', '        break;', '    default:', '        n = 0;', '        break;', '}', 'switch (i)', '{', '    case 3: return 30;', '}', 'return n;'),
      method('int', 'int n = i switch', '{', '    1 => 10,', '    _ => 0,', '};', 'return i switch', '{', '    3 => 30,', '    _ => n,', '};')
    );
  });

  it('leaves switches with other statements, or of types the arms could change, alone', () => {
    const source = method('object', 'switch (i)', '{', '    case 1: return 1;', '    default: return 2L;', '}');

    expect(codeStyle(source, 'csharp_style_prefer_switch_expression = true:warning')).toBe(source);
  });

  it('keeps an unconditional throw after an assigning switch without a default', () => {
    const source = method('int', 'int n;', 'switch (i)', '{', '    case 1:', '        n = 10;', '        break;', '    case 2:', '        n = 20;', '        break;', '}', 'throw new System.Exception();');

    expect(codeStyle(source, 'csharp_style_prefer_switch_expression = true:warning')).toBe(source);
  });

  it('keeps comments and directives between the declaration and an assigning switch', () => {
    const sections = ['switch (i)', '{', '    case 1:', '        n = 10;', '        break;', '    default:', '        n = 0;', '        break;', '}'];
    for (const between of [['// keep me'], ['#region Body']]) {
      const source = method('void', 'int n;', ...between, ...sections, ...(between[0].startsWith('#') ? ['#endregion'] : []));

      expect(codeStyle(source, 'csharp_style_prefer_switch_expression = true:warning')).toBe(source);
    }
  });
});

describe('IDE0019 csharp_style_pattern_matching_over_as_with_null_check', () => {
  it('uses a type pattern instead of as and a null check', () => {
    expectRewrite(
      'csharp_style_pattern_matching_over_as_with_null_check = true',
      method('void', 'var s = o as string;', 'if (s != null && s.Length > 0)', '{', '    Use(s);', '    Use(s.Length);', '}', 'var u = o as Uri;', 'if (u != null) Use(u);', 'Use(u);'),
      method('void', 'if (o is string s && s.Length > 0)', '{', '    Use(s);', '    Use(s.Length);', '}', 'var u = o as Uri;', 'if (u != null) Use(u);', 'Use(u);')
    );
  });

  it('keeps a null check that may call a user-defined != operator', () => {
    const setting = 'csharp_style_pattern_matching_over_as_with_null_check = true:warning';
    const unity = method('void', 'var r = o as Renderer;', 'if (r != null)', '{', '    r.enabled = false;', '}');
    const declared = `${method('void', 'var p = o as Point;', 'if (p != null) Use(p);')}class Point\n{\n    public static bool operator ==(Point a, Point b) => true;\n    public static bool operator !=(Point a, Point b) => false;\n}\n`;

    expect(codeStyle(unity, setting)).toBe(unity);
    expect(codeStyle(declared, setting)).toBe(declared);
    expect(codeStyle(method('void', 'var r = o as Renderer;', 'if (r is not null) Use(r);'), setting)).toBe(method('void', 'if (o is Renderer r) Use(r);'));
  });
});

describe('IDE0020 csharp_style_pattern_matching_over_is_with_cast_check', () => {
  it('declares the pattern variable instead of casting after a type check', () => {
    expectRewrite(
      'csharp_style_pattern_matching_over_is_with_cast_check = true',
      method('void', 'if (o is string)', '{', '    var s = (string)o;', '    Use(s);', '}'),
      method('void', 'if (o is string s)', '{', '    Use(s);', '}')
    );
  });

  it('keeps the cast local when the name means something else after the if', () => {
    const setting = 'csharp_style_pattern_matching_over_is_with_cast_check = true:warning';
    const source = lines('class C', '{', '    int count;', '', '    void M(object o)', '    {', '        if (o is int)', '        {', '            var count = (int)o;', '            Use(count);', '        }', '', '        count++;', '    }', '}');
    const other = lines('class C', '{', '    int count;', '', '    void M(object o)', '    {', '        if (o is int && count > 0)', '        {', '            var count = (int)o;', '            Use(count);', '        }', '    }', '}');

    expect(codeStyle(source, setting)).toBe(source);
    expect(codeStyle(other, setting)).toBe(other);
    const member = source.replace('count++;', 'this.count++;');
    expect(codeStyle(member, setting)).toBe(member.replace('o is int)', 'o is int count)').replace('            var count = (int)o;\n', ''));
  });
});
