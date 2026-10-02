import { describe, expect, it } from 'vitest';
import {
  convertToBlockScoped,
  convertToFileScoped,
  createFileScopedNamespaceConverter,
  createUsingPlacementConverter,
  fileScopedNamespacesUnsupported,
} from '../src/cleanup/transformations/namespaceScope';

function toFileScoped(source: string): { output: string; reasons: string[] } {
  const reasons: string[] = [];

  return { output: convertToFileScoped(source, { indent: '    ', report: (reason) => reasons.push(reason) }), reasons };
}

function toBlockScoped(source: string, indent = '    '): { output: string; reasons: string[] } {
  const reasons: string[] = [];

  return { output: convertToBlockScoped(source, { indent, report: (reason) => reasons.push(reason) }), reasons };
}

describe('convertToFileScoped', () => {
  it('converts a single block namespace', () => {
    expect(toFileScoped('namespace A\r\n{\r\n    class C\r\n    {\r\n    }\r\n}\r\n').output).toBe('namespace A;\r\n\r\nclass C\r\n{\r\n}\r\n');
  });

  it('keeps the usings inside the namespace: only the using placement moves them', () => {
    expect(toFileScoped('namespace A\r\n{\r\n    using System;\r\n\r\n    class C\r\n    {\r\n    }\r\n}\r\n').output).toBe(
      'namespace A;\r\n\r\nusing System;\r\n\r\nclass C\r\n{\r\n}\r\n'
    );
  });

  it('leaves an already file-scoped namespace unchanged', () => {
    const input = 'namespace A;\r\n\r\nclass C\r\n{\r\n}\r\n';

    expect(toFileScoped(input)).toEqual({ output: input, reasons: [] });
  });

  it.each([
    ['multiple namespaces', 'namespace A\r\n{\r\n}\r\nnamespace B\r\n{\r\n}\r\n'],
    ['no namespace', 'class C\r\n{\r\n}\r\n'],
    ['nested namespaces', 'namespace A\r\n{\r\n    namespace B\r\n    {\r\n    }\r\n}\r\n'],
    ['a type before the namespace', 'class B { }\r\nnamespace A\r\n{\r\n    class C { }\r\n}\r\n'],
    ['a type after the namespace', 'namespace A\r\n{\r\n    class C { }\r\n}\r\nclass B { }\r\n'],
    ['a syntax error', 'namespace A\r\n{\r\n    class C {\r\n}\r\n'],
  ])('is not a candidate with %s', (_name, input) => {
    expect(toFileScoped(input)).toEqual({ output: input, reasons: [] });
  });

  it('never changes the lines inside verbatim, raw and interpolated multi-line strings', () => {
    const input = [
      'namespace N',
      '{',
      '    class C',
      '    {',
      '        string a = @"',
      '    verbatim',
      '        ";',
      '        string b = """',
      '            raw',
      '            """;',
      '        string c = $@"',
      '    {a}',
      '    tail";',
      '    }',
      '}',
      '',
    ].join('\r\n');

    expect(toFileScoped(input).output).toBe(
      [
        'namespace N;',
        '',
        'class C',
        '{',
        '    string a = @"',
        '    verbatim',
        '        ";',
        '    string b = """',
        '            raw',
        '            """;',
        '    string c = $@"',
        '    {a}',
        '    tail";',
        '}',
        '',
      ].join('\r\n')
    );
  });

  it('keeps the bare LF line breaks inside a string of a CRLF file', () => {
    const input = 'namespace N\r\n{\r\n    class C\r\n    {\r\n        string s = @"\n    x\n";\r\n    }\r\n}\r\n';

    expect(toFileScoped(input).output).toBe('namespace N;\r\n\r\nclass C\r\n{\r\n    string s = @"\n    x\n";\r\n}\r\n');
  });

  it('preserves the file header and outer usings', () => {
    expect(toFileScoped('// file header\r\nusing System;\r\n\r\nnamespace A\r\n{\r\n    class C\r\n    {\r\n    }\r\n}\r\n').output).toBe(
      '// file header\r\nusing System;\r\n\r\nnamespace A;\r\n\r\nclass C\r\n{\r\n}\r\n'
    );
  });

  it.each([
    ['tabs', 'namespace A\n{\n\tclass C\n\t{\n\t}\n}\n', 'namespace A;\n\nclass C\n{\n}\n'],
    ['two spaces', 'namespace A\n{\n  class C\n  {\n    int x;\n  }\n}\n', 'namespace A;\n\nclass C\n{\n  int x;\n}\n'],
    ['an empty body', 'namespace A\n{\n}\n', 'namespace A;\n'],
    ['a dotted name', 'namespace A.B.C\n{\n    class D { }\n}\n', 'namespace A.B.C;\n\nclass D { }\n'],
  ])('moves the body by one indentation level of the file (%s)', (_name, input, expected) => {
    expect(toFileScoped(input).output).toBe(expected);
  });

  it.each([
    ['an #if that ends inside the namespace', 'namespace A\n{\n    class C\n    {\n    }\n#if X\n}\n#endif\n'],
    ['an #if that begins before the namespace and ends inside it', '#if X\nnamespace A\n{\n    class C\n    {\n    }\n#endif\n}\n'],
    ['a #region that begins inside and ends after the namespace', 'namespace A\n{\n    class C\n    {\n    }\n#region R\n}\n#endregion\n'],
  ])('reports and keeps the namespace with %s', (_name, input) => {
    const { output, reasons } = toFileScoped(input);

    expect(output).toBe(input);
    expect(reasons).toHaveLength(1);
  });

  it('keeps comments around the braces as a reason', () => {
    const input = 'namespace A // the namespace\n{\n    class C { }\n}\n';
    const { output, reasons } = toFileScoped(input);

    expect(output).toBe(input);
    expect(reasons).toEqual(['comments or code surround the namespace braces.']);
  });

  it('converts an #if block that lies entirely inside the namespace', () => {
    expect(toFileScoped('namespace A\n{\n#if X\n    class C { }\n#else\n    class D { }\n#endif\n}\n').output).toBe(
      'namespace A;\n\n#if X\nclass C { }\n#else\nclass D { }\n#endif\n'
    );
  });
});

