import { describe, expect, it } from 'vitest';
import { createIndex } from '../src/cleanup/usings/declarations';
import { PlacementResult, placeUsings } from '../src/cleanup/usings/placement';

/** Ported from the Visual Studio extension's UsingDirectivePlacementConverterInwardTests. */
const LIBRARY = [
  'namespace Company.App.Services { public class Svc { } }\r\n',
  'namespace Company.App.Models { public class Foo { } }\r\n',
  'namespace Company.App.Shared { public class Other { } }\r\n',
  'namespace Shared { public class Util { } }\r\n',
  'namespace Models { public class Bar { } public static class Helpers { public static int Thrice(int x) => x * 3; } }\r\n',
];

function inward(input: string, ...more: string[]): PlacementResult {
  return placeUsings(input, 'inside', {
    index: createIndex([...LIBRARY, ...more, input]),
    externalReferences: false,
    indent: '    ',
  });
}

function moved(input: string, ...more: string[]): string {
  const result = inward(input, ...more);
  if (result.status !== 'moved') {
    throw new Error(`expected a move, got ${JSON.stringify(result)}`);
  }

  return result.text;
}

function skipped(input: string, ...more: string[]): string {
  const result = inward(input, ...more);
  if (result.status !== 'skipped') {
    throw new Error(`expected a skip, got ${JSON.stringify(result)}`);
  }

  return result.reason;
}

