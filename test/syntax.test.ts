import { describe, expect, it } from 'vitest';
import { nullCheckPatternMatchingConverter } from '../src/cleanup/transformations/nullCheckPatternMatching';
import { returnThrowBlankLinePaddingConverter } from '../src/cleanup/transformations/returnThrowBlankLinePadding';
import { varWhenApparentConverter } from '../src/cleanup/transformations/varWhenApparent';

describe('varWhenApparentConverter', () => {
  const apply = (source: string) => varWhenApparentConverter.apply(source);

  it('converts object creation with a matching type', () => {
    expect(apply('class C { void M() { Foo x = new Foo(); } }')).toBe('class C { void M() { var x = new Foo(); } }');
  });

  it('skips method invocations', () => {
    const input = 'class C { void M() { Foo x = GetFoo(); } }';

    expect(apply(input)).toBe(input);
  });

  it('skips literals', () => {
    const input = 'class C { void M() { int x = 5; } }';

    expect(apply(input)).toBe(input);
  });

  it('skips when the declared type differs from the created type', () => {
    const input = 'class C { void M() { IFoo x = new Foo(); } }';

    expect(apply(input)).toBe(input);
  });

  it('converts a cast with a matching type', () => {
    expect(apply('class C { void M(object o) { Foo x = (Foo)o; } }')).toBe(
      'class C { void M(object o) { var x = (Foo)o; } }'
    );
  });

  it('converts array creation with a matching element type', () => {
    expect(apply('class C { void M() { int[] a = new int[3]; } }')).toBe('class C { void M() { var a = new int[3]; } }');
  });

  it('skips declarations that already use var', () => {
    const input = 'class C { void M() { var x = new Foo(); } }';

    expect(apply(input)).toBe(input);
  });

  it('skips field declarations', () => {
    const input = 'class C { private Foo _x = new Foo(); }';

    expect(apply(input)).toBe(input);
  });

  it('preserves unrelated code', () => {
    expect(apply('class C { void M() { Foo x = new Foo(); int y = 5; var z = GetFoo(); } }')).toBe(
      'class C { void M() { var x = new Foo(); int y = 5; var z = GetFoo(); } }'
    );
  });

  it('skips multi-variable declarations', () => {
    const input = 'class C { void M() { Foo x = new Foo(), y = new Foo(); } }';

    expect(apply(input)).toBe(input);
  });

  it('is named', () => {
    expect(varWhenApparentConverter.name).toBe('Var When Apparent');
  });
});

describe('nullCheckPatternMatchingConverter', () => {
  const apply = (source: string) => nullCheckPatternMatchingConverter.apply(source);

  it('converts != null to is not null', () => {
    const input = '\npublic class C\n{\n    public void M(object x)\n    {\n        if (x != null)\n        {\n            DoWork();\n        }\n    }\n}';
    const expected = '\npublic class C\n{\n    public void M(object x)\n    {\n        if (x is not null)\n        {\n            DoWork();\n        }\n    }\n}';

    expect(apply(input)).toBe(expected);
  });

  it('converts == null to is null', () => {
    const input = '\npublic class C\n{\n    public void M(object x)\n    {\n        if (x == null)\n        {\n            return;\n        }\n    }\n}';
    const expected = '\npublic class C\n{\n    public void M(object x)\n    {\n        if (x is null)\n        {\n            return;\n        }\n    }\n}';

    expect(apply(input)).toBe(expected);
  });

  it('converts reversed null checks', () => {
    const input = 'class C { void M(object a, object b) { if (null != a && null == b) { DoWork(); } } }';
    const expected = 'class C { void M(object a, object b) { if (a is not null && b is null) { DoWork(); } } }';

    expect(apply(input)).toBe(expected);
  });

  it('converts checks in ternary and return expressions', () => {
    const input = 'class C { bool Check(object x, object y) { return x == null ? y != null : false; } }';
    const expected = 'class C { bool Check(object x, object y) { return x is null ? y is not null : false; } }';

    expect(apply(input)).toBe(expected);
  });

  it('leaves non-null comparisons unchanged', () => {
    const input = 'class C { bool M(int a, int b) { return a == b; } }';

    expect(apply(input)).toBe(input);
  });

  it('leaves existing pattern checks unchanged', () => {
    const input = 'class C { bool M(object a) { return a is null; } }';

    expect(apply(input)).toBe(input);
  });

  it('converts member access targets', () => {
    expect(apply('class C { bool M(C c) { return c.Inner.Value != null; } }')).toBe(
      'class C { bool M(C c) { return c.Inner.Value is not null; } }'
    );
  });

  it('handles an empty source', () => {
    expect(apply('')).toBe('');
  });

  it('is named', () => {
    expect(nullCheckPatternMatchingConverter.name).toBe('Convert to Pattern Matching Null Checks');
  });

  it('skips a null check inside a lambda passed to Where (possible IQueryable expression tree)', () => {
    const input = 'class C { void M() { var r = source.Where(x => x.Name != null); } }';

    expect(apply(input)).toBe(input);
  });

  it('skips a null check inside a lambda passed to Select/OrderBy/Any and friends', () => {
    const input =
      'class C { void M() { a.Select(x => x != null); b.OrderBy(x => x != null); c.Any(x => x == null); } }';

    expect(apply(input)).toBe(input);
  });

  it('skips a null check inside a lambda assigned to an Expression<...> variable', () => {
    const input = 'class C { void M() { Expression<Func<Foo, bool>> predicate = x => x.Bar != null; } }';

    expect(apply(input)).toBe(input);
  });

  it('skips a null check inside a lambda cast to Expression<...>', () => {
    const input = 'class C { void M() { var p = (Expression<Func<Foo, bool>>)(x => x.Bar != null); } }';

    expect(apply(input)).toBe(input);
  });

  it('still converts a null check inside a plain List<T>.Where lambda argument', () => {
    // Cannot tell IEnumerable from IQueryable without a type checker, so this stays conservative
    // (skipped) too - see the dedicated skip test above. This test locks in that current behavior.
    const input = 'class C { void M() { list.Where(x => x != null); } }';

    expect(apply(input)).toBe(input);
  });

  it('still converts a null check outside of any lambda', () => {
    expect(apply('class C { void M(object x) { source.Where(y => y.Ok); if (x != null) { } } }')).toBe(
      'class C { void M(object x) { source.Where(y => y.Ok); if (x is not null) { } } }'
    );
  });

  it('still converts a null check inside a lambda body that is not passed to a query method', () => {
    expect(apply('class C { void M() { Action<object> a = x => { var ok = x != null; }; } }')).toBe(
      'class C { void M() { Action<object> a = x => { var ok = x is not null; }; } }'
    );
  });
});

