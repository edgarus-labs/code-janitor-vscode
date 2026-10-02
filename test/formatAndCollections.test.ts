import { describe, expect, it } from 'vitest';
import {
  collectionExpressionConverter,
  stringInterpolationConverter,
} from '../src/cleanup/transformations/formatAndCollections';

describe('stringInterpolationConverter', () => {
  const apply = (source: string) => stringInterpolationConverter.apply(source);

  it('converts a simple string.Format call', () => {
    expect(
      apply(
        'public class C\n{\n    public string M(string name, int count)\n    {\n        return string.Format("Hello {0}, you have {1} messages.", name, count);\n    }\n}'
      )
    ).toBe(
      'public class C\n{\n    public string M(string name, int count)\n    {\n        return $"Hello {name}, you have {count} messages.";\n    }\n}'
    );
  });

  it('keeps a format specifier', () => {
    expect(
      apply(
        'public class C\n{\n    public string M(double price)\n    {\n        return string.Format("Price: {0:C2}", price);\n    }\n}'
      )
    ).toBe(
      'public class C\n{\n    public string M(double price)\n    {\n        return $"Price: {price:C2}";\n    }\n}'
    );
  });

  it('keeps an alignment', () => {
    expect(
      apply(
        'public class C\n{\n    public string M(int id)\n    {\n        return string.Format("ID: {0,5}", id);\n    }\n}'
      )
    ).toBe('public class C\n{\n    public string M(int id)\n    {\n        return $"ID: {id,5}";\n    }\n}');
  });

  it('skips a non-literal format string', () => {
    const input = 'class C { string M(string format, int x) { return string.Format(format, x); } }';

    expect(apply(input)).toBe(input);
  });

  it('skips calls with no placeholders', () => {
    const input = 'class C { string M(int x) { return string.Format("no placeholders", x); } }';

    expect(apply(input)).toBe(input);
  });

  it('skips placeholders that are out of range', () => {
    const input = 'class C { string M(int x) { return string.Format("{0} {1}", x); } }';

    expect(apply(input)).toBe(input);
  });

  it('skips Format on another receiver', () => {
    const input = 'class C { string M(int x) { return Formatter.Format("{0}", x); } }';

    expect(apply(input)).toBe(input);
  });

  it('converts a fully qualified String.Format call', () => {
    expect(apply('class C { string M(int x) { return System.String.Format("{0}!", x); } }')).toBe(
      'class C { string M(int x) { return $"{x}!"; } }'
    );
  });

  it('handles an empty source', () => {
    expect(apply('')).toBe('');
  });

  it('is named', () => {
    expect(stringInterpolationConverter.name).toBe('Convert string.Format to String Interpolation');
  });
});

describe('collectionExpressionConverter', () => {
  const apply = (source: string) => collectionExpressionConverter.apply(source);

  it('converts an empty list field initialization', () => {
    expect(apply('class C { private readonly List<string> _items = new List<string>(); }')).toBe(
      'class C { private readonly List<string> _items = []; }'
    );
  });

  it('converts a list with initializer elements', () => {
    expect(apply('class C { void M() { List<string> items = new List<string>() { "a", "b" }; } }')).toBe(
      'class C { void M() { List<string> items = ["a", "b"]; } }'
    );
  });

  it('converts a local list declaration', () => {
    expect(apply('class C { void M() { List<int> x = new List<int>(); } }')).toBe(
      'class C { void M() { List<int> x = []; } }'
    );
  });

  it('converts an array with initializer elements', () => {
    expect(apply('class C { void M() { int[] a = new int[] { 1, 2, 3 }; } }')).toBe(
      'class C { void M() { int[] a = [1, 2, 3]; } }'
    );
  });

  it('converts an explicitly empty array', () => {
    expect(apply('class C { void M() { int[] a = new int[0]; } }')).toBe('class C { void M() { int[] a = []; } }');
  });

  it('converts implicit array creation', () => {
    expect(apply('class C { void M() { int[] a = new[] { 1, 2, 3 }; } }')).toBe(
      'class C { void M() { int[] a = [1, 2, 3]; } }'
    );
  });

  it('converts an auto-property initializer', () => {
    expect(apply('class C { public List<string> Items { get; } = new List<string>(); }')).toBe(
      'class C { public List<string> Items { get; } = []; }'
    );
  });

  it('skips a list with constructor arguments', () => {
    const input = 'class C { void M() { List<string> x = new List<string>(10); } }';

    expect(apply(input)).toBe(input);
  });

  it('skips when the declared type differs from the created type', () => {
    const input = 'class C { void M() { IList<string> x = new List<string>(); } }';

    expect(apply(input)).toBe(input);
  });

  it('skips a sized array without an initializer', () => {
    const input = 'class C { void M() { int[] a = new int[5]; } }';

    expect(apply(input)).toBe(input);
  });

  it('skips a non-list generic type', () => {
    const input = 'class C { void M() { HashSet<string> x = new HashSet<string>(); } }';

    expect(apply(input)).toBe(input);
  });

  it('handles an empty source', () => {
    expect(apply('')).toBe('');
  });

  it('is named', () => {
    expect(collectionExpressionConverter.name).toBe('Collection Expression');
  });
});

