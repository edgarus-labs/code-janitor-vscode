import { describe, expect, it } from 'vitest';
import { updateAccessorsToBothBeSingleLineOrMultiLineConverter } from '../src/cleanup/transformations/accessorFormat';

const apply = (source: string) => updateAccessorsToBothBeSingleLineOrMultiLineConverter.apply(source);

describe('updateAccessorsToBothBeSingleLineOrMultiLineConverter', () => {
  it('handles an empty source', () => {
    expect(apply('')).toBe('');
  });

  it('leaves consistent multi-line accessors unchanged', () => {
    const source =
      'public class MyClass\r\n{\r\n    public int MyProp\r\n    {\r\n        get\r\n        {\r\n            return 0;\r\n        }\r\n        set\r\n        {\r\n        }\r\n    }\r\n}';

    expect(apply(source)).toBe(source);
  });

  it('leaves consistent single-line accessors unchanged', () => {
    const source = 'public class MyClass { public int MyProp { get { return 0; } set { } } }';

    expect(apply(source)).toBe(source);
  });

  it('leaves an expression-bodied property unchanged', () => {
    const source = 'public class MyClass { public int MyProp => 0; }';

    expect(apply(source)).toBe(source);
  });

  it('leaves an auto-property unchanged', () => {
    const source = 'public class MyClass { public int MyProp { get; set; } }';

    expect(apply(source)).toBe(source);
  });

  it('leaves a class without accessors unchanged', () => {
    const source = 'public class MyClass { }';

    expect(apply(source)).toBe(source);
  });

  it('leaves an event with a single accessor unchanged', () => {
    const source = 'public class MyClass { public event System.EventHandler MyEvent { add { } } }';

    expect(apply(source)).toBe(source);
  });

  it('compresses a multi-line accessor when the first one is single-line', () => {
    const source = 'class C\n{\n    public int P\n    {\n        get { return 0; }\n        set\n        {\n            _x = value;\n        }\n    }\n}\n';

    expect(apply(source)).toBe(
      'class C\n{\n    public int P\n    {\n        get { return 0; }\n        set\n        { _x = value; }\n    }\n}\n'
    );
  });

  it('expands a single-line accessor when the first one is multi-line', () => {
    const source = 'class C\n{\n    public int P\n    {\n        get\n        {\n            return _x;\n        }\n        set { _x = value; }\n    }\n}\n';

    expect(apply(source)).toBe(
      'class C\n{\n    public int P\n    {\n        get\n        {\n            return _x;\n        }\n        set {\n    _x = value;\n}\n    }\n}\n'
    );
  });

  it('normalizes event accessors', () => {
    const source = 'class C\n{\n    public event System.EventHandler E\n    {\n        add { _h += value; }\n        remove\n        {\n            _h -= value;\n        }\n    }\n}\n';

    expect(apply(source)).toContain('remove\n        { _h -= value; }');
  });

  it('is named', () => {
    expect(updateAccessorsToBothBeSingleLineOrMultiLineConverter.name).toBe(
      'Update accessors to both be single line or multi-line'
    );
  });
});