describe('inward move: writing the directives', () => {
  it('moves file-level usings into the block-scoped namespace', () => {
    expect(moved('using System.Text;\r\nusing Company.App.Services;\r\n\r\nnamespace Company.App\r\n{\r\n    class C { Svc s; StringBuilder b; }\r\n}\r\n')).toBe(
      'namespace Company.App\r\n{\r\n    using System.Text;\r\n    using Company.App.Services;\r\n\r\n    class C { Svc s; StringBuilder b; }\r\n}\r\n'
    );
  });

  it('qualifies a name that would resolve relative to the namespace with global::', () => {
    // Inside Company.App, 'Shared' means Company.App.Shared; the file-level directive imports the global Shared.
    expect(moved('using Shared;\r\n\r\nnamespace Company.App\r\n{\r\n    class C { Util u; }\r\n}\r\n')).toBe(
      'namespace Company.App\r\n{\r\n    using global::Shared;\r\n\r\n    class C { Util u; }\r\n}\r\n'
    );
  });

  it('qualifies alias and using static targets only when they would rebind', () => {
    const input =
      'using X = Models.Bar;\r\nusing static Models.Helpers;\r\nusing Str = System.String;\r\n\r\nnamespace Company.App\r\n{\r\n    class C { X x; Str s; int y = Thrice(1); }\r\n}\r\n';

    expect(moved(input)).toBe(
      'namespace Company.App\r\n{\r\n    using X = global::Models.Bar;\r\n    using static global::Models.Helpers;\r\n    using Str = System.String;\r\n\r\n    class C { X x; Str s; int y = Thrice(1); }\r\n}\r\n'
    );
  });

  it('drops a directive that imports what the namespace already imports', () => {
    const input =
      'using System;\r\nusing System.Text;\r\nusing Company.App.Services;\r\n\r\nnamespace Company.App\r\n{\r\n    using System.Text;\r\n    using Company.App.Services;\r\n\r\n    class C { Svc s; StringBuilder b; Action a; }\r\n}\r\n';

    expect(moved(input)).toBe(
      'namespace Company.App\r\n{\r\n    using System;\r\n    using System.Text;\r\n    using Company.App.Services;\r\n\r\n    class C { Svc s; StringBuilder b; Action a; }\r\n}\r\n'
    );
  });

  it('gives the comment of a dropped duplicate to the directive in the namespace', () => {
    expect(moved('using System; // for Action\r\n\r\nnamespace Company.App\r\n{\r\n    using System;\r\n    class C { Action a; }\r\n}\r\n')).toBe(
      'namespace Company.App\r\n{\r\n    using System; // for Action\r\n    class C { Action a; }\r\n}\r\n'
    );
  });

  it('keeps the file header and CRLF in place', () => {
    expect(moved('// Copyright (c) 2026\r\n\r\nusing Company.App.Services;\r\n\r\nnamespace Company.App\r\n{\r\n    class C { Svc s; }\r\n}\r\n')).toBe(
      '// Copyright (c) 2026\r\n\r\nnamespace Company.App\r\n{\r\n    using Company.App.Services;\r\n\r\n    class C { Svc s; }\r\n}\r\n'
    );
  });

  it('keeps the file header with LF line endings', () => {
    expect(moved('// header\n\nusing Company.App.Services;\n\nnamespace Company.App\n{\n    class C { Svc s; }\n}\n')).toBe(
      '// header\n\nnamespace Company.App\n{\n    using Company.App.Services;\n\n    class C { Svc s; }\n}\n'
    );
  });

  it('keeps a documentation comment header at the top of the file', () => {
    expect(moved('/// <copyright file="C.cs">x</copyright>\r\nusing Company.App.Services;\r\n\r\nnamespace Company.App\r\n{\r\n    class C { Svc s; }\r\n}\r\n')).toBe(
      '/// <copyright file="C.cs">x</copyright>\r\nnamespace Company.App\r\n{\r\n    using Company.App.Services;\r\n\r\n    class C { Svc s; }\r\n}\r\n'
    );
  });

  it('keeps a documentation comment in front of the namespace in front of it', () => {
    expect(moved('using System;\r\n\r\n/// <summary>App types</summary>\r\nnamespace Company.App\r\n{\r\n    class C { Action a; }\r\n}\r\n')).toBe(
      '/// <summary>App types</summary>\r\nnamespace Company.App\r\n{\r\n    using System;\r\n\r\n    class C { Action a; }\r\n}\r\n'
    );
  });

  it('keeps and indents the comments of moved usings', () => {
    const input = 'using System; // for Action\r\n// The services\r\nusing Company.App.Services;\r\n\r\nnamespace Company.App\r\n{\r\n    class C { Svc s; Action a; }\r\n}\r\n';

    expect(moved(input)).toBe(
      'namespace Company.App\r\n{\r\n    using System; // for Action\r\n    // The services\r\n    using Company.App.Services;\r\n\r\n    class C { Svc s; Action a; }\r\n}\r\n'
    );
  });

  it('gives the comments of a duplicate to the earlier moved directive', () => {
    const input =
      'using System;\r\n// The services\r\nusing Company.App.Services;\r\n// The services again\r\nusing global::Company.App.Services; /* duplicate */\r\n\r\nnamespace Company.App\r\n{\r\n    class C { Svc s; Action a; }\r\n}\r\n';

    expect(moved(input)).toBe(
      'namespace Company.App\r\n{\r\n    using System;\r\n    // The services\r\n    // The services again\r\n    using Company.App.Services; /* duplicate */\r\n\r\n    class C { Svc s; Action a; }\r\n}\r\n'
    );
  });

  it.each([
    [
      'tab-indented members',
      'using System;\r\n// The services\r\nusing Company.App.Services;\r\n\r\nnamespace Company.App\r\n{\r\n\tclass C { Svc s; Action a; }\r\n}\r\n',
      'namespace Company.App\r\n{\r\n\tusing System;\r\n\t// The services\r\n\tusing Company.App.Services;\r\n\r\n\tclass C { Svc s; Action a; }\r\n}\r\n',
    ],
    [
      'two-space-indented using already in the namespace',
      'using System;\r\n\r\nnamespace Company.App\r\n{\r\n  using Company.App.Services;\r\n\r\n  class C { Svc s; Action a; }\r\n}\r\n',
      'namespace Company.App\r\n{\r\n  using System;\r\n  using Company.App.Services;\r\n\r\n  class C { Svc s; Action a; }\r\n}\r\n',
    ],
  ])('takes the indentation of the namespace body: %s', (_name, input, expected) => {
    expect(moved(input)).toBe(expected);
  });

  it('moves the usings below a file-scoped namespace without indentation', () => {
    expect(moved('using Shared;\r\nusing Company.App.Services;\r\n\r\nnamespace Company.App;\r\n\r\nclass C { Svc s; Util u; }\r\n')).toBe(
      'namespace Company.App;\r\n\r\nusing global::Shared;\r\nusing Company.App.Services;\r\n\r\nclass C { Svc s; Util u; }\r\n'
    );
  });

  it('joins the usings of a file-scoped namespace', () => {
    expect(moved('using System;\r\n\r\nnamespace Company.App;\r\n\r\nusing Company.App.Services;\r\n\r\nclass C { Svc s; Action a; }\r\n')).toBe(
      'namespace Company.App;\r\n\r\nusing System;\r\nusing Company.App.Services;\r\n\r\nclass C { Svc s; Action a; }\r\n'
    );
  });

  it('keeps global usings and extern aliases at file level', () => {
    expect(moved('extern alias V1;\r\nglobal using System;\r\nusing Company.App.Services;\r\n\r\nnamespace Company.App\r\n{\r\n    class C { Svc s; Action a; }\r\n}\r\n')).toBe(
      'extern alias V1;\r\nglobal using System;\r\n\r\nnamespace Company.App\r\n{\r\n    using Company.App.Services;\r\n\r\n    class C { Svc s; Action a; }\r\n}\r\n'
    );
  });

  it('writes the directives after an extern alias of the namespace', () => {
    expect(moved('using System;\r\n\r\nnamespace Company.App\r\n{\r\n    extern alias V1;\r\n    using V1::Ext;\r\n\r\n    class C { Action a; }\r\n}\r\n')).toBe(
      'namespace Company.App\r\n{\r\n    extern alias V1;\r\n    using System;\r\n    using V1::Ext;\r\n\r\n    class C { Action a; }\r\n}\r\n'
    );
  });

  it('qualifies a relative value tuple alias target', () => {
    expect(moved('using P = System.ValueTuple<Shared.Util, int>;\r\n\r\nnamespace Company.App\r\n{\r\n    class C { P p; }\r\n}\r\n')).toBe(
      'namespace Company.App\r\n{\r\n    using P = System.ValueTuple<global::Shared.Util, int>;\r\n\r\n    class C { P p; }\r\n}\r\n'
    );
  });

  it('keeps a moved directive that reads like one in the namespace but imports another namespace', () => {
    // In Company.App, the kept 'using Shared;' imports Company.App.Shared; the file-level one imports the global Shared.
    expect(moved('using Shared;\n\nnamespace Company.App\n{\n    using Shared;\n\n    class C { Util u; Other o; }\n}\n')).toBe(
      'namespace Company.App\n{\n    using global::Shared;\n    using Shared;\n\n    class C { Util u; Other o; }\n}\n'
    );
  });

  it('moves a comment written in front of the first directive of the file with it', () => {
    expect(moved('/* keep me */ using System;\n\nnamespace N\n{\n    class C { String s; }\n}\n')).toBe(
      'namespace N\n{\n    /* keep me */ using System;\n\n    class C { String s; }\n}\n'
    );
  });

  it('keeps the file header but moves the comment on the line of the first directive', () => {
    expect(moved('// Header\n/* keep me */ using System;\n\nnamespace N\n{\n    class C { String s; }\n}\n')).toBe(
      '// Header\nnamespace N\n{\n    /* keep me */ using System;\n\n    class C { String s; }\n}\n'
    );
  });

  it('reports nothing to move when only global usings are at file level', () => {
    expect(inward('global using System;\r\n\r\nnamespace Company.App\r\n{\r\n    class C { Action a; }\r\n}\r\n')).toEqual({ status: 'unchanged' });
  });
});