describe('stringInterpolationConverter keeps the behavior of string.Format', () => {
  const apply = (body: string): string => stringInterpolationConverter.apply(`class C { string M(bool f, int n) => ${body}; int A() => 1; int B() => 2; }`);
  const unchanged = (body: string): void => {
    const input = `class C { string M(bool f, int n) => ${body}; int A() => 1; int B() => 2; }`;

    expect(stringInterpolationConverter.apply(input)).toBe(input);
  };

  it('parenthesizes a conditional expression: its colon would start a format specifier', () => {
    expect(apply('string.Format("{0}", f ? "a" : "b")')).toContain('$"{(f ? "a" : "b")}"');
  });

  it('keeps the alignment and format of a parenthesized conditional', () => {
    expect(apply('string.Format("{0,5:N1}", f ? 1.5 : 2.5)')).toContain('$"{(f ? 1.5 : 2.5),5:N1}"');
  });

  it('parenthesizes a conditional whose branches are verbatim or interpolated strings', () => {
    expect(apply('string.Format("{0}", f ? @"a\\" : "b")')).toContain('$"{(f ? @"a\\" : "b")}"');
    expect(apply('string.Format("{0}", f ? $@"{n}\\" : "b")')).toContain('$"{(f ? $@"{n}\\" : "b")}"');
  });

  it.each([
    ['an argument that is used twice', 'string.Format("{0}-{0}", A())'],
    ['arguments used out of order', 'string.Format("{1}{0}", A(), B())'],
    ['an argument that is never used', 'string.Format("{0}", 1, B())'],
    ['an object creation used twice', 'string.Format("{0}{0}", new object())'],
    ['an assignment used twice', 'string.Format("{0}{0}", n = 2)'],
    ['an interpolated string with a call used twice', 'string.Format("{0}{0}", $"{A()}")'],
    ['an @$ interpolated string with a backslash and a call used twice', 'string.Format("{0}{0}", @$"C:\\{A()}")'],
  ])('leaves %s alone: the call would run a different number of times or in another order', (_name, body) => {
    unchanged(body);
  });

  it('still converts arguments that run once, in order', () => {
    expect(apply('string.Format("{0}{1}", A(), B())')).toContain('$"{A()}{B()}"');
    expect(apply('string.Format("{0}", n++)')).toContain('$"{n++}"');
  });

  it('converts a pure argument that is used twice, out of order or not at all', () => {
    expect(apply('string.Format("{0}-{0}", n)')).toContain('$"{n}-{n}"');
    expect(apply('string.Format("{1}{0}", n, f)')).toContain('$"{f}{n}"');
    expect(apply('string.Format("{0}", n, 2)')).toContain('$"{n}"');
  });

  it('leaves a single array argument alone: it is the params array, not one value', () => {
    unchanged('string.Format("{0}{1}", new object[] { 1, 2 })');
  });
});
