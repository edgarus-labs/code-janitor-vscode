import { describe, expect, it } from 'vitest';
import { fixNamespace, nameOfOperatorConverter } from '../src/cleanup/transformations/namespaceAndNameOf';
import { outVarInliningConverter } from '../src/cleanup/transformations/outVarInlining';

describe('fixNamespace', () => {
  it('rewrites a block-scoped namespace', () => {
    expect(fixNamespace('namespace Old.Name\n{\n    class C { }\n}\n', 'New.Name')).toBe(
      'namespace New.Name\n{\n    class C { }\n}\n'
    );
  });

  it('rewrites a file-scoped namespace', () => {
    expect(fixNamespace('namespace Old.Name;\n\nclass C { }\n', 'New.Name')).toBe(
      'namespace New.Name;\n\nclass C { }\n'
    );
  });

  it('leaves a matching namespace unchanged', () => {
    const input = 'namespace Same;\n\nclass C { }\n';

    expect(fixNamespace(input, 'Same')).toBe(input);
  });

  it('does nothing when there is no namespace', () => {
    const input = 'class C { }\n';

    expect(fixNamespace(input, 'New')).toBe(input);
  });

  it('does nothing when there are multiple top-level namespaces', () => {
    const input = 'namespace A { }\nnamespace B { }\n';

    expect(fixNamespace(input, 'New')).toBe(input);
  });

  it('ignores nested namespaces', () => {
    expect(fixNamespace('namespace Outer\n{\n    namespace Inner { }\n}\n', 'New')).toBe(
      'namespace New\n{\n    namespace Inner { }\n}\n'
    );
  });

  it('returns the source for an empty expected namespace', () => {
    const input = 'namespace A { }\n';

    expect(fixNamespace(input, '')).toBe(input);
  });
});

describe('nameOfOperatorConverter', () => {
  const apply = (source: string) => nameOfOperatorConverter.apply(source);

  it('converts a parameter name literal in ArgumentNullException', () => {
    expect(apply('class C { void M(string value) { throw new ArgumentNullException("value"); } }')).toBe(
      'class C { void M(string value) { throw new ArgumentNullException(nameof(value)); } }'
    );
  });

  it('converts through a qualified exception type name', () => {
    expect(apply('class C { void M(string value) { throw new System.ArgumentNullException("value"); } }')).toBe(
      'class C { void M(string value) { throw new System.ArgumentNullException(nameof(value)); } }'
    );
  });

  it('leaves literals that do not match a parameter unchanged', () => {
    const input = 'class C { void M(string value) { throw new ArgumentNullException("other"); } }';

    expect(apply(input)).toBe(input);
  });

  it('leaves other exception types unchanged', () => {
    const input = 'class C { void M(string value) { throw new InvalidOperationException("value"); } }';

    expect(apply(input)).toBe(input);
  });

  it('converts constructor parameters', () => {
    expect(apply('class C { public C(string name) { throw new ArgumentException("name"); } }')).toBe(
      'class C { public C(string name) { throw new ArgumentException(nameof(name)); } }'
    );
  });

  it('converts only the matching argument of a multi-argument constructor', () => {
    expect(
      apply('class C { void M(string value) { throw new ArgumentOutOfRangeException("value", "message"); } }')
    ).toBe('class C { void M(string value) { throw new ArgumentOutOfRangeException(nameof(value), "message"); } }');
  });

  it('leaves literals that are not valid identifiers unchanged', () => {
    const input = 'class C { void M(string value) { throw new ArgumentException("not an identifier"); } }';

    expect(apply(input)).toBe(input);
  });

  it('handles an empty source', () => {
    expect(apply('')).toBe('');
  });

  it('is named', () => {
    expect(nameOfOperatorConverter.name).toBe('Convert String Literals to nameof(...)');
  });
});

describe('outVarInliningConverter', () => {
  const apply = (source: string) => outVarInliningConverter.apply(source);

  it('inlines an uninitialized declaration into the following out argument', () => {
    const input =
      '\npublic class C\n{\n    public void M(string s)\n    {\n        int result;\n        if (int.TryParse(s, out result))\n        {\n            DoWork(result);\n        }\n    }\n}';
    const expected =
      '\npublic class C\n{\n    public void M(string s)\n    {\n        if (int.TryParse(s, out var result))\n        {\n            DoWork(result);\n        }\n    }\n}';

    expect(apply(input)).toBe(expected);
  });

  it('does not inline an initialized declaration', () => {
    const input =
      '\npublic class C\n{\n    public void M(string s)\n    {\n        int result = 0;\n        if (int.TryParse(s, out result))\n        {\n            DoWork(result);\n        }\n    }\n}';

    expect(apply(input)).toBe(input);
  });

  it('does not inline when the variable is read before the out argument', () => {
    const input =
      'class C { void M(string s) { int result; if (Check(result) && int.TryParse(s, out result)) { } } }';

    expect(apply(input)).toBe(input);
  });

  it('does not inline when the out argument is not in the next statement', () => {
    const input = 'class C { void M(string s) { int result; DoWork(); int.TryParse(s, out result); } }';

    expect(apply(input)).toBe(input);
  });

  it('does not inline a declaration with several variables', () => {
    const input = 'class C { void M(string s) { int a, result; int.TryParse(s, out result); } }';

    expect(apply(input)).toBe(input);
  });

  it('handles an empty source', () => {
    expect(apply('')).toBe('');
  });

  it('is named', () => {
    expect(outVarInliningConverter.name).toBe('Inline out Variable Declarations');
  });
});