describe('inward move: other layouts', () => {
  it('keeps the directives of a file without a final line break and with a namespace on one line in place', () => {
    expect(skipped('using System;\n\nnamespace N { class C { Action a; } }\n')).toMatch(/shares its line/);
  });

  it('writes the directives into an emptied namespace body', () => {
    expect(moved('using System;\n\nnamespace N\n{\n}\n')).toBe('namespace N\n{\n    using System;\n}\n');
  });

  it('puts the blank line the directives stood in front of in front of the first member', () => {
    expect(moved('using System;\n\nnamespace N\n{\n\n    class C { Action a; }\n}\n')).toBe('namespace N\n{\n    using System;\n\n    class C { Action a; }\n}\n');
  });

  it('keeps CRLF and the lack of a final line break', () => {
    expect(moved('using System;\r\nusing System.Text;\r\n\r\nnamespace N;\r\n\r\nclass C { Action a; StringBuilder b; }')).toBe(
      'namespace N;\r\n\r\nusing System;\r\nusing System.Text;\r\n\r\nclass C { Action a; StringBuilder b; }'
    );
  });

  it.each([
    ['a block-scoped', 'using System;\n\nusing System.IO;\n\nnamespace N\n{\n    class C { }\n}\n', 'namespace N\n{\n    using System;\n    using System.IO;\n\n    class C { }\n}\n'],
    ['a file-scoped', 'using System;\n\nusing System.IO;\n\nnamespace N;\n\nclass C { }\n', 'namespace N;\n\nusing System;\nusing System.IO;\n\nclass C { }\n'],
    ['a commented', '// Header\n\nusing System;\n\nusing System.IO;\n\nnamespace N\n{\n    class C { }\n}\n', '// Header\n\nnamespace N\n{\n    using System;\n    using System.IO;\n\n    class C { }\n}\n'],
  ])('takes the blank lines between groups of usings out of the file level of %s namespace', (_name, input, expected) => {
    expect(moved(input)).toBe(expected);
  });
});

