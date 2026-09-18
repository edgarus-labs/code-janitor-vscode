import { describe, expect, it } from 'vitest';
import {
  readonlyFieldConverter,
  updateSingleLineMethodsConverter,
} from '../src/cleanup/transformations/readonlyFieldAndSingleLineMethods';

describe('readonlyFieldConverter', () => {
  const apply = (source: string) => readonlyFieldConverter.apply(source);

  it('marks a field assigned only in the constructor', () => {
    expect(apply('class C { private int _x; public C() { _x = 1; } }')).toBe(
      'class C { private readonly int _x; public C() { _x = 1; } }'
    );
  });

  it('marks a field that only has an initializer', () => {
    expect(apply('class C { private int _x = 5; void M() { var y = _x; } }')).toBe(
      'class C { private readonly int _x = 5; void M() { var y = _x; } }'
    );
  });

  it('leaves a field assigned in a regular method mutable', () => {
    const input = 'class C { private int _x; void M() { _x = 1; } }';

    expect(apply(input)).toBe(input);
  });

  it('leaves a field passed as a ref argument in the constructor mutable', () => {
    const input = 'class C { private int _x; public C() { Helper(ref _x); } }';

    expect(apply(input)).toBe(input);
  });

  it('leaves a field passed as an out argument in the constructor mutable', () => {
    const input = 'class C { private int _x; public C() { Helper(out _x); } }';

    expect(apply(input)).toBe(input);
  });

  it('leaves a field whose member is passed by ref mutable', () => {
    const input = 'class C { private Point _pt; void M() { Helper(ref _pt.X); } }';

    expect(apply(input)).toBe(input);
  });

  it('leaves a field whose member is passed by out mutable', () => {
    const input = 'class C { private Point _pt; void M() { int.TryParse("1", out _pt.X); } }';

    expect(apply(input)).toBe(input);
  });

  it('leaves a deep member passed by ref mutable', () => {
    const input = 'class C { private Nested _n; void M() { Helper(ref this._n.Deep.Value); } }';

    expect(apply(input)).toBe(input);
  });

  it('leaves a field whose member is assigned in a method mutable', () => {
    const input = 'class C { private Point _pt; void M() { _pt.X = 10; } }';

    expect(apply(input)).toBe(input);
  });

  it('leaves a field whose member is incremented in a method mutable', () => {
    const input = 'class C { private Point _pt; void M() { _pt.X++; } }';

    expect(apply(input)).toBe(input);
  });

  it('leaves an array element passed by ref mutable', () => {
    const input = 'class C { private int[] _arr; void M() { Helper(ref _arr[0]); } }';

    expect(apply(input)).toBe(input);
  });

  it('leaves a field assigned through another instance mutable', () => {
    const input = 'class C { private int _x; void M(C other) { other._x = 1; } }';

    expect(apply(input)).toBe(input);
  });

  it('leaves a field returned by a ref property mutable', () => {
    const input = 'class C { private int _x; public ref int X => ref _x; }';

    expect(apply(input)).toBe(input);
  });

  it('leaves a field returned by a ref method mutable', () => {
    const input = 'class C { private int _x; public ref int M() { return ref _x; } }';

    expect(apply(input)).toBe(input);
  });

  it('leaves a field with a compound assignment in a method mutable', () => {
    const input = 'class C { private int _x; void M() { _x += 1; } }';

    expect(apply(input)).toBe(input);
  });

  it('leaves an already readonly field unchanged', () => {
    const input = 'class C { private readonly int _x; public C() { _x = 1; } }';

    expect(apply(input)).toBe(input);
  });

  it('leaves a const field unchanged', () => {
    const input = 'class C { private const int _x = 1; }';

    expect(apply(input)).toBe(input);
  });

  it('marks a static field assigned in the static constructor', () => {
    expect(apply('class C { private static int _x; static C() { _x = 1; } }')).toBe(
      'class C { private static readonly int _x; static C() { _x = 1; } }'
    );
  });

  it('leaves a field assigned inside a lambda in the constructor mutable', () => {
    expect(
      apply('class C { private System.Action _a; private int _x; public C() { _a = () => { _x = 1; }; } }')
    ).toBe('class C { private readonly System.Action _a; private int _x; public C() { _a = () => { _x = 1; }; } }');
  });

  it('leaves fields of a partial class unchanged', () => {
    const input = 'partial class C { private int _x; public C() { _x = 1; } }';

    expect(apply(input)).toBe(input);
  });

  it('leaves a public field mutable', () => {
    const input = 'class C { public int X; public C() { X = 1; } }';

    expect(apply(input)).toBe(input);
  });

  it('leaves a multi-variable declaration unchanged', () => {
    const input = 'class C { private int _x, _y; public C() { _x = 1; _y = 2; } }';

    expect(apply(input)).toBe(input);
  });

  it('leaves a field mutated by a nested type mutable', () => {
    const input =
      'class C { private static int _x; static C() { _x = 1; } private class Inner { public static void M() { _x = 2; } } }';

    expect(apply(input)).toBe(input);
  });

  it('leaves a field mutated via a ref argument from a nested type mutable', () => {
    const input =
      'class C { private int _x; public C() { _x = 1; } private class Inner { private readonly C _outer; public Inner(C outer) { _outer = outer; } public void M() { Interlocked.Increment(ref _outer._x); } } }';

    expect(apply(input)).toBe(input);
  });

  it('leaves a field whose address is taken mutable', () => {
    const input = 'class C { private int _x; public C() { _x = 1; } public unsafe void M() { var p = &_x; } }';

    expect(apply(input)).toBe(input);
  });

  it('leaves a field whose address is taken as an argument mutable', () => {
    const input = 'class C { private int _x; public C() { _x = 1; } public unsafe void M() { Helper(&_x); } }';

    expect(apply(input)).toBe(input);
  });

  it('leaves a field whose member is pre-incremented in a method mutable', () => {
    const input = 'class C { private Point _pt; void M() { ++_pt.X; } }';

    expect(apply(input)).toBe(input);
  });

  it('handles an empty source', () => {
    expect(apply('')).toBe('');
  });

  it('is named', () => {
    expect(readonlyFieldConverter.name).toBe('Readonly Field');
  });
});

describe('updateSingleLineMethodsConverter', () => {
  const apply = (source: string) => updateSingleLineMethodsConverter.apply(source);

  it('spreads a single-line method body over multiple lines', () => {
    expect(apply('public class MyClass { public void MyMethod() { return; } }')).toBe(
      'public class MyClass { public void MyMethod() {\n    return;\n} }'
    );
  });

  it('leaves a multi-line method unchanged', () => {
    const input =
      'public class MyClass\r\n{\r\n    public void MyMethod()\r\n    {\r\n        return;\r\n    }\r\n}';

    expect(apply(input)).toBe(input);
  });

  it('leaves a class without methods unchanged', () => {
    const input = 'public class MyClass { }';

    expect(apply(input)).toBe(input);
  });

  it('leaves an abstract method unchanged', () => {
    const input = 'public abstract class MyClass { public abstract void MyMethod(); }';

    expect(apply(input)).toBe(input);
  });

  it('leaves an interface method unchanged', () => {
    const input = 'public interface IMyInterface { void MyMethod(); }';

    expect(apply(input)).toBe(input);
  });

  it('leaves an empty body unchanged', () => {
    const input = 'class C { void M() { } }';

    expect(apply(input)).toBe(input);
  });

  it('handles an empty source', () => {
    expect(apply('')).toBe('');
  });

  it('is named', () => {
    expect(updateSingleLineMethodsConverter.name).toBe('Update single-line methods');
  });
});
