import { describe, expect, it } from 'vitest';
import { sealedClassConverter } from '../src/cleanup/transformations/sealedClass';

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

  it('is named', () => {
    expect(sealedClassConverter.name).toBe('Sealed Class');
  });
});
