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

  it('does not treat a name as an enum when an enclosing type declares a member of that name', () => {
    // Simple-name lookup binds `Mode` to Outer's property before the enum, so `Mode.Fast` runs Holder.Fast,
    // which reads Z: A must stay after Z.
    const source =
      'enum Mode { Fast }\nclass Holder { public int Fast => Outer.C.Z; }\nstatic class Outer\n{\n    static Holder Mode => new Holder();\n    public static class C\n    {\n        public static int Z = 5;\n        public static int A = Mode.Fast;\n    }\n}\n';
    const result = reorganize(source);

    expect(result.indexOf('int Z = 5')).toBeLessThan(result.indexOf('int A = Mode.Fast'));
  });

  it('does not read the alignment and format of an interpolation hole as names', () => {
    const format = 'class C\n{\n    const double V = 1;\n    static string Z = $"{V:N2}";\n    static int A = 5;\n}\n';
    const date = 'class C\n{\n    static readonly DateTime D;\n    static string Z = $"{D,10:yyyy-MM-dd}";\n    static int A = 5;\n}\n';

    expect(members(reorganize(format))).toEqual(['V', 'A', 'Z']);
    expect(members(reorganize(date))).toEqual(['D', 'A', 'Z']);
  });

  it('reads the names of an interpolation hole that contains braces', () => {
    // The switch subject Z is read: moving A above Z makes the hole see Z == 0.
    const switched = 'class C\n{\n    static int Z = 1;\n    static string A = $"{Z switch { 1 => 10, _ => 20 }}";\n}\n';

    expect(members(reorganize(switched))).toEqual(['Z', 'A']);
  });

  it('does not treat a property pattern, which runs getters, as free of side effects', () => {
    const source = 'struct S { public int P => C.A; }\nclass C\n{\n    static S s;\n    public static bool B = s is { P: 1 };\n    public static int A = 1;\n}\n';
    const result = reorganize(source);

    expect(result.indexOf('bool B')).toBeLessThan(result.indexOf('int A = 1'));
  });

  it('sorts static fields testing a type or constant pattern', () => {
    const source = 'class C\n{\n    static object o;\n    static bool Z = o is null;\n    static bool Y = o is string;\n    static int A = 5;\n}\n';

    expect(members(reorganize(source))).toEqual(['A', 'o', 'Y', 'Z']);
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

  it('keeps initializers that increment a field with postfix ++ or -- in order', () => {
    // Each `counter++` both reads and changes counter: swapping them swaps the values a and b get.
    const staticForm = 'class C\n{\n    static int counter;\n    static int b = counter++;\n    static int a = counter--;\n}\n';
    const instanceForm = 'class C\n{\n    static int counter;\n    int b = counter++;\n    int a = counter++;\n}\n';

    expect(members(reorganize(staticForm))).toEqual(['b', 'a', 'counter']);
    expect(members(reorganize(instanceForm))).toEqual(['counter', 'b', 'a']);
  });

  it('keeps an instance initializer reading a static field after one that runs code, which may change it', () => {
    const increment = 'class C\n{\n    static int counter;\n    int z = ++counter;\n    int b = counter;\n}\n';
    const call = 'class C\n{\n    static int counter = 0;\n    int z = Next();\n    int b = counter;\n    static int Next() => ++counter;\n}\n';

    expect(members(reorganize(increment))).toEqual(['counter', 'z', 'b']);
    expect(members(reorganize(call))).toEqual(['counter', 'z', 'b', 'Next']);
  });

  it('follows a read through the generic type name and treats another generic type as running code', () => {
    // B = C<T>.Z + 1 reads Z; G<int>.V may run G's static constructor, which may read Z.
    const self = 'class C<T>\n{\n    public static int Z = 1;\n    public static int B = C<T>.Z + 1;\n}\n';
    const other = 'class C\n{\n    public static int Z = 1;\n    public static int B = G<int>.V + 1;\n}\n';
    const library = 'class C\n{\n    public static int Z = 1;\n    public static EqualityComparer<int> B = EqualityComparer<int>.Default;\n}\n';

    expect(members(reorganize(self))).toEqual(['Z', 'B']);
    expect(members(reorganize(other))).toEqual(['Z', 'B']);
    expect(members(reorganize(library))).toEqual(['B', 'Z']);
  });

  it('keeps the parts of a partial type in order, since their initializers run in declaration order', () => {
    // B = A + 1 reads A from the earlier part: swapping the parts makes B read the default of A.
    const access = 'partial class C\n{\n    public static int A = 1;\n}\n\npublic partial class C\n{\n    public static int B = A + 1;\n}\n';
    const staticPart = 'partial class C\n{\n    public static int A = 1;\n}\n\nstatic partial class C\n{\n    public static int B = A + 1;\n}\n';
    const conditional = 'partial class C\n{\n    public static int A = 1;\n}\n\n#if DEBUG\npublic class Helper\n{\n}\n\npublic partial class C\n{\n    public static int B = A + 1;\n}\n#endif\n';

    expect(reorganize(access)).toBe(access);
    expect(reorganize(staticPart)).toBe(staticPart);
    expect(reorganize(conditional, { performWhenPreprocessorConditionals: 'yes' })).toBe(conditional);
  });

  it('treats a value converted to a type declared in the program as running a conversion operator', () => {
    // Alpha = 2 runs `implicit operator Meters(int)`, which reads Scale: Scale must stay before Alpha.
    const literal =
      'struct Meters\n{\n    static readonly int Scale = 10;\n    static readonly Meters Alpha = 2;\n    int value;\n    public static implicit operator Meters(int v) => new Meters { value = v * Scale };\n}\n';
    const cast = 'class C\n{\n    static int Scale = 10;\n    static Meters Alpha = (Meters)2;\n}\n';

    expect(members(reorganize(literal))).toEqual(['Scale', 'Alpha', 'value', 'Meters']);
    expect(members(reorganize(cast))).toEqual(['Scale', 'Alpha']);
  });
});
