import { describe, expect, it } from 'vitest';
import {
  collectionExpressionConverter,
  stringInterpolationConverter,
} from '../src/cleanup/transformations/formatAndCollections';

// ---------------------------------------------------------------- string interpolation

describe('stringInterpolationConverter', () => {
  const apply = (source: string) => stringInterpolationConverter.apply(source);

  it('converts string.Format with a single placeholder', () => {
    expect(apply('class C { void M() { var s = string.Format("Hello {0}", name); } }')).toBe(
      'class C { void M() { var s = $"Hello {name}"; } }'
    );
  });

  it('converts String.Format (capital S)', () => {
    expect(apply('class C { void M() { var s = String.Format("{0}", x); } }')).toBe(
      'class C { void M() { var s = $"{x}"; } }'
    );
  });

  it('converts System.String.Format', () => {
    expect(apply('class C { void M() { var s = System.String.Format("{0}", x); } }')).toBe(
      'class C { void M() { var s = $"{x}"; } }'
    );
  });

  it('handles multiple placeholders', () => {
    expect(apply('class C { void M() { var s = string.Format("{0} and {1}", a, b); } }')).toBe(
      'class C { void M() { var s = $"{a} and {b}"; } }'
    );
  });

  it('handles alignment specifier', () => {
    expect(apply('class C { void M() { var s = string.Format("{0,5}", x); } }')).toBe(
      'class C { void M() { var s = $"{x,5}"; } }'
    );
  });

  it('handles format specifier', () => {
    expect(apply('class C { void M() { var s = string.Format("{0:N2}", x); } }')).toBe(
      'class C { void M() { var s = $"{x:N2}"; } }'
    );
  });

  it('handles alignment and format together', () => {
    expect(apply('class C { void M() { var s = string.Format("{0,-10:C}", x); } }')).toBe(
      'class C { void M() { var s = $"{x,-10:C}"; } }'
    );
  });

  it('escapes quotes in the format string', () => {
    expect(apply('class C { void M() { var s = string.Format("say \\"hi\\" {0}", x); } }')).toBe(
      'class C { void M() { var s = $"say \\"hi\\" {x}"; } }'
    );
  });

  it('escapes newlines in the format string', () => {
    expect(apply('class C { void M() { var s = string.Format("line1\\n{0}", x); } }')).toBe(
      'class C { void M() { var s = $"line1\\n{x}"; } }'
    );
  });

  it('escapes tabs in the format string', () => {
    expect(apply('class C { void M() { var s = string.Format("col\\t{0}", x); } }')).toBe(
      'class C { void M() { var s = $"col\\t{x}"; } }'
    );
  });

  it('handles unicode escape in format string', () => {
    expect(apply('class C { void M() { var s = string.Format("caf\\u00e9 {0}", x); } }')).toBe(
      'class C { void M() { var s = $"café {x}"; } }'
    );
  });

  it('skips when format string has no placeholders', () => {
    const input = 'class C { void M() { var s = string.Format("no placeholders", x); } }';

    expect(apply(input)).toBe(input);
  });

  it('skips when placeholder index exceeds args', () => {
    const input = 'class C { void M() { var s = string.Format("{0} {5}", a); } }';

    expect(apply(input)).toBe(input);
  });

  it('skips non-literal format strings', () => {
    const input = 'class C { void M() { var s = string.Format(fmt, x); } }';

    expect(apply(input)).toBe(input);
  });

  it('skips single-argument Format calls', () => {
    const input = 'class C { void M() { var s = string.Format("{0}"); } }';

    expect(apply(input)).toBe(input);
  });

  it('skips method calls that are not string.Format', () => {
    const input = 'class C { void M() { var s = Console.WriteLine("{0}", x); } }';

    expect(apply(input)).toBe(input);
  });

  it('skips when receiver is not a string type', () => {
    const input = 'class C { void M() { var s = MyString.Format("{0}", x); } }';

    expect(apply(input)).toBe(input);
  });

  it('handles empty source', () => {
    expect(apply('')).toBe('');
  });

  it('handles whitespace-only source', () => {
    expect(apply('  \n  ')).toBe('  \n  ');
  });

  it('handles verbatim format string', () => {
    expect(apply('class C { void M() { var s = string.Format(@"path\\{0}", x); } }')).toBe(
      'class C { void M() { var s = $"path\\{x}"; } }'
    );
  });

  it('converts format string with escaped backslash', () => {
    const input = 'class C { void M() { var s = string.Format("C:\\\\{0}", x); } }';

    // The converter decodes \\ to \ and produces an interpolated string with a bare backslash
    expect(apply(input)).toBe('class C { void M() { var s = $"C:\\{x}"; } }');
  });

  it('handles escaped single quote in format', () => {
    expect(apply('class C { void M() { var s = string.Format("it\'s {0}", x); } }')).toBe(
      'class C { void M() { var s = $"it\'s {x}"; } }'
    );
  });

  it('handles carriage return escape', () => {
    expect(apply('class C { void M() { var s = string.Format("line\\r{0}", x); } }')).toBe(
      'class C { void M() { var s = $"line\\r{x}"; } }'
    );
  });

  it('converts format string with null character escape', () => {
    const input = 'class C { void M() { var s = string.Format("null\\0{0}", x); } }';

    // The converter decodes \0 to null character and produces an interpolated string with it
    expect(apply(input)).toBe('class C { void M() { var s = $"null\0{x}"; } }');
  });

  it('is named', () => {
    expect(stringInterpolationConverter.name).toBe('Convert string.Format to String Interpolation');
  });
});