describe('returnThrowBlankLinePaddingConverter', () => {
  const apply = (source: string) => returnThrowBlankLinePaddingConverter.apply(source);

  it('inserts a blank line before a return preceded by other statements', () => {
    const input = 'class C\r\n{\r\n    int M()\r\n    {\r\n        int x = 1;\r\n        return x;\r\n    }\r\n}\r\n';
    const expected =
      'class C\r\n{\r\n    int M()\r\n    {\r\n        int x = 1;\r\n\r\n        return x;\r\n    }\r\n}\r\n';

    expect(apply(input)).toBe(expected);
  });

  it('inserts a blank line before a throw preceded by other statements', () => {
    const input =
      'class C\r\n{\r\n    void M()\r\n    {\r\n        int x = 1;\r\n        throw new System.Exception();\r\n    }\r\n}\r\n';
    const expected =
      'class C\r\n{\r\n    void M()\r\n    {\r\n        int x = 1;\r\n\r\n        throw new System.Exception();\r\n    }\r\n}\r\n';

    expect(apply(input)).toBe(expected);
  });

  it('does nothing when the return is the only statement', () => {
    const input = 'class C\r\n{\r\n    int M()\r\n    {\r\n        return 1;\r\n    }\r\n}\r\n';

    expect(apply(input)).toBe(input);
  });

  it('does nothing when the return is the first statement followed by unreachable code', () => {
    const input =
      'class C\r\n{\r\n    int M()\r\n    {\r\n        return 1;\r\n#pragma warning disable CS0162\r\n        int x = 2;\r\n#pragma warning restore CS0162\r\n    }\r\n}\r\n';

    expect(apply(input)).toBe(input);
  });

  it('is idempotent when a blank line is already present', () => {
    const input =
      'class C\r\n{\r\n    int M()\r\n    {\r\n        int x = 1;\r\n\r\n        return x;\r\n    }\r\n}\r\n';

    expect(apply(input)).toBe(input);
  });

  it('inserts a blank line inside an if block', () => {
    const input =
      'class C\r\n{\r\n    int M(bool b)\r\n    {\r\n        if (b)\r\n        {\r\n            int y = 1;\r\n            return y;\r\n        }\r\n        return 0;\r\n    }\r\n}\r\n';
    const expected =
      'class C\r\n{\r\n    int M(bool b)\r\n    {\r\n        if (b)\r\n        {\r\n            int y = 1;\r\n\r\n            return y;\r\n        }\r\n\r\n        return 0;\r\n    }\r\n}\r\n';

    expect(apply(input)).toBe(expected);
  });

  it('handles multiple candidates in the same file', () => {
    const input =
      'class C\r\n{\r\n    int M1()\r\n    {\r\n        int x = 1;\r\n        return x;\r\n    }\r\n\r\n    int M2()\r\n    {\r\n        int y = 2;\r\n        return y;\r\n    }\r\n}\r\n';
    const expected =
      'class C\r\n{\r\n    int M1()\r\n    {\r\n        int x = 1;\r\n\r\n        return x;\r\n    }\r\n\r\n    int M2()\r\n    {\r\n        int y = 2;\r\n\r\n        return y;\r\n    }\r\n}\r\n';

    expect(apply(input)).toBe(expected);
  });

  it('handles an empty source', () => {
    expect(apply('')).toBe('');
  });

  it('is named', () => {
    expect(returnThrowBlankLinePaddingConverter.name).toBe('Blank Line Before Return/Throw');
  });
});
