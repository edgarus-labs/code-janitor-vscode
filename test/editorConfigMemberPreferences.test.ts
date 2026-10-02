import { describe, expect, it } from 'vitest';
import { resolveEditorConfigProperties } from '../src/cleanup/editorconfig';
import { createEditorConfigCodeStyleConverter, EditorConfigCodeStyleOptions } from '../src/cleanup/transformations/editorConfigCodeStyle';

function lines(...text: string[]): string {
  return `${text.join('\n')}\n`;
}

function codeStyle(source: string, rules: string, options: EditorConfigCodeStyleOptions = {}): { output: string; issues: string[] } {
  const props = resolveEditorConfigProperties([{ directory: '/repo', text: `root = true\n[*.cs]\n${rules}\n` }], '/repo/src/Sample.cs');
  const issues: string[] = [];
  const output = createEditorConfigCodeStyleConverter(props, (issue) => issues.push(issue), options).apply(source);

  return { output, issues };
}

/** Asserts the setting rewrites `before` to `after` while enforced and changes nothing while silent. */
function expectRewrite(setting: string, before: string, after: string): void {
  expect(codeStyle(before, `${setting}:warning`).output).toBe(after);
  expect(codeStyle(before, `${setting}:silent`)).toEqual({ output: before, issues: [] });
}

describe('IDE0036 csharp_preferred_modifier_order', () => {
  const order = 'csharp_preferred_modifier_order = public,private,protected,internal,static,extern,new,virtual,abstract,sealed,override,readonly,unsafe,volatile,async';

  it('reorders modifiers, keeping partial last', () => {
    expectRewrite(
      order,
      lines('static public partial class Sample', '{', '    readonly private static int _count;', '    async public static Task RunAsync() { }', '    protected internal void M() { }', '}'),
      lines('public static partial class Sample', '{', '    private static readonly int _count;', '    public static async Task RunAsync() { }', '    protected internal void M() { }', '}')
    );
  });

  it('leaves declarations with modifiers outside the list alone', () => {
    const source = lines('class Sample', '{', '    const public int Max = 1;', '}');

    expect(codeStyle(source, `${order}:warning`).output).toBe(source);
  });
});

describe('IDE0250 csharp_style_prefer_readonly_struct', () => {
  it('makes structs that cannot change their instance readonly', () => {
    expectRewrite(
      'csharp_style_prefer_readonly_struct = true',
      lines(
        'public struct Point',
        '{',
        '    private readonly int _x;',
        '    public static int Count;',
        '    public int Y { get; init; }',
        '}',
        '',
        'public struct Counter',
        '{',
        '    private int _value;',
        '}',
        '',
        'public struct Settable',
        '{',
        '    public int Value { get; set; }',
        '}'
      ),
      lines(
        'public readonly struct Point',
        '{',
        '    private readonly int _x;',
        '    public static int Count;',
        '    public int Y { get; init; }',
        '}',
        '',
        'public struct Counter',
        '{',
        '    private int _value;',
        '}',
        '',
        'public struct Settable',
        '{',
        '    public int Value { get; set; }',
        '}'
      )
    );
  });

  it('leaves structs that assign this or are partial alone', () => {
    const source = lines('public struct Reset', '{', '    private readonly int _x;', '    public void Clear() { this = default; }', '}', '', 'partial struct Part { }');

    expect(codeStyle(source, 'csharp_style_prefer_readonly_struct = true:warning').output).toBe(source);
  });

  it('leaves structs that change a primary constructor parameter alone', () => {
    const setting = 'csharp_style_prefer_readonly_struct = true:warning';
    for (const write of ['count++', '--count', 'count += 1', '(count, _) = (1, 2)', 'Set(ref count)', 'Set(out count)']) {
      const source = lines('public struct Counter(int count)', '{', `    public void Change() => ${write};`, '    public int Value => count;', '}');

      expect(codeStyle(source, setting).output).toBe(source);
    }

    const reader = lines('public struct Point(int x)', '{', '    public int X => x;', '    public int Twice() => Read(in x) * 2;', '}');
    expect(codeStyle(reader, setting).output).toBe(reader.replace('public struct', 'public readonly struct'));
  });
});

describe('IDE0251 csharp_style_prefer_readonly_struct_member through field chains', () => {
  it('leaves members that call methods on a struct reached through a struct field alone', () => {
    const source = lines(
      'struct S',
      '{',
      '    private Outer _o;',
      '    private int[] _items;',
      '    public void Touch() { _o.A.Bump(); }',
      '    public void TouchThis() { this._o.A.Bump(); }',
      '    public void TouchParenthesized() { (_o.A).Bump(); }',
      '    public void TouchIndexed() { _o[0].A.Bump(); }',
      '    public int First() { return _items[0].A.GetHashCode(); }',
      '}'
    );

    expect(codeStyle(source, 'csharp_style_prefer_readonly_struct_member = true:warning').output).toBe(
      source.replace('public int First', 'public readonly int First')
    );
  });
});

