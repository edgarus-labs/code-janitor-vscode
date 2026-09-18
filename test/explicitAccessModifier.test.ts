import { describe, expect, it } from 'vitest';
import { createExplicitAccessModifierConverter } from '../src/cleanup/transformations/explicitAccessModifier';

const allEnabled = {
  insertExplicitAccessModifiersOnClasses: true,
  insertExplicitAccessModifiersOnDelegates: true,
  insertExplicitAccessModifiersOnEnumerations: true,
  insertExplicitAccessModifiersOnEvents: true,
  insertExplicitAccessModifiersOnFields: true,
  insertExplicitAccessModifiersOnInterfaces: true,
  insertExplicitAccessModifiersOnMethods: true,
  insertExplicitAccessModifiersOnProperties: true,
  insertExplicitAccessModifiersOnStructs: true,
};

const converter = () => createExplicitAccessModifierConverter(allEnabled);

describe('explicitAccessModifierConverter', () => {
  const apply = (source: string) => converter().apply(source);

  it('gives a top-level class internal', () => {
    expect(apply('namespace N { class Foo { } }')).toContain('internal class Foo');
  });

  it('gives a top-level interface internal', () => {
    expect(apply('namespace N { interface IFoo { } }')).toContain('internal interface IFoo');
  });

  it('gives a top-level enum internal', () => {
    expect(apply('namespace N { enum Color { Red } }')).toContain('internal enum Color');
  });

  it('gives a top-level struct internal', () => {
    expect(apply('namespace N { struct Point { } }')).toContain('internal struct Point');
  });

  it('gives a top-level delegate internal', () => {
    expect(apply('namespace N { delegate void Work(); }')).toContain('internal delegate void Work');
  });

  it('gives a nested class private', () => {
    expect(apply('class Outer { class Inner { } }')).toContain('private class Inner');
  });

  it('gives a nested enum private', () => {
    expect(apply('class Outer { enum State { On } }')).toContain('private enum State');
  });

  it('gives a field private', () => {
    expect(apply('class Foo { int _x; }')).toContain('private int _x');
  });

  it('gives a method private', () => {
    expect(apply('class Foo { void Bar() { } }')).toContain('private void Bar');
  });

  it('gives a property private', () => {
    expect(apply('class Foo { int Value { get; set; } }')).toContain('private int Value');
  });

  it('gives an event field private', () => {
    expect(apply('class Foo { event System.Action Done; }')).toContain('private event System.Action Done');
  });

  it('gives a constructor private', () => {
    expect(apply('class Foo { Foo() { } }')).toContain('private Foo()');
  });

  it('leaves a public class unchanged', () => {
    const input = 'public class Foo { }';

    expect(apply(input)).toBe(input);
  });

  it('leaves a public field unchanged', () => {
    const result = apply('class Foo { public int X; }');

    expect(result).toContain('public int X');
    expect(result).not.toContain('private int X');
    expect(result).not.toContain('internal int X');
  });

  it('leaves a partial class unchanged', () => {
    const input = 'partial class Foo { }';

    expect(apply(input)).toBe(input);
  });

  it('leaves a partial method unchanged', () => {
    expect(apply('partial class Foo { partial void Bar(); }')).not.toContain('private partial void Bar');
  });

  it('leaves a static constructor unchanged', () => {
    expect(apply('class Foo { static Foo() { } }')).not.toContain('private Foo()');
  });

  it('leaves interface members unchanged', () => {
    const input = 'interface IFoo { void Bar(); int Value { get; } }';

    expect(apply(input)).toBe('internal interface IFoo { void Bar(); int Value { get; } }');
  });

  it('places the modifier after an attribute list', () => {
    expect(apply('class Foo { [Obsolete]\n    void Bar() { } }')).toContain('[Obsolete]\n    private void Bar');
  });

  it('honours a disabled per-kind setting', () => {
    const withoutMethods = createExplicitAccessModifierConverter({
      ...allEnabled,
      insertExplicitAccessModifiersOnMethods: false,
    });

    expect(withoutMethods.apply('class Foo { void Bar() { } int _x; }')).toBe(
      'internal class Foo { void Bar() { } private int _x; }'
    );
  });

  it('handles an empty source', () => {
    expect(apply('')).toBe('');
  });

  it('keeps a generic method with an attributed type parameter, nullable return, where clause, and expression body intact', () => {
    const input = `public class Service
{
    static T? Find<[SomeAttribute] T>(System.Guid id)
        where T : SomeBaseType =>
        GetAll<T>().FirstOrDefault(item => item.Id == id);

    void Inspect<T>()
    {
        var fields = typeof(T).GetFields();
    }
}`;

    const result = apply(input);

    expect(result).toContain('private static T? Find<[SomeAttribute] T>');
    expect(result).toContain('private void Inspect<T>');
    expect(result).toContain('where T : SomeBaseType');
    expect(result).toContain('typeof(T).GetFields()');
  });

  it('inserts the modifier before a doubly-generic method without corrupting either type parameter list', () => {
    const input = `public class Repository<TEntity> where TEntity : class
{
    List<TEntity> FindAll<TKey>(TKey key) where TKey : notnull
    {
        return new List<TEntity>();
    }
}`;

    const result = apply(input);

    expect(result).toContain('private List<TEntity> FindAll<TKey>');
    expect(result).toContain('Repository<TEntity> where TEntity : class');
    expect(result).toContain('where TKey : notnull');
    expect(result).not.toContain('<private');
    expect(result).not.toContain('private TEntity');
    expect(result).not.toContain('private TKey');
  });

  it('is named', () => {
    expect(converter().name).toBe('Explicit Access Modifiers');
  });
});