describe('inward move: files left unchanged without a report', () => {
  it.each([
    ['two namespaces', 'using System;\r\n\r\nnamespace N1\r\n{\r\n    class C1 { Action a; }\r\n}\r\n\r\nnamespace N2\r\n{\r\n    class C2 { }\r\n}\r\n'],
    ['no namespace', 'using System;\r\n\r\nclass C { Action a; }\r\n'],
    ['a type outside the namespace', 'using System;\r\n\r\nclass Top { Action a; }\r\n\r\nnamespace Company.App\r\n{\r\n    class C { }\r\n}\r\n'],
    ['an assembly attribute', 'using System;\r\nusing System.Runtime.CompilerServices;\r\n\r\n[assembly: InternalsVisibleTo("Tests")]\r\n\r\nnamespace Company.App\r\n{\r\n    class C { Action a; }\r\n}\r\n'],
    ['a delegate outside the namespace', 'using System;\r\n\r\ndelegate void D(Action a);\r\n\r\nnamespace Company.App\r\n{\r\n    class C { }\r\n}\r\n'],
    ['top-level statements', 'using System;\r\n\r\nConsole.WriteLine();\r\n\r\nnamespace Company.App\r\n{\r\n    class C { }\r\n}\r\n'],
  ])('%s', (_name, input) => {
    expect(inward(input)).toEqual({ status: 'unchanged' });
  });
});