describe('IDE0062 csharp_prefer_static_local_function', () => {
  it('makes local functions that capture nothing static', () => {
    expectRewrite(
      'csharp_prefer_static_local_function = true',
      lines(
        'class Sample',
        '{',
        '    private int _offset;',
        '',
        '    int M(int value)',
        '    {',
        '        int Double(int x) => x * 2;',
        '        int Shift(int x) => x + _offset;',
        '        int Add(int x) => x + value;',
        '        async Task<int> LoadAsync() => await Task.FromResult(1);',
        '        return Double(value) + Shift(value) + Add(value);',
        '    }',
        '}'
      ),
      lines(
        'class Sample',
        '{',
        '    private int _offset;',
        '',
        '    int M(int value)',
        '    {',
        '        static int Double(int x) => x * 2;',
        '        int Shift(int x) => x + _offset;',
        '        int Add(int x) => x + value;',
        '        static async Task<int> LoadAsync() => await Task.FromResult(1);',
        '        return Double(value) + Shift(value) + Add(value);',
        '    }',
        '}'
      )
    );
  });

  it('leaves local functions of types with a base class alone', () => {
    const source = lines('class Sample : Base', '{', '    void M()', '    {', '        int Get() => Inherited;', '    }', '}');

    expect(codeStyle(source, 'csharp_prefer_static_local_function = true:warning').output).toBe(source);
  });
});

describe('IDE0032 dotnet_style_prefer_auto_properties', () => {
  it('replaces a trivial property and its field with an auto property', () => {
    expectRewrite(
      'dotnet_style_prefer_auto_properties = true',
      lines(
        'class Sample',
        '{',
        '    private int _count = 1;',
        '',
        '    public int Count',
        '    {',
        '        get { return _count; }',
        '        private set { _count = value; }',
        '    }',
        '',
        '    private readonly string _name;',
        '    public string Name => _name;',
        '}'
      ),
      lines('class Sample', '{', '    public int Count { get; private set; } = 1;', '', '    public string Name { get; }', '}')
    );
  });

  it('reports a property whose field is used elsewhere', () => {
    const source = lines('class Sample', '{', '    private int _count;', '    public int Count { get { return _count; } }', '    void Reset() { _count = 0; }', '}');
    const { output, issues } = codeStyle(source, 'dotnet_style_prefer_auto_properties = true:warning');

    expect(output).toBe(source);
    expect(issues).toEqual([expect.stringMatching(/^IDE0032 .*line 4: .*'Count'.*'_count'/)]);
  });
});

describe('IDE0130 dotnet_style_namespace_match_folder', () => {
  const project = { directory: '/repo', rootNamespace: 'Company.App' };

  it('reports a namespace that does not match the folder', () => {
    const source = lines('namespace Company.App.Other;', '', 'class Sample { }');
    const { output, issues } = codeStyle(source, 'dotnet_style_namespace_match_folder = true:warning', { filePath: '/repo/src/Sample.cs', project });

    expect(output).toBe(source);
    expect(issues).toEqual([expect.stringMatching(/^IDE0130 .*'Company\.App\.Other'.*'Company\.App\.src'/)]);
    expect(codeStyle(source.replace('Other', 'src'), 'dotnet_style_namespace_match_folder = true:warning', { filePath: '/repo/src/Sample.cs', project }).issues).toEqual([]);
    expect(codeStyle(source, 'dotnet_style_namespace_match_folder = true:silent', { filePath: '/repo/src/Sample.cs', project }).issues).toEqual([]);
  });
});

describe('IDE0060 dotnet_code_quality_unused_parameters', () => {
  const source = lines(
    'class Sample : IThing',
    '{',
    '    private int Twice(int value, int unused) => value * 2;',
    '    public void Handle(int ignored) { }',
    '    protected override void Run(int ignored) { }',
    '    void OnClick(object sender, EventArgs e) { }',
    '    void NotYet(int later) => throw new NotImplementedException();',
    '}'
  );

  it('reports parameters that are never used', () => {
    const { output, issues } = codeStyle(source, 'dotnet_code_quality_unused_parameters = all:warning');

    expect(output).toBe(source);
    expect(issues).toEqual([expect.stringMatching(/^IDE0060 .*line 3: .*'unused'.*'Twice'/)]);
    expect(codeStyle(source, 'dotnet_code_quality_unused_parameters = all:silent').issues).toEqual([]);
  });
});
