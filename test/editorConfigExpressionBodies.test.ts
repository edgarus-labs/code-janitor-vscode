import { describe, expect, it } from 'vitest';
import { resolveEditorConfigProperties } from '../src/cleanup/editorconfig';
import { createEditorConfigCodeStyleConverter } from '../src/cleanup/transformations/editorConfigCodeStyle';

function lines(...text: string[]): string {
  return `${text.join('\n')}\n`;
}

function codeStyle(source: string, rules: string): string {
  const props = resolveEditorConfigProperties([{ directory: '/repo', text: `root = true\n[*.cs]\n${rules}\n` }], '/repo/Sample.cs');

  return createEditorConfigCodeStyleConverter(props, () => undefined).apply(source);
}

/** Asserts the setting rewrites `before` to `after` while enforced and changes nothing while silent. */
function expectRewrite(setting: string, before: string, after: string): void {
  expect(codeStyle(before, `${setting}:warning`)).toBe(after);
  expect(codeStyle(before, `${setting}:silent`)).toBe(before);
}

describe('IDE0022 csharp_style_expression_bodied_methods', () => {
  const blocks = lines(
    'class Sample',
    '{',
    '    int Twice(int x)',
    '    {',
    '        return x * 2;',
    '    }',
    '',
    '    void Log(string text)',
    '    {',
    '        Console.WriteLine(text);',
    '    }',
    '',
    '    async Task SaveAsync()',
    '    {',
    '        await Task.Delay(1);',
    '    }',
    '',
    '    int Fail() { throw new InvalidOperationException(); }',
    '',
    '    void Two()',
    '    {',
    '        A();',
    '        B();',
    '    }',
    '}'
  );
  const expressions = lines(
    'class Sample',
    '{',
    '    int Twice(int x) => x * 2;',
    '',
    '    void Log(string text) => Console.WriteLine(text);',
    '',
    '    async Task SaveAsync() => await Task.Delay(1);',
    '',
    '    int Fail() => throw new InvalidOperationException();',
    '',
    '    void Two()',
    '    {',
    '        A();',
    '        B();',
    '    }',
    '}'
  );

  it('uses expression bodies for single-statement methods', () => {
    expectRewrite('csharp_style_expression_bodied_methods = true', blocks, expressions);
  });

  it('uses block bodies for expression-bodied methods', () => {
    expectRewrite(
      'csharp_style_expression_bodied_methods = false',
      expressions,
      lines(
        'class Sample',
        '{',
        '    int Twice(int x)',
        '    {',
        '        return x * 2;',
        '    }',
        '',
        '    void Log(string text)',
        '    {',
        '        Console.WriteLine(text);',
        '    }',
        '',
        '    async Task SaveAsync()',
        '    {',
        '        await Task.Delay(1);',
        '    }',
        '',
        '    int Fail()',
        '    {',
        '        throw new InvalidOperationException();',
        '    }',
        '',
        '    void Two()',
        '    {',
        '        A();',
        '        B();',
        '    }',
        '}'
      )
    );
  });

  it('keeps multi-line expressions in blocks for when_on_single_line', () => {
    const source = lines('class Sample', '{', '    int Sum(int a, int b)', '    {', '        return a +', '            b;', '    }', '', '    int One() { return 1; }', '}');

    expect(codeStyle(source, 'csharp_style_expression_bodied_methods = when_on_single_line:warning')).toBe(
      lines('class Sample', '{', '    int Sum(int a, int b)', '    {', '        return a +', '            b;', '    }', '', '    int One() => 1;', '}')
    );
  });
});

describe('IDE0021 / IDE0023 / IDE0061 constructors, operators and local functions', () => {
  it('uses expression bodies for each kind only when its option asks', () => {
    const source = lines(
      'class Sample',
      '{',
      '    public Sample() : this(1) { Init(); }',
      '    public static Sample operator +(Sample a, Sample b) { return a; }',
      '    void M()',
      '    {',
      '        int Local() { return 1; }',
      '    }',
      '}'
    );

    expect(codeStyle(source, 'csharp_style_expression_bodied_constructors = true:warning')).toBe(source.replace('this(1) { Init(); }', 'this(1) => Init();'));
    expect(codeStyle(source, 'csharp_style_expression_bodied_operators = true:warning')).toBe(source.replace('b) { return a; }', 'b) => a;'));
    expect(codeStyle(source, 'csharp_style_expression_bodied_local_functions = true:warning')).toBe(source.replace('Local() { return 1; }', 'Local() => 1;'));
  });
});

describe('IDE0025 / IDE0026 / IDE0027 properties, indexers and accessors', () => {
  it('uses expression bodies for get-only properties and accessors', () => {
    const source = lines(
      'class Sample',
      '{',
      '    int Count { get { return _count; } }',
      '    int this[int i] { get { return i; } }',
      '    int Size { get { return _size; } set { _size = value; } }',
      '}'
    );

    expectRewrite('csharp_style_expression_bodied_properties = true', source, source.replace('Count { get { return _count; } }', 'Count => _count;'));
    expectRewrite('csharp_style_expression_bodied_indexers = true', source, source.replace('[int i] { get { return i; } }', '[int i] => i;'));
    expectRewrite(
      'csharp_style_expression_bodied_accessors = true',
      source,
      lines('class Sample', '{', '    int Count { get => _count; }', '    int this[int i] { get => i; }', '    int Size { get => _size; set => _size = value; }', '}')
    );
  });

  it('uses block bodies for expression-bodied properties', () => {
    const source = lines('class Sample', '{', '    int Count => _count;', '}');

    expect(codeStyle(source, 'csharp_style_expression_bodied_properties = false:warning')).toBe(lines('class Sample', '{', '    int Count { get => _count; }', '}'));
    expect(codeStyle(source, 'csharp_style_expression_bodied_properties = false:warning\ncsharp_style_expression_bodied_accessors = false')).toBe(
      lines('class Sample', '{', '    int Count { get { return _count; } }', '}')
    );
  });
});
