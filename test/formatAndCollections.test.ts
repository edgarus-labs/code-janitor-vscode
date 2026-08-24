import { beforeAll, describe, expect, it } from 'vitest';
import { initCSharpParser } from '../src/cleanup/parser';
import {
  collectionExpressionConverter,
  stringInterpolationConverter,
} from '../src/cleanup/transformations/formatAndCollections';

beforeAll(async () => {
  await initCSharpParser();
});

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
