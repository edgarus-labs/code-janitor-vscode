import { describe, expect, it } from 'vitest';
import { reorganize } from './helpers/reorganize';

/**
 * Field and property initializers run in declaration order, so members whose initializers depend
 * on that order must keep their relative order; everything else is sorted as usual.
 */
function members(result: string): string[] {
  return [...result.matchAll(/^\s+(?:public |private |static |readonly |const )*[\w<>\[\], ()?]+ (\w+)(?: =|;| \{|\()/gm)].map((match) => match[1]);
}

describe('reorganize: initializers that depend on declaration order', () => {
  it('sorts fields with constant initializers freely', () => {
    const source = 'class C\n{\n    static int B = 2;\n    static int A = 1;\n    static string S = "s" + "t";\n}\n';

    expect(members(reorganize(source))).toEqual(['A', 'B', 'S']);
  });

  it('keeps a static field before the static fields whose initializers read it', () => {
    const source = 'class C\n{\n    static int B = A + 1;\n    static int A = 1;\n}\n';
    // B reads A, which is declared after it: that read sees the default, so the order is part of the behaviour.
    expect(members(reorganize(source))).toEqual(['B', 'A']);
  });

  it('keeps a static field before the one that reads it even if a name sorts the other way', () => {
    const source = 'class C\n{\n    static int Z = 1;\n    static int A = Z * 2;\n}\n';

    expect(members(reorganize(source))).toEqual(['Z', 'A']);
  });

  it('follows a read through this, the type name and string interpolation', () => {
    const viaThis = 'class C\n{\n    static int Z = 1;\n    static int A = C.Z;\n}\n';
    const interpolated = 'class C\n{\n    static int Z = 1;\n    static string A = $"{Z}";\n}\n';

    expect(members(reorganize(viaThis))).toEqual(['Z', 'A']);
    expect(members(reorganize(interpolated))).toEqual(['Z', 'A']);
  });

  it('does not move a static field across one whose initializer runs code', () => {
    const source = 'class C\n{\n    static int Z = 1;\n    static int M = Compute();\n    static int A = 2;\n    static int Compute() => Z;\n}\n';

    expect(members(reorganize(source))).toEqual(['Z', 'M', 'A', 'Compute']);
  });

  it('does not move a static field across an initializer that creates a user-defined object', () => {
    const source = 'class C\n{\n    static int Z = 1;\n    static Widget W = new Widget();\n    static int A = 2;\n}\n';

    expect(members(reorganize(source))).toEqual(['Z', 'W', 'A']);
  });

  it('treats library collections, lambdas and pure static calls as free of side effects', () => {
    const source =
      'class C\n{\n    static Func<int> Z = () => Other;\n    static List<int> L = new List<int>();\n    static object Lock = new object();\n    static int M = Math.Max(1, 2);\n    static int A = 2;\n}\n';

    expect(members(reorganize(source))).toEqual(['A', 'L', 'Lock', 'M', 'Z']);
  });

  it('keeps instance initializers that run code in order', () => {
    const source = 'class C\n{\n    int Z = Next();\n    int A = Next();\n    static int Next() => 1;\n}\n';

    expect(members(reorganize(source))).toEqual(['Z', 'A', 'Next']);
  });

  it('sorts instance fields with pure initializers', () => {
    const source = 'class C\n{\n    int Z = 1;\n    int A = 2;\n}\n';

    expect(members(reorganize(source))).toEqual(['A', 'Z']);
  });

  it('keeps a property with an initializer in order with fields that run code', () => {
    const source = 'class C\n{\n    public static int Count { get; } = Make();\n    static int _b = 2;\n    static int _a = 1;\n    static int Make() => _b;\n}\n';
    const result = reorganize(source);

    // Count runs code that may read any static, so neither field may move above it.
    expect(members(result)).toEqual(['Count', '_a', '_b', 'Make']);
  });

  it('keeps a field before an initializer that reads a computed property, which may read the field', () => {
    const source = 'class C\n{\n    static int A = Twice;\n    static int Twice => Z * 2;\n    static int Z = 1;\n}\n';

    expect(members(reorganize(source))).toEqual(['A', 'Z', 'Twice']);
  });

  it('does not move a static field across an initializer reading a name declared outside this type body', () => {
    // Y2 may be a computed property of another partial part, a base class or a `using static` type
    // that reads A: moving A above X would change what X sees.
    const partial = 'partial class C\n{\n    static int X = Y2;\n    static int A = 5;\n}\n';
    const inherited = 'class C : B\n{\n    static int X = C.Y2 + 1;\n    static int A = 5;\n}\n';

    expect(members(reorganize(partial))).toEqual(['X', 'A']);
    expect(members(reorganize(inherited))).toEqual(['X', 'A']);
  });

  it('sorts static fields reading library enum values', () => {
    const regex = 'class C\n{\n    static Regex Z = new Regex("a", RegexOptions.CultureInvariant | RegexOptions.Compiled);\n    static int A = 5;\n}\n';
    const flags = 'class C\n{\n    static BindingFlags Z = BindingFlags.Public | BindingFlags.Static;\n    static int A = 5;\n}\n';

    expect(members(reorganize(regex))).toEqual(['A', 'Z']);
    expect(members(reorganize(flags))).toEqual(['A', 'Z']);
  });

  it('sorts static fields reading values of an enum declared in this type or an enclosing scope', () => {
    const nested = 'class C\n{\n    enum Mode { Fast }\n    static Mode Z = Mode.Fast;\n    static int A = 5;\n}\n';
    const enclosing = 'enum Level { High }\nclass C\n{\n    private Level _z = Level.High;\n    private int _a = Next();\n    static int Next() => 1;\n}\n';

    expect(members(reorganize(nested))).toEqual(['A', 'Z', 'Mode']);
    expect(members(reorganize(enclosing))).toEqual(['_a', '_z', 'Next']);
  });

  it('does not treat a nested class, or a type that may shadow an enum, as pure', () => {
    // A static property of a nested class runs its accessor (and static constructor), which may read A.
    const nestedClass = 'class C\n{\n    class Mode { public static int Fast => A; }\n    static int Z = Mode.Fast;\n    static int A = 5;\n}\n';
    const shadowed = 'enum Mode { Fast }\nclass C\n{\n    class Mode { public static int Fast => A; }\n    static int Z = Mode.Fast;\n    static int A = 5;\n}\n';
    // A nested type of the base class or of another partial part shadows the outer enum.
    const inherited = 'enum Mode { Fast }\nclass C : B\n{\n    static int Z = Mode.Fast;\n    static int A = 5;\n}\n';
    const partial = 'enum Mode { Fast }\npartial class C\n{\n    static int Z = Mode.Fast;\n    static int A = 5;\n}\n';

    expect(members(reorganize(nestedClass))).toEqual(['Z', 'A', 'Mode']);
    expect(members(reorganize(shadowed))).toEqual(['Z', 'A', 'Mode']);
    expect(members(reorganize(inherited))).toEqual(['Z', 'A']);
    expect(members(reorganize(partial))).toEqual(['Z', 'A']);
  });

  it('does not read the alignment and format of an interpolation hole as names', () => {
    const format = 'class C\n{\n    const double V = 1;\n    static string Z = $"{V:N2}";\n    static int A = 5;\n}\n';
    const date = 'class C\n{\n    static readonly DateTime D;\n    static string Z = $"{D,10:yyyy-MM-dd}";\n    static int A = 5;\n}\n';

    expect(members(reorganize(format))).toEqual(['V', 'A', 'Z']);
    expect(members(reorganize(date))).toEqual(['D', 'A', 'Z']);
  });

  it('applies the constraints to the members of a #if block', () => {
    const source = 'class C\n{\n    static int Z = 1;\n#if X\n    static int A = Z;\n#endif\n}\n';

    expect(members(reorganize(source, { performWhenPreprocessorConditionals: 'yes' }))).toEqual(['Z', 'A']);
  });

  it('still sorts fields without initializers around constrained ones', () => {
    const source = 'class C\n{\n    static int Z = 1;\n    static int M;\n    static int A = Z;\n    static int B;\n}\n';

    expect(members(reorganize(source))).toEqual(['B', 'M', 'Z', 'A']);
  });

  it('does not order constants by their dependencies', () => {
    const source = 'class C\n{\n    const int B = A + 1;\n    const int A = 1;\n}\n';

    expect(members(reorganize(source))).toEqual(['A', 'B']);
  });
});