describe('convertToBlockScoped', () => {
  it('converts a file-scoped namespace, indenting what follows by one level', () => {
    expect(toBlockScoped('using System;\r\n\r\nnamespace A;\r\n\r\nclass C\r\n{\r\n}\r\n').output).toBe(
      'using System;\r\n\r\nnamespace A\r\n{\r\n    class C\r\n    {\r\n    }\r\n}\r\n'
    );
  });

  it('indents with the unit it is given', () => {
    expect(toBlockScoped('namespace A;\n\nclass C { }\n', '\t').output).toBe('namespace A\n{\n\tclass C { }\n}\n');
  });

  it('moves usings after the declaration into the block', () => {
    expect(toBlockScoped('namespace A;\n\nusing System;\n\nclass C { }\n').output).toBe('namespace A\n{\n    using System;\n\n    class C { }\n}\n');
  });

  it('leaves the lines inside multi-line strings as they are', () => {
    expect(toBlockScoped('namespace A;\n\nclass C\n{\n    string s = @"x\ny";\n}\n').output).toBe(
      'namespace A\n{\n    class C\n    {\n        string s = @"x\ny";\n    }\n}\n'
    );
  });

  it.each([
    ['an empty body', 'namespace A;\n', 'namespace A\n{\n}\n'],
    ['no final line break', 'namespace A;\n\nclass C { }', 'namespace A\n{\n    class C { }\n}\n'],
    ['trailing blank lines', 'namespace A;\n\nclass C { }\n\n\n', 'namespace A\n{\n    class C { }\n}\n'],
  ])('handles %s', (_name, input, expected) => {
    expect(toBlockScoped(input).output).toBe(expected);
  });

  it.each([
    ['a block-scoped namespace', 'namespace A\n{\n    class C { }\n}\n'],
    ['two file-scoped namespaces', 'namespace A;\nnamespace B;\n'],
    ['no namespace', 'class C\n{\n}\n'],
  ])('is not a candidate with %s', (_name, input) => {
    expect(toBlockScoped(input)).toEqual({ output: input, reasons: [] });
  });

  it('reports an #if that begins before the namespace and ends after it', () => {
    const input = '#if NETFRAMEWORK\nnamespace A;\n\nclass C { }\n#endif\n';
    const { output, reasons } = toBlockScoped(input);

    expect(output).toBe(input);
    expect(reasons).toHaveLength(1);
  });
});

