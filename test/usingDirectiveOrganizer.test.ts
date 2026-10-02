import { describe, expect, it } from 'vitest';
import { sortUsingDirectives, usingDirectiveOrganizer } from '../src/cleanup/transformations/usingDirectiveOrganizer';

describe('usingDirectiveOrganizer', () => {
  const apply = (source: string) => usingDirectiveOrganizer.apply(source);

  it('sorts unsorted usings alphabetically', () => {
    expect(apply('using B;\nusing A;\n')).toBe('using A;\nusing B;\n');
  });

  it('leaves already sorted usings unchanged', () => {
    const input = 'using A;\nusing B;\nusing C;\n';

    expect(apply(input)).toBe(input);
  });

  it('sorts System namespaces first', () => {
    expect(apply('using MyLib;\nusing System;\n')).toBe('using System;\nusing MyLib;\n');
  });

  it('groups System sub-namespaces before others', () => {
    expect(apply('using System.Text;\nusing Abc;\nusing System;\n')).toBe(
      'using System;\nusing System.Text;\nusing Abc;\n'
    );
  });

  it('sorts static usings after regular usings', () => {
    expect(apply('using static System.Math;\nusing System;\n')).toBe('using System;\nusing static System.Math;\n');
  });

  it('sorts alias usings last', () => {
    expect(apply('using Foo = System.Int32;\nusing System;\n')).toBe('using System;\nusing Foo = System.Int32;\n');
  });

  it('compares the names part by part, ignoring case first and then putting lowercase first, as Roslyn does', () => {
    expect(apply('using System.IO;\nusing System.IdentityModel.Tokens.Jwt;\n')).toBe('using System.IdentityModel.Tokens.Jwt;\nusing System.IO;\n');
    expect(apply('using Foo.Bar;\nusing Foo.bar;\nusing foo.Bar;\nusing Zeta;\n')).toBe('using foo.Bar;\nusing Foo.bar;\nusing Foo.Bar;\nusing Zeta;\n');
    // `@class` is the identifier `class`; `_` sorts before digits and letters, and a shorter name before a longer one.
    expect(apply('using @class.X;\nusing Cl.X;\nusing AB;\nusing A1;\nusing A_B;\nusing A.B;\n')).toBe('using A.B;\nusing A_B;\nusing A1;\nusing AB;\nusing Cl.X;\nusing @class.X;\n');
    expect(apply('using b = System.IO;\nusing A = System.Text;\n')).toBe('using A = System.Text;\nusing b = System.IO;\n');
    expect(apply('using static System.Collections.Generic.List<int>;\nusing static System.Collections.Generic.List;\nusing static System.Console;\n')).toBe(
      'using static System.Collections.Generic.List;\nusing static System.Collections.Generic.List<int>;\nusing static System.Console;\n'
    );
  });

  it('puts System first only as the first part of the name', () => {
    expect(apply('using Systemx;\nusing Abc.System;\nusing System.IO;\n')).toBe('using System.IO;\nusing Abc.System;\nusing Systemx;\n');
    expect(sortUsingDirectives('using Systemx;\nusing System.IO;\nusing Abc;\n', false)).toBe('using Abc;\nusing System.IO;\nusing Systemx;\n');
  });

  it('sorts namespace-scoped usings preserving indentation', () => {
    expect(apply('namespace N\n{\n    using B;\n    using A;\n}\n')).toBe(
      'namespace N\n{\n    using A;\n    using B;\n}\n'
    );
  });

  it('sorts file-scoped namespace usings', () => {
    expect(apply('namespace N;\n\nusing B;\nusing A;\n')).toBe('namespace N;\n\nusing A;\nusing B;\n');
  });

  it('leaves a block with a comment untouched', () => {
    const input = 'using B; // keep near B\nusing A;\n';

    expect(apply(input)).toBe(input);
  });

  it('leaves a block with a preprocessor directive untouched', () => {
    const input = '#if DEBUG\nusing B;\n#endif\nusing A;\n';

    expect(apply(input)).toBe(input);
  });

  it('leaves a block preceded by a file header comment untouched', () => {
    const input = '// Copyright\nusing B;\nusing A;\n';

    expect(apply(input)).toBe(input);
  });

  it('leaves global usings untouched', () => {
    const input = 'global using B;\nglobal using A;\n';

    expect(apply(input)).toBe(input);
  });

  it('leaves a single using unchanged', () => {
    const input = 'using A;\n';

    expect(apply(input)).toBe(input);
  });

  it('leaves a file without usings unchanged', () => {
    const input = 'namespace N\n{\n}\n';

    expect(apply(input)).toBe(input);
  });

  it('handles an empty source', () => {
    expect(apply('')).toBe('');
  });

  it('preserves a blank line before the namespace', () => {
    expect(apply('using B;\nusing A;\n\nnamespace N\n{\n}\n')).toBe('using A;\nusing B;\n\nnamespace N\n{\n}\n');
  });

  it('is named', () => {
    expect(usingDirectiveOrganizer.name).toBe('Sort using directives');
  });
});