// ---------------------------------------------------------------- collection expressions

describe('collectionExpressionConverter', () => {
  const apply = (source: string) => collectionExpressionConverter.apply(source);

  it('converts new int[] { 1, 2 } to collection expression', () => {
    expect(apply('class C { int[] a = new int[] { 1, 2 }; }')).toBe('class C { int[] a = [1, 2]; }');
  });

  it('converts new List<int> { 1, 2 } to collection expression', () => {
    expect(apply('class C { List<int> l = new List<int> { 1, 2 }; }')).toBe(
      'class C { List<int> l = [1, 2]; }'
    );
  });

  it('converts new string[] { "a", "b" } to collection expression', () => {
    expect(apply('class C { string[] s = new string[] { "a", "b" }; }')).toBe(
      'class C { string[] s = ["a", "b"]; }'
    );
  });

  it('converts new List<string>() to empty collection expression', () => {
    expect(apply('class C { List<string> l = new List<string>(); }')).toBe('class C { List<string> l = []; }');
  });

  it('converts implicit array creation to collection expression', () => {
    expect(apply('class C { int[] a = new[] { 1, 2 }; }')).toBe('class C { int[] a = [1, 2]; }');
  });

  it('converts zero-length array to empty collection expression', () => {
    expect(apply('class C { int[] a = new int[0]; }')).toBe('class C { int[] a = []; }');
  });

  it('skips non-zero-length array without initializer', () => {
    const input = 'class C { int[] a = new int[5]; }';

    expect(apply(input)).toBe(input);
  });

  it('skips List<T> with constructor arguments', () => {
    const input = 'class C { List<int> l = new List<int>(capacity); }';

    expect(apply(input)).toBe(input);
  });

  it('skips when declared type does not match created type', () => {
    const input = 'class C { IList<int> l = new List<int> { 1, 2 }; }';

    expect(apply(input)).toBe(input);
  });

  it('skips array of different element type', () => {
    const input = 'class C { string[] s = new int[] { 1, 2 }; }';

    expect(apply(input)).toBe(input);
  });

  it('converts property initializer', () => {
    expect(apply('class C { int[] Prop { get; } = new int[] { 1, 2 }; }')).toBe(
      'class C { int[] Prop { get; } = [1, 2]; }'
    );
  });

  it('skips expression-bodied property (not an initializer)', () => {
    const input = 'class C { int[] Prop => new int[] { 1, 2 }; }';

    expect(apply(input)).toBe(input);
  });

  it('handles empty source', () => {
    expect(apply('')).toBe('');
  });

  it('is named', () => {
    expect(collectionExpressionConverter.name).toBe('Collection Expression');
  });
});
