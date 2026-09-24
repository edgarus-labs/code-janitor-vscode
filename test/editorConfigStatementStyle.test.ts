import { describe, expect, it } from 'vitest';
import { resolveEditorConfigProperties } from '../src/cleanup/editorconfig';
import { createEditorConfigCodeStyleConverter } from '../src/cleanup/transformations/editorConfigCodeStyle';

function lines(...text: string[]): string {
  return `${text.join('\n')}\n`;
}

function method(returnType: string, ...body: string[]): string {
  return lines('class Sample', '{', '    private string _name;', '', `    ${returnType} M(bool c, int i, object o)`, '    {', ...body.map((line) => (line ? `        ${line}` : '')), '    }', '}');
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

describe('IDE0045 dotnet_style_prefer_conditional_expression_over_assignment', () => {
  it('assigns a conditional when the target type keeps each value unchanged', () => {
    expectRewrite(
      'dotnet_style_prefer_conditional_expression_over_assignment = true',
      method('void', 'if (c) i = 1; else i = 2;', 'int n;', 'if (c)', '{', '    n = i;', '}', 'else', '{', '    n = 0;', '}', 'object x;', 'if (c) x = 1; else x = 2L;'),
      method('void', 'i = c ? 1 : 2;', 'int n = c ? i : 0;', 'object x;', 'if (c) x = 1; else x = 2L;')
    );
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
});

describe('IDE0017 dotnet_style_object_initializer', () => {
  it('moves member assignments after a creation into an initializer', () => {
    expectRewrite(
      'dotnet_style_object_initializer = true',
      method('void', 'var s = new Sample();', 's._name = "x";', 's.Count = i;', 's.Other = s.Count;', 'Use(s);'),
      method('void', 'var s = new Sample()', '{', '    _name = "x",', '    Count = i', '};', 's.Other = s.Count;', 'Use(s);')
    );
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

  it('leaves explicitly typed locals to collection expressions when those are preferred', () => {
    const source = method('void', 'List<int> list = new List<int>();', 'list.Add(1);');

    expect(codeStyle(source, 'dotnet_style_collection_initializer = true:warning\ndotnet_style_prefer_collection_expression = true:warning')).toBe(source);
  });
});