describe('file-scoped namespaces need C# 10', () => {
  it.each([
    [undefined, /could not be determined/],
    [{ directory: '/p' }, /version of its project is unknown/],
    [{ directory: '/p', languageVersion: 9 }, /C# 9 and file-scoped namespaces need C# 10/],
    [{ directory: '/p', languageVersion: 7.3 }, /C# 7.3/],
  ])('gives a reason for %j', (project, reason) => {
    expect(fileScopedNamespacesUnsupported(project)).toMatch(reason);
  });

  it.each([10, 12, 99])('accepts C# %s', (languageVersion) => {
    expect(fileScopedNamespacesUnsupported({ directory: '/p', languageVersion })).toBeUndefined();
  });

  it('keeps the namespace block-scoped and reports once when the version is not known', () => {
    const messages: string[] = [];
    const converter = createFileScopedNamespaceConverter({ project: undefined, report: (message) => messages.push(message) });
    const input = 'namespace A\n{\n    class C { }\n}\n';

    expect(converter.apply(input)).toBe(input);
    expect(messages).toEqual([expect.stringMatching(/namespace not converted to a file-scoped one: its project could not be determined/)]);
  });

  it('stays silent for a file with no block-scoped namespace to convert', () => {
    const messages: string[] = [];
    const converter = createFileScopedNamespaceConverter({ project: undefined, report: (message) => messages.push(message) });
    const input = 'namespace A;\n\nclass C { }\n';

    expect(converter.apply(input)).toBe(input);
    expect(messages).toEqual([]);
  });

  it('converts for a project on C# 10', () => {
    const converter = createFileScopedNamespaceConverter({ project: { directory: '/p', languageVersion: 10 }, report: () => undefined });

    expect(converter.apply('namespace A\n{\n    class C { }\n}\n')).toBe('namespace A;\n\nclass C { }\n');
    expect(converter.name).toBe('File-Scoped Namespace');
  });
});

describe('createUsingPlacementConverter', () => {
  it('is named after its direction', () => {
    const report = () => undefined;

    expect(createUsingPlacementConverter({ direction: 'outside', report }).name).toBe('Move using directives outside namespace');
    expect(createUsingPlacementConverter({ direction: 'inside', report }).name).toBe('Move using directives inside namespace');
  });

  it('is the IDE0065 step when .editorconfig decides', () => {
    expect(createUsingPlacementConverter({ direction: 'inside', report: () => undefined, fromEditorConfig: true }).diagnosticId).toBe('IDE0065');
    expect(createUsingPlacementConverter({ direction: 'inside', report: () => undefined }).diagnosticId).toBeUndefined();
  });

  it('returns a file without directives to move untouched and silently', () => {
    const messages: string[] = [];
    const converter = createUsingPlacementConverter({ direction: 'outside', report: (message) => messages.push(message) });
    const input = 'using System;\n\nnamespace A\n{\n    class C { }\n}\n';

    expect(converter.apply(input)).toBe(input);
    expect(converter.apply('')).toBe('');
    expect(messages).toEqual([]);
  });
});