describe('inward move: skipped with a reason', () => {
  it('skips an unresolvable using', () => {
    expect(skipped('using Missing;\r\nusing Company.App.Services;\r\n\r\nnamespace Company.App\r\n{\r\n    class C { Svc s; }\r\n}\r\n')).toMatch(/using Missing;.*cannot be resolved|cannot be resolved.*Missing/);
  });

  it('skips a move that would silently rebind a name', () => {
    // At file level, 'using Company.App.Models;' is searched after the enclosing namespace Company, so Foo means
    // Company.Foo. Inside Company.App it would be searched first, so Foo would silently become Company.App.Models.Foo.
    const input = 'using Company.App.Models;\r\n\r\nnamespace Company.App\r\n{\r\n    class C { Foo f; }\r\n}\r\n';

    expect(skipped(input, 'namespace Company { public class Foo { } }\r\n')).toMatch(/'Foo'.*Company\.Foo/);
  });

  it('moves the same directive when the name is not used', () => {
    const input = 'using Company.App.Models;\r\n\r\nnamespace Company.App\r\n{\r\n    class C { }\r\n}\r\n';

    expect(moved(input, 'namespace Company { public class Foo { } }\r\n')).toBe('namespace Company.App\r\n{\r\n    using Company.App.Models;\r\n\r\n    class C { }\r\n}\r\n');
  });

  it.each([
    ['int y = 1.Twice();', 'public static int Twice(this int x) => x;', 'Twice'],
    ['void M(Thing t) { foreach (var x in t) { } }', 'public static System.Collections.Generic.IEnumerator<int> GetEnumerator(this Thing t) => null;', 'GetEnumerator'],
    ['void M(Thing t) { var (a, b) = t; }', 'public static void Deconstruct(this Thing t, out int a, out int b) { a = 0; b = 0; }', 'Deconstruct'],
  ])('skips a move that rebinds an extension member (%s)', (usage, member, name) => {
    const input = `using Ext;\r\n\r\nnamespace Company.App\r\n{\r\n    class C { ${usage} }\r\n}\r\n`;
    const libraries = [
      'namespace Company { public class Thing { } }\r\n',
      `namespace Ext { public static class E { ${member} } }\r\n`,
      `namespace Company { public static class E2 { ${member} } }\r\n`,
    ];

    expect(skipped(input, ...libraries)).toMatch(new RegExp(`extension method '${name}'`));
  });

  it('skips when a directive would end up next to a directive with the same extension method', () => {
    const ext = 'namespace Ext { public static class E { public static int Where(this int x) => x; } }\r\n';
    const input = 'using Ext;\r\n\r\nnamespace Company.App\r\n{\r\n    using System.Linq;\r\n\r\n    class C { int y = 1.Where(); }\r\n}\r\n';

    expect(skipped(input, ext)).toMatch(/extension method 'Where'/);
  });

  it('skips a directive that would join a namespace directive with a same-named framework type', () => {
    // Inside the namespace `Clocks.Timer` wins over `System.Threading.Timer` of the file level; side by side they are ambiguous.
    const input = 'using System.Threading;\r\n\r\nnamespace Company.App\r\n{\r\n    using Clocks;\r\n\r\n    class C { Timer timer; }\r\n}\r\n';

    expect(skipped(input, 'namespace Company.App.Clocks { public class Timer { } }\r\n')).toMatch(/'Timer' ambiguous/);
  });

  it('skips a package namespace whose name the code uses: it may hold a type of that name', () => {
    // `Mediator.ICommand` names the namespace of a package; `using Mediator;` inside the namespace would import a type `Mediator` first.
    const input = 'using Mediator;\r\n\r\nnamespace Company.App\r\n{\r\n    class C { Mediator.ICommand<int> command; }\r\n}\r\n';
    const result = placeUsings(input, 'inside', { index: createIndex([input]), externalReferences: true, indent: '    ' });

    expect(result).toMatchObject({ status: 'skipped', reason: expect.stringContaining("'Mediator'") });
  });

  it('moves a package namespace whose name the code does not use', () => {
    const input = 'using Mediator;\r\n\r\nnamespace Company.App\r\n{\r\n    class C { ICommand<int> command; }\r\n}\r\n';
    const result = placeUsings(input, 'inside', { index: createIndex([input]), externalReferences: true, indent: '    ' });

    expect(result).toEqual({ status: 'moved', text: 'namespace Company.App\r\n{\r\n    using Mediator;\r\n\r\n    class C { ICommand<int> command; }\r\n}\r\n' });
  });

  it.each([
    ['namespace import', 'using System;\n\nnamespace N\n{\n    using static Math;\n\n    class C { double d = Sqrt(4); }\n}\n', 'Math'],
    ['alias', 'using M = System.Math;\n\nnamespace N\n{\n    using static M;\n\n    class C { double d = Sqrt(4); }\n}\n', 'M'],
    ['alias in a type argument', 'using M = System.Math;\n\nnamespace N\n{\n    using L = System.Collections.Generic.List<M>;\n\n    class C { L l; }\n}\n', 'M'],
  ])('skips when a directive of the namespace only resolves through the moved %s', (_name, input, name) => {
    // Directives of one scope do not see each other: next to the moved directive, the one of the namespace no longer resolves.
    expect(skipped(input)).toMatch(new RegExp(`'${name}'`));
  });

  it('moves a using static next to a package namespace directive of the namespace', () => {
    const input = 'using System;\nusing static System.Math;\n\nnamespace N\n{\n    using Newtonsoft.Json;\n\n    class C { }\n}\n';
    const result = placeUsings(input, 'inside', { index: createIndex([input]), externalReferences: true, indent: '    ' });

    expect(result).toEqual({ status: 'moved', text: 'namespace N\n{\n    using System;\n    using static System.Math;\n    using Newtonsoft.Json;\n\n    class C { }\n}\n' });
  });

  it.each([
    ['a using static', 'using static Helpers;'],
    ['an alias', 'using H = Helpers;'],
  ])('skips when %s of the namespace may only resolve through a moved package namespace', (_name, directive) => {
    const input = `using Pkg;\n\nnamespace N\n{\n    ${directive}\n\n    class C { }\n}\n`;
    const result = placeUsings(input, 'inside', { index: createIndex([input]), externalReferences: true, indent: '    ' });

    expect(result).toMatchObject({ status: 'skipped', reason: expect.stringContaining("'Helpers' through 'using Pkg;'") });
  });

  it.each([
    ['a nested type of a project type', 'namespace Lib { public static class Outer { public class Inner { } } }\n', true],
    ['a project type without that nested type', 'namespace Lib { public static class Outer { } }\n', false],
  ])('for a moved using static of %s, decides by the nested types the project declares', (_name, library, hidden) => {
    const input = 'using static Lib.Outer;\n\nnamespace N\n{\n    using I = Inner;\n\n    class C { }\n}\n';
    const result = placeUsings(input, 'inside', { index: createIndex([library, input]), externalReferences: true, indent: '    ' });

    expect(result).toMatchObject(hidden ? { status: 'skipped', reason: expect.stringContaining("'Inner' through 'using static Lib.Outer;'") } : { status: 'moved' });
  });

  it('skips an alias that would join a namespace import providing a type of the same name', () => {
    // In N, Lib.X (imported in N) wins over the file-level alias X; side by side in N, the alias would win.
    const input = 'using X = System.Text.StringBuilder;\n\nnamespace N\n{\n    using Lib;\n\n    class C { int i = new X().Only; }\n}\n';

    expect(skipped(input, 'namespace Lib { public class X { public int Only; } }\n')).toMatch(/'X'/);
  });

  it.each([
    ['in the namespace itself', 'using Foo = System.Text.StringBuilder;\n\nnamespace N\n{\n    class Foo { }\n\n    class C { Foo f; }\n}\n', []],
    ['in another file', 'using Foo = System.Text.StringBuilder;\n\nnamespace N\n{\n    class C { Foo f; }\n}\n', ['namespace N { class Foo { } }\n']],
  ])('skips an alias named like a member of the namespace it would move into, declared %s (CS0576)', (_name, input, more) => {
    expect(skipped(input, ...more)).toMatch(/alias 'Foo'/);
  });

  it.each([
    ['a using static', 'using static Foo;', 'class C { int x = Bar(); }'],
    ['an alias', 'using F = Foo;', 'class C { int x = F.Bar(); }'],
  ])('skips when %s of a nested namespace would find a moved import before a global type', (_name, directive, member) => {
    // In M, Foo is looked up in M, then N and its directives, then the global namespace: once `using Lib;` is in N, Lib.Foo wins.
    const library = 'namespace Lib { public static class Foo { public static string Bar() => ""; } } public static class Foo { public static int Bar() => 1; }\n';
    const input = `using Lib;\n\nnamespace N\n{\n    namespace M\n    {\n        ${directive}\n\n        ${member}\n    }\n}\n`;

    expect(skipped(input, library)).toMatch(/'Foo'/);
  });

  it("skips a directive that names a moved alias before '::': directives of one scope do not see each other", () => {
    expect(skipped('using T = System.Text;\n\nnamespace N\n{\n    using B = T::StringBuilder;\n\n    class C { B b; }\n}\n')).toMatch(/'T'/);
  });

  it('skips when an alias in the namespace and a moved alias of the same name mean different types', () => {
    // The kept alias names Company.App.Models.Bar, the moved one the global Models.Bar: both cannot stand in one scope.
    const input = 'using X = Models.Bar;\n\nnamespace Company.App\n{\n    using X = Models.Bar;\n\n    class C { X x; }\n}\n';

    expect(skipped(input, 'namespace Company.App.Models { public class Bar { } }\n')).toMatch(/alias 'X' twice/);
  });

  it('skips a using static that would share a scope with a namespace import holding a used type of the same name', () => {
    const library = 'namespace Company { public static class Util { public class Bar { } } }\n';
    const input = 'using static Company.Util;\n\nnamespace App\n{\n    using Models;\n\n    class C { Bar b; }\n}\n';

    expect(skipped(input, library)).toMatch(/'Bar' ambiguous/);
  });

  it.each([
    ['#if around a using', '#if DEBUG\r\nusing System.Diagnostics;\r\n#endif\r\nusing System;\r\n\r\nnamespace Company.App\r\n{\r\n    class C { Action a; }\r\n}\r\n'],
    ['#region around the usings', '#region Usings\r\nusing System;\r\n#endregion\r\n\r\nnamespace Company.App\r\n{\r\n    class C { Action a; }\r\n}\r\n'],
    ['#nullable in front of a using that does not start the file', 'global using System.Text;\r\n#nullable enable\r\nusing System;\r\n\r\nnamespace Company.App\r\n{\r\n    class C { Action a; }\r\n}\r\n'],
  ])('skips %s', (_name, input) => {
    expect(skipped(input)).toMatch(/preprocessor directives/);
  });
});
