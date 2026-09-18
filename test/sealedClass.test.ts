import { describe, expect, it } from 'vitest';
import { createSealedClassConverter, discoverDisqualifiedTypeNames, sealedClassConverter } from '../src/cleanup/transformations/sealedClass';

describe('sealedClassConverter', () => {
  const apply = (source: string) => sealedClassConverter.apply(source);

  it('seals an internal class with no derived type in the file', () => {
    expect(apply('internal class Foo { }')).toBe('internal sealed class Foo { }');
  });

  it('seals a class without an access modifier', () => {
    expect(apply('class Foo { }')).toBe('sealed class Foo { }');
  });

  it('leaves a base class of a type in the same file unsealed', () => {
    expect(apply('internal class Foo { } internal class Bar : Foo { }')).toBe(
      'internal class Foo { } internal sealed class Bar : Foo { }'
    );
  });

  it('leaves an already sealed class unchanged', () => {
    const input = 'internal sealed class Foo { }';

    expect(apply(input)).toBe(input);
  });

  it('leaves an abstract class unchanged', () => {
    const input = 'internal abstract class Foo { }';

    expect(apply(input)).toBe(input);
  });

  it('leaves a static class unchanged', () => {
    const input = 'internal static class Foo { }';

    expect(apply(input)).toBe(input);
  });

  it('leaves a partial class unchanged', () => {
    const input = 'internal partial class Foo { }';

    expect(apply(input)).toBe(input);
  });

  it('seals a public class', () => {
    expect(apply('public class Foo { }')).toBe('public sealed class Foo { }');
  });

  it('seals the derived class but not its base', () => {
    expect(apply('public class Animal { } public class Dog : Animal { }')).toBe(
      'public class Animal { } public sealed class Dog : Animal { }'
    );
  });

  it('seals a record class', () => {
    expect(apply('public record Person(string Name);')).toBe('public sealed record Person(string Name);');
  });

  it('leaves a record struct unchanged', () => {
    const input = 'public record struct Point(int X, int Y);';

    expect(apply(input)).toBe(input);
  });

  it('seals a class implementing an interface', () => {
    expect(apply('internal class Foo : System.IDisposable { public void Dispose() { } }')).toBe(
      'internal sealed class Foo : System.IDisposable { public void Dispose() { } }'
    );
  });

  it('only considers the outer class of a nested pair', () => {
    expect(apply('internal class Outer { internal class Inner { } }')).toBe(
      'internal sealed class Outer { internal class Inner { } }'
    );
  });

  it('seals a class declared inside a namespace', () => {
    expect(apply('namespace N\n{\n    internal class Foo { }\n}\n')).toBe(
      'namespace N\n{\n    internal sealed class Foo { }\n}\n'
    );
  });

  it('seals a class declared inside a file-scoped namespace', () => {
    expect(apply('namespace N;\n\ninternal class Foo { }\n')).toBe('namespace N;\n\ninternal sealed class Foo { }\n');
  });

  it('handles an empty source', () => {
    expect(apply('')).toBe('');
  });

  it('leaves a class with a virtual method unsealed', () => {
    const input = 'public class Foo { public virtual void DoWork() { } }';

    expect(apply(input)).toBe(input);
  });

  it('leaves a class with a virtual property unsealed', () => {
    const input = 'public class Foo { public virtual int Count { get; set; } }';

    expect(apply(input)).toBe(input);
  });

  it('leaves a class with a virtual indexer unsealed', () => {
    const input = 'public class Foo { public virtual int this[int i] { get { return i; } } }';

    expect(apply(input)).toBe(input);
  });

  it('leaves a class with a virtual event unsealed', () => {
    const input = 'public class Foo { public virtual event System.EventHandler Changed; }';

    expect(apply(input)).toBe(input);
  });

  it('still seals a class whose method is not virtual', () => {
    expect(apply('public class Foo { public void DoWork() { } }')).toBe(
      'public sealed class Foo { public void DoWork() { } }'
    );
  });

  it('leaves a type used as a same-file generic constraint unsealed', () => {
    const input = 'public class Result { } public class Box<T> where T : Result { }';

    expect(apply(input)).toBe('public class Result { } public sealed class Box<T> where T : Result { }');
  });

  it('leaves a type used as a nullable same-file generic constraint unsealed', () => {
    const input = 'public class Result { } public class Box<T> where T : Result? { }';

    expect(apply(input)).toBe('public class Result { } public sealed class Box<T> where T : Result? { }');
  });

  it('still seals a type only used for a special constraint like class/struct/new()/notnull/unmanaged', () => {
    const input = 'public class Result { } public class Box<T> where T : class, new() { }';

    expect(apply(input)).toBe('public sealed class Result { } public sealed class Box<T> where T : class, new() { }');
  });

  it('does not disqualify a type only nested inside a multi-argument generic constraint', () => {
    const input =
      'public class Wrapper<T> where T : IDictionary<string, List<Foo>> { } public class List { }';

    expect(apply(input)).toContain('public sealed class List { }');
  });

  it('is named', () => {
    expect(sealedClassConverter.name).toBe('Sealed Class');
  });
});

describe('createSealedClassConverter with cross-file context', () => {
  it('leaves a base class unsealed when the only derived type lives in another file', () => {
    const animalSource = 'public class Animal { }';
    const dogSource = 'public class Dog : Animal { }';

    const disqualifiedTypeNames = discoverDisqualifiedTypeNames([dogSource]);
    const converter = createSealedClassConverter(disqualifiedTypeNames);

    expect(converter.apply(animalSource)).toBe(animalSource);
  });

  it('leaves a type unsealed when only another file uses it as a generic constraint', () => {
    const resultSource = 'public class Result { }';
    const boxSource = 'public class Box<T> where T : Result { }';

    const disqualifiedTypeNames = discoverDisqualifiedTypeNames([boxSource]);
    const converter = createSealedClassConverter(disqualifiedTypeNames);

    expect(converter.apply(resultSource)).toBe(resultSource);
  });

  it('still seals a class with no cross-file references', () => {
    const unrelatedSource = 'public class Widget { }';

    const disqualifiedTypeNames = discoverDisqualifiedTypeNames(['public class Dog : Animal { }']);
    const converter = createSealedClassConverter(disqualifiedTypeNames);

    expect(converter.apply(unrelatedSource)).toBe('public sealed class Widget { }');
  });

  it('falls back to single-file behavior when created with no external names', () => {
    expect(createSealedClassConverter().apply('internal class Foo { }')).toBe('internal sealed class Foo { }');
  });
});
