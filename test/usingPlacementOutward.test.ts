import { describe, expect, it } from 'vitest';
import { createIndex } from '../src/cleanup/usings/declarations';
import { PlacementResult, placeUsings } from '../src/cleanup/usings/placement';

/** Ported from the Visual Studio extension's UsingDirectivePlacementConverterOutwardTests. */
const LIBRARY = [
  'namespace Company.App.Services { public class Svc { } }\r\n',
  'namespace Company.App.Models { public class Foo { } public static class Helpers { public static int Twice(int x) => x * 2; } }\r\n',
  'namespace Company.Shared { public class Util { } }\r\n',
  'namespace Alpha { public class T { } }\r\n',
  'namespace Beta { public class T { } }\r\n',
];

function outward(input: string, ...more: string[]): PlacementResult {
  return placeUsings(input, 'outside', {
    index: createIndex([...LIBRARY, ...more, input]),
    externalReferences: false,
    indent: '    ',
  });
}

function moved(input: string, ...more: string[]): string {
  const result = outward(input, ...more);
  if (result.status !== 'moved') {
    throw new Error(`expected a move, got ${JSON.stringify(result)}`);
  }

  return result.text;
}

function skipped(input: string, ...more: string[]): string {
  const result = outward(input, ...more);
  if (result.status !== 'skipped') {
    throw new Error(`expected a skip, got ${JSON.stringify(result)}`);
  }

  return result.reason;
}

describe('outward move: qualifying namespace-relative directives', () => {
  it('qualifies namespace-relative usings and keeps qualified ones', () => {
    const input = 'namespace Company.App\r\n{\r\n    using Services;\r\n    using Shared;\r\n    using System.Text;\r\n    class C { Svc s; Util u; StringBuilder b; }\r\n}\r\n';

    expect(moved(input)).toBe(
      'using Company.App.Services;\r\nusing Company.Shared;\r\nusing System.Text;\r\n\r\nnamespace Company.App\r\n{\r\n    class C { Svc s; Util u; StringBuilder b; }\r\n}\r\n'
    );
  });

  it('qualifies a child-namespace-relative using', () => {
    const result = moved('namespace Company.App\r\n{\r\n    using Services;\r\n    class C { Svc s; }\r\n}\r\n');

    expect(result.startsWith('using Company.App.Services;\r\n\r\nnamespace Company.App\r\n')).toBe(true);
  });

  it('qualifies a parent-namespace-relative using', () => {
    const result = moved('namespace Company.App\r\n{\r\n    using Shared;\r\n    class C { Util u; }\r\n}\r\n');

    expect(result.startsWith('using Company.Shared;\r\n\r\nnamespace Company.App\r\n')).toBe(true);
  });

  it('qualifies relative alias targets, including type arguments', () => {
    const input = 'namespace Company.App\r\n{\r\n    using X = Models.Foo;\r\n    using L = System.Collections.Generic.List<Models.Foo>;\r\n    class C { X x; L l; }\r\n}\r\n';

    expect(moved(input).startsWith('using X = Company.App.Models.Foo;\r\nusing L = System.Collections.Generic.List<Company.App.Models.Foo>;\r\n\r\nnamespace Company.App\r\n')).toBe(true);
  });

  it('qualifies a relative using static', () => {
    const result = moved('namespace Company.App\r\n{\r\n    using static Models.Helpers;\r\n    class C { int y = Twice(1); }\r\n}\r\n');

    expect(result.startsWith('using static Company.App.Models.Helpers;\r\n\r\nnamespace Company.App\r\n')).toBe(true);
  });

  it('qualifies against the innermost namespace of nested declarations', () => {
    const input = 'namespace Company\r\n{\r\n    namespace App\r\n    {\r\n        using Services;\r\n        class C { Svc s; }\r\n    }\r\n}\r\n';

    expect(moved(input).startsWith('using Company.App.Services;\r\n\r\nnamespace Company\r\n')).toBe(true);
  });

  it('keeps aliases of special types and framework types verbatim', () => {
    const input =
      'namespace Company.App\r\n{\r\n    using Str = System.String;\r\n    using N = System.Nullable<System.Int32>;\r\n    using P = System.ValueTuple<System.Int32, System.Int32>;\r\n    class C { Str s; N n; P p; }\r\n}\r\n';

    expect(moved(input).startsWith('using Str = System.String;\r\nusing N = System.Nullable<System.Int32>;\r\nusing P = System.ValueTuple<System.Int32, System.Int32>;\r\n\r\nnamespace Company.App\r\n')).toBe(true);
  });

  it('keeps a tuple alias target and qualifies the names inside it', () => {
    const input = 'namespace Company.App\r\n{\r\n    using P = (Services.Svc A, int B);\r\n    class C { P p; int M() => p.B; }\r\n}\r\n';

    expect(moved(input).startsWith('using P = (Company.App.Services.Svc A, int B);\r\n\r\nnamespace Company.App\r\n')).toBe(true);
  });

  it('writes a named tuple type argument of an alias with its element names', () => {
    const input = 'namespace Company.App\r\n{\r\n    using L = System.Collections.Generic.List<(Services.Svc A, int B)>;\r\n    class C { L l; int M() => l[0].B; }\r\n}\r\n';

    expect(moved(input).startsWith('using L = System.Collections.Generic.List<(Company.App.Services.Svc A, int B)>;\r\n\r\nnamespace Company.App\r\n')).toBe(true);
  });

  it('keeps a global:: directive as written', () => {
    const result = moved('namespace Company.App\r\n{\r\n    using global::System.Text;\r\n    class C { StringBuilder b; }\r\n}\r\n');

    expect(result.startsWith('using global::System.Text;\r\n\r\nnamespace Company.App\r\n')).toBe(true);
  });

  it('prefers the namespace declared in the project over a global one of the same name', () => {
    const input = 'namespace Company.App\r\n{\r\n    using Services;\r\n    class C { Svc s; }\r\n}\r\n';
    const global = 'namespace Services { public class Other { } }\r\n';

    expect(moved(input, global).startsWith('using Company.App.Services;\r\n\r\nnamespace Company.App\r\n')).toBe(true);
  });
});

describe('outward move: file layout', () => {
  it('drops a directive equal to a top-level one and keeps the rest', () => {
    const input =
      'using System;\r\nusing System.Text;\r\n\r\nnamespace Company.App\r\n{\r\n    using System.Text;\r\n    using Services;\r\n    class C { Svc s; StringBuilder b; Action a; }\r\n}\r\n';

    expect(moved(input)).toBe(
      'using System;\r\nusing System.Text;\r\nusing Company.App.Services;\r\n\r\nnamespace Company.App\r\n{\r\n    class C { Svc s; StringBuilder b; Action a; }\r\n}\r\n'
    );
  });

  it('drops a relative using that equals a qualified top-level one', () => {
    const input = 'using Company.App.Services;\r\n\r\nnamespace Company.App\r\n{\r\n    using Services;\r\n    class C { Svc s; }\r\n}\r\n';

    expect(moved(input)).toBe('using Company.App.Services;\r\n\r\nnamespace Company.App\r\n{\r\n    class C { Svc s; }\r\n}\r\n');
  });

  it('keeps the file header, CRLF and the blank line after the usings', () => {
    const input = '// Copyright (c) 2026\r\n\r\nnamespace Company.App\r\n{\r\n    using Services;\r\n    class C { Svc s; }\r\n}\r\n';

    expect(moved(input)).toBe('// Copyright (c) 2026\r\n\r\nusing Company.App.Services;\r\n\r\nnamespace Company.App\r\n{\r\n    class C { Svc s; }\r\n}\r\n');
  });

  it('keeps LF line endings', () => {
    const input = '// header\n\nnamespace Company.App\n{\n    using Services;\n    class C { Svc s; }\n}\n';

    expect(moved(input)).toBe('// header\n\nusing Company.App.Services;\n\nnamespace Company.App\n{\n    class C { Svc s; }\n}\n');
  });

  it('moves the usings of a file-scoped namespace', () => {
    const result = moved('namespace Company.App;\r\n\r\nusing Services;\r\n\r\nclass C { Svc s; }\r\n');

    expect(result).toBe('using Company.App.Services;\r\n\r\nnamespace Company.App;\r\n\r\nclass C { Svc s; }\r\n');
  });

  it('removes the blank line after the opening brace that the directives leave', () => {
    const result = moved('namespace Company.App\r\n{\r\n    using System;\r\n    using Services;\r\n\r\n    class C { Svc s; Action a; }\r\n}\r\n');

    expect(result).toBe('using System;\r\nusing Company.App.Services;\r\n\r\nnamespace Company.App\r\n{\r\n    class C { Svc s; Action a; }\r\n}\r\n');
  });

  it('reports nothing to move when the usings are already outside', () => {
    expect(outward('using System;\r\n\r\nnamespace Company.App\r\n{\r\n    class C { }\r\n}\r\n')).toEqual({ status: 'unchanged' });
  });

  it('keeps a documentation comment header above the moved usings', () => {
    const input = '/// <copyright file="C.cs">x</copyright>\r\nnamespace Company.App\r\n{\r\n    using Services;\r\n    class C { Svc s; }\r\n}\r\n';

    expect(moved(input)).toBe('/// <copyright file="C.cs">x</copyright>\r\nusing Company.App.Services;\r\n\r\nnamespace Company.App\r\n{\r\n    class C { Svc s; }\r\n}\r\n');
  });

  it('does not hand the documentation comment of the first type to a moved using', () => {
    const input = '/// <summary>Top</summary>\r\nclass Top { }\r\n\r\nnamespace Company.App\r\n{\r\n    using Services;\r\n    class C { Svc s; }\r\n}\r\n';

    expect(skipped(input)).toMatch(/documentation comment/);
  });

  it.each([
    [
      'end-of-line comment of a top-level using',
      'using System; // for Action\r\n\r\nnamespace Company.App\r\n{\r\n    using Services;\r\n    class C { Svc s; Action a; }\r\n}\r\n',
      'using System; // for Action\r\nusing Company.App.Services;\r\n\r\nnamespace Company.App\r\n{\r\n    class C { Svc s; Action a; }\r\n}\r\n',
    ],
    [
      'end-of-line comments of moved usings',
      'namespace Company.App\r\n{\r\n    using Services; // the services\r\n    using Shared;   /* shared */\r\n    class C { Svc s; Util u; }\r\n}\r\n',
      'using Company.App.Services; // the services\r\nusing Company.Shared;   /* shared */\r\n\r\nnamespace Company.App\r\n{\r\n    class C { Svc s; Util u; }\r\n}\r\n',
    ],
    [
      'comment line above a moved using',
      'using System;\r\n\r\nnamespace Company.App\r\n{\r\n    using Shared;\r\n    // Services of the app\r\n    using Services;\r\n    class C { Svc s; Util u; Action a; }\r\n}\r\n',
      'using System;\r\nusing Company.Shared;\r\n// Services of the app\r\nusing Company.App.Services;\r\n\r\nnamespace Company.App\r\n{\r\n    class C { Svc s; Util u; Action a; }\r\n}\r\n',
    ],
    [
      'multi-line comment above the first moved using, below the file header',
      '// header\r\n\r\nnamespace Company.App\r\n{\r\n    /* Services\r\n       of the app */\r\n    using Services;\r\n    class C { Svc s; }\r\n}\r\n',
      '// header\r\n\r\n/* Services\r\n       of the app */\r\nusing Company.App.Services;\r\n\r\nnamespace Company.App\r\n{\r\n    class C { Svc s; }\r\n}\r\n',
    ],
    [
      'comment in front of a moved using on its line',
      'namespace Company.App\r\n{\r\n    /* services */ using Services;\r\n    class C { Svc s; }\r\n}\r\n',
      '/* services */ using Company.App.Services;\r\n\r\nnamespace Company.App\r\n{\r\n    class C { Svc s; }\r\n}\r\n',
    ],
    [
      'documentation comment above a moved using',
      'namespace Company.App\r\n{\r\n    /// <summary>Services</summary>\r\n    using Services;\r\n    class C { Svc s; }\r\n}\r\n',
      '/// <summary>Services</summary>\r\nusing Company.App.Services;\r\n\r\nnamespace Company.App\r\n{\r\n    class C { Svc s; }\r\n}\r\n',
    ],
    [
      'end-of-line comment of a moved using that duplicates a top-level using',
      'using System;\r\n\r\nnamespace Company.App\r\n{\r\n    using System; // needed for Action\r\n    using Services;\r\n    class C { Svc s; Action a; }\r\n}\r\n',
      'using System; // needed for Action\r\nusing Company.App.Services;\r\n\r\nnamespace Company.App\r\n{\r\n    class C { Svc s; Action a; }\r\n}\r\n',
    ],
    [
      'comment line above a moved using that duplicates an earlier moved using',
      'namespace Company.App\r\n{\r\n    using System;\r\n    class C1 { Action a; }\r\n}\r\n\r\nnamespace Company.Other\r\n{\r\n    // for Func\r\n    using System;\r\n    class C2 { Func<int> f; }\r\n}\r\n',
      '// for Func\r\nusing System;\r\n\r\nnamespace Company.App\r\n{\r\n    class C1 { Action a; }\r\n}\r\n\r\nnamespace Company.Other\r\n{\r\n    class C2 { Func<int> f; }\r\n}\r\n',
    ],
    [
      'using below a file header is still deduplicated',
      '// header\r\nusing System;\r\n\r\nnamespace Company.App\r\n{\r\n    using System;\r\n    using Services;\r\n    class C { Svc s; Action a; }\r\n}\r\n',
      '// header\r\nusing System;\r\nusing Company.App.Services;\r\n\r\nnamespace Company.App\r\n{\r\n    class C { Svc s; Action a; }\r\n}\r\n',
    ],
    [
      'alias target that stays verbatim receives the file header',
      '// header\r\n\r\nnamespace Company.App\r\n{\r\n    using Str = System.String;\r\n    class C { Str s; }\r\n}\r\n',
      '// header\r\n\r\nusing Str = System.String;\r\n\r\nnamespace Company.App\r\n{\r\n    class C { Str s; }\r\n}\r\n',
    ],
  ])('%s', (_name, input, expected) => {
    expect(moved(input)).toBe(expected);
  });

  it('keeps the file header above extern aliases and puts the moved directives below them', () => {
    const input = '// Copyright (c) 2026\r\nextern alias V1;\r\n\r\nnamespace Company.App\r\n{\r\n    using V1::Ext;\r\n    class C { Thing t; }\r\n}\r\n';

    expect(moved(input)).toBe('// Copyright (c) 2026\r\nextern alias V1;\r\nusing V1::Ext;\r\n\r\nnamespace Company.App\r\n{\r\n    class C { Thing t; }\r\n}\r\n');
  });
});

describe('outward move: skipped with a reason', () => {
  it('skips an unresolvable using', () => {
    expect(skipped('namespace Company.App\r\n{\r\n    using Services;\r\n    using Missing;\r\n    class C { Svc s; }\r\n}\r\n')).toMatch(/using Missing;/);
  });

  it('assumes a name from a referenced package is a global namespace', () => {
    const input = 'namespace Company.App\r\n{\r\n    using Newtonsoft.Json;\r\n    class C { }\r\n}\r\n';
    const result = placeUsings(input, 'outside', { index: createIndex([input]), externalReferences: true, indent: '    ' });

    expect(result).toEqual({ status: 'moved', text: 'using Newtonsoft.Json;\r\n\r\nnamespace Company.App\r\n{\r\n    class C { }\r\n}\r\n' });
  });

  it('skips directives that would become ambiguous once merged', () => {
    const input = 'namespace N1\r\n{\r\n    using Alpha;\r\n    class C1 { T t; }\r\n}\r\n\r\nnamespace N2\r\n{\r\n    using Beta;\r\n    class C2 { T t; }\r\n}\r\n';

    expect(skipped(input)).toMatch(/'T' ambiguous/);
  });

  it('skips a using of an extern alias declared inside the namespace', () => {
    const input = 'namespace Company.App\r\n{\r\n    extern alias V1;\r\n    using V1::Ext;\r\n    class C { Thing t; }\r\n}\r\n';

    expect(skipped(input)).toMatch(/extern alias 'V1'/);
  });

  it('skips a move that would silently rebind a name', () => {
    // Inside Company.App, 'using Models;' makes Foo mean Company.App.Models.Foo; at file level the import
    // is searched after the enclosing namespace Company, whose Foo would win without any error.
    const input = 'namespace Company.App\r\n{\r\n    using Models;\r\n    class C { Foo f; }\r\n}\r\n';

    expect(skipped(input, 'namespace Company { public class Foo { } }\r\n')).toMatch(/'Foo'.*Company\.Foo/);
  });

  it('moves the same directive when the name is not used', () => {
    const input = 'namespace Company.App\r\n{\r\n    using Models;\r\n    class C { }\r\n}\r\n';

    expect(moved(input, 'namespace Company { public class Foo { } }\r\n')).toBe('using Company.App.Models;\r\n\r\nnamespace Company.App\r\n{\r\n    class C { }\r\n}\r\n');
  });

  it('skips when a package namespace could provide a name an enclosing namespace declares', () => {
    const input = 'namespace Company.App\r\n{\r\n    using Newtonsoft.Json;\r\n    class C { Foo f; }\r\n}\r\n';
    const result = placeUsings(input, 'outside', {
      index: createIndex(['namespace Company { public class Foo { } }\r\n', input]),
      externalReferences: true,
      indent: '    ',
    });

    expect(result).toMatchObject({ status: 'skipped', reason: expect.stringContaining("'Foo'") });
  });

  it.each([
    ['#if around a using', 'namespace Company.App\r\n{\r\n#if true\r\n    using Services;\r\n#endif\r\n    class C { Svc s; }\r\n}\r\n'],
    ['usings in #if branches above', '#if NET48\r\nusing System.Text;\r\n#else\r\nusing System.IO;\r\n#endif\r\n\r\nnamespace Company.App\r\n{\r\n    using Services;\r\n    class C { Svc s; }\r\n}\r\n'],
    ['a #region around the top-level usings', '#region Usings\r\nusing System;\r\n#endregion\r\n\r\nnamespace Company.App\r\n{\r\n    using Services;\r\n    class C { Svc s; }\r\n}\r\n'],
    ['a namespace in an #if block', 'using System;\r\n\r\n#if FEATURE\r\nnamespace Company.App\r\n{\r\n    using Services;\r\n    class C { Svc s; }\r\n}\r\n#endif\r\n'],
    ['a top-level using in an #if block', 'using System;\r\n#if DEBUG\r\nusing System.Diagnostics;\r\n#endif\r\n\r\nnamespace Company.App\r\n{\r\n    using Services;\r\n    class C { Svc s; }\r\n}\r\n'],
  ])('skips %s', (_name, input) => {
    expect(skipped(input)).toMatch(/preprocessor directives/);
  });

  it('moves in a file that has conditional compilation elsewhere when nothing can be rebound', () => {
    const input =
      'namespace Company.App\r\n{\r\n    using Services;\r\n    using Shared;\r\n    class C\r\n    {\r\n        object M()\r\n        {\r\n#if DEBUG\r\n            return new Svc();\r\n#else\r\n            return new Util();\r\n#endif\r\n        }\r\n    }\r\n}\r\n';

    expect(moved(input)).toBe(
      'using Company.App.Services;\r\nusing Company.Shared;\r\n\r\nnamespace Company.App\r\n{\r\n    class C\r\n    {\r\n        object M()\r\n        {\r\n#if DEBUG\r\n            return new Svc();\r\n#else\r\n            return new Util();\r\n#endif\r\n        }\r\n    }\r\n}\r\n'
    );
  });

  it('skips when a name used only in a disabled branch would be rebound', () => {
    const input = 'namespace Company.App\r\n{\r\n    using Models;\r\n    class C { }\r\n#if DEBUG\r\n    class D { Foo f; }\r\n#endif\r\n}\r\n';

    expect(skipped(input, 'namespace Company { public class Foo { } }\r\n')).toMatch(/'Foo'/);
  });

  it('skips when another file declares the namespace only in a disabled branch', () => {
    const input = 'namespace Company.App\r\n{\r\n    using Tools;\r\n    class C { Tool t; }\r\n}\r\n';
    const other = '#if A && B\r\nnamespace Company.App.Tools { public class Tool { } }\r\n#endif\r\n';

    // Tools resolves to the global namespace Tools unless Company.App.Tools exists: the index counts both branches.
    expect(moved(input, 'namespace Tools { public class Tool { } }\r\n', other)).toContain('using Company.App.Tools;');
  });

  it('skips an alias that would join a namespace import providing a type of the same name', () => {
    // In N, Lib.X (imported in N) wins over the file-level alias X; side by side at file level, the alias would win.
    const input = 'using X = System.Text.StringBuilder;\n\nnamespace N\n{\n    using Lib;\n\n    class C { int i = new X().Only; }\n}\n';

    expect(skipped(input, 'namespace Lib { public class X { public int Only; } }\n')).toMatch(/'X'/);
  });

  it('moves an alias that wins over a same-named imported type before and after the move', () => {
    const input = 'using Lib;\n\nnamespace N\n{\n    using X = System.Text.StringBuilder;\n\n    class C { X x; }\n}\n';

    expect(moved(input, 'namespace Lib { public class X { } }\n')).toBe('using Lib;\nusing X = System.Text.StringBuilder;\n\nnamespace N\n{\n    class C { X x; }\n}\n');
  });

  it.each([
    ['a file-level using', 'using System;\n\nnamespace N\n{\n    using static Math;\n\n    class C { double d = Sqrt(4); }\n}\n', []],
    ['a global using', 'namespace N\n{\n    using static Math;\n\n    class C { double d = Sqrt(4); }\n}\n', ['global using System;\n']],
  ])('skips a directive that only resolves through %s, also where packages are referenced', (_name, input, more) => {
    const result = placeUsings(input, 'outside', { index: createIndex([...more, input]), externalReferences: true, indent: '    ' });

    expect(result).toMatchObject({ status: 'skipped', reason: expect.stringContaining("'Math'") });
  });

  it('skips a using static whose name a file-level import of a package namespace may provide, also where packages are referenced', () => {
    const input = 'using Pkg;\n\nnamespace N\n{\n    using static Helpers;\n\n    class C { }\n}\n';
    const result = placeUsings(input, 'outside', { index: createIndex([input]), externalReferences: true, indent: '    ' });

    expect(result).toMatchObject({ status: 'skipped', reason: expect.stringContaining("'Helpers' through 'using Pkg;'") });
  });

  it('moves a package namespace directive next to a file-level using static', () => {
    const input = 'using static System.Console;\n\nnamespace N\n{\n    using Newtonsoft.Json;\n\n    class C { }\n}\n';
    const result = placeUsings(input, 'outside', { index: createIndex([input]), externalReferences: true, indent: '    ' });

    expect(result).toEqual({ status: 'moved', text: 'using static System.Console;\nusing Newtonsoft.Json;\n\nnamespace N\n{\n    class C { }\n}\n' });
  });
});

describe('outward move: what reaches other parts of the file', () => {
  it('skips an alias whose name another namespace of the file uses', () => {
    const input =
      'namespace Company.App.Left\r\n{\r\n    using Timer = Company.App.Clocks.Timer;\r\n    class L { Timer t; }\r\n}\r\n\r\nnamespace Company.App.Right\r\n{\r\n    using System.Threading;\r\n    class R { Timer t; }\r\n}\r\n';

    expect(skipped(input, 'namespace Company.App.Clocks { public class Timer { } }\r\n')).toMatch(/alias 'Timer'.*outside its namespace/);
  });

  it('moves an alias whose name no other part of the file uses', () => {
    const input =
      'namespace Company.App.Left\r\n{\r\n    using Clock = Clocks.Timer;\r\n    class L { Clock t; }\r\n}\r\n\r\nnamespace Company.App.Right\r\n{\r\n    using System.Threading;\r\n    class R { Timer t; }\r\n}\r\n';

    expect(moved(input, 'namespace Company.App.Clocks { public class Timer { } }\r\n')).toMatch(/^using Clock = Company\.App\.Clocks\.Timer;\r\nusing System\.Threading;\r\n\r\nnamespace Company\.App\.Left/);
  });

  it('skips two using static directives that would end up side by side', () => {
    const input = 'using static System.Console;\r\n\r\nnamespace Company.App\r\n{\r\n    using static System.Math;\r\n    class C { double D() => Sqrt(4); }\r\n}\r\n';

    expect(skipped(input)).toMatch(/members they import cannot be compared/);
  });
});

describe('outward move: extension methods', () => {
  const receivers = 'namespace Company { public class Thing { } }\r\n';

  it('qualifies an extension import and moves it when no enclosing namespace declares the same method', () => {
    const ext = 'namespace Company.App.Ext { public static class E { public static int Twice(this int x) => x; } }\r\n';
    const input = 'namespace Company.App\r\n{\r\n    using Ext;\r\n    class C { int y = 1.Twice(); }\r\n}\r\n';

    expect(moved(input, ext)).toBe('using Company.App.Ext;\r\n\r\nnamespace Company.App\r\n{\r\n    class C { int y = 1.Twice(); }\r\n}\r\n');
  });

  it('skips when an enclosing namespace declares a same-named extension method', () => {
    const ext = 'namespace Company.App.Ext { public static class E { public static int Twice(this int x) => x; } }\r\n';
    const outer = 'namespace Company { public static class E2 { public static int Twice(this int x) => x; } }\r\n';
    const input = 'namespace Company.App\r\n{\r\n    using Ext;\r\n    class C { int y = 1.Twice(); }\r\n}\r\n';

    expect(skipped(input, ext, outer)).toMatch(/extension method 'Twice'/);
  });

  it('skips an implicitly called extension member that an enclosing namespace also declares', () => {
    const ext = 'namespace Company.App.Ext { public static class E { public static System.Collections.Generic.IEnumerator<int> GetEnumerator(this Company.Thing t) => null; } }\r\n';
    const outer = 'namespace Company { public static class E2 { public static System.Collections.Generic.IEnumerator<int> GetEnumerator(this Company.Thing t) => null; } }\r\n';
    const input = 'namespace Company.App\r\n{\r\n    using Ext;\r\n    class C { void M(Thing t) { foreach (var x in t) { } } }\r\n}\r\n';

    expect(skipped(input, receivers, ext, outer)).toMatch(/GetEnumerator/);
  });

  it('skips when an extension method would be looked up together with a top-level import that has the same one', () => {
    const ext = 'namespace Company.App.Ext { public static class E { public static int Where(this int x) => x; } }\r\n';
    const input = 'using System.Linq;\r\n\r\nnamespace Company.App\r\n{\r\n    using Ext;\r\n    class C { int y = 1.Where(); }\r\n}\r\n';

    expect(skipped(input, ext)).toMatch(/extension method 'Where'/);
  });
});

describe('outward move: other layouts', () => {
  it('leaves an extern alias of the namespace where it is and moves the usings behind it', () => {
    expect(moved('namespace N\r\n{\r\n    extern alias V1;\r\n    using System;\r\n\r\n    class C { Action a; }\r\n}\r\n')).toBe(
      'using System;\r\n\r\nnamespace N\r\n{\r\n    extern alias V1;\r\n\r\n    class C { Action a; }\r\n}\r\n'
    );
  });

  it('skips directives at several nesting levels of namespaces', () => {
    expect(skipped('namespace A\r\n{\r\n    using System;\r\n    namespace B\r\n    {\r\n        using System.Text;\r\n        class C { Action a; StringBuilder b; }\r\n    }\r\n}\r\n')).toMatch(/several nesting levels/);
  });

  it('skips while the declarations of the project are not fully known', () => {
    const input = 'namespace N\r\n{\r\n    using System;\r\n    class C { Action a; }\r\n}\r\n';
    const result = placeUsings(input, 'outside', { index: createIndex([input]), externalReferences: false, indent: '    ', incomplete: 'a.csproj adds C# files from outside its folder' });

    expect(result).toMatchObject({ status: 'skipped', reason: expect.stringContaining('not fully known') });
  });

  it('moves a file without a final line break', () => {
    expect(moved('namespace N\n{\n    using System;\n    class C { Action a; }\n}')).toBe('using System;\n\nnamespace N\n{\n    class C { Action a; }\n}');
  });

  it('leaves an emptied namespace as it is', () => {
    expect(moved('namespace N\n{\n    using System;\n}\n')).toBe('using System;\n\nnamespace N\n{\n}\n');
  });
});

describe('outward move: layout the move does not support', () => {
  it('skips a directive that shares its line with code', () => {
    expect(skipped('namespace Company.App { using Services; class C { Svc s; } }\r\n')).toMatch(/shares its line/);
  });

  it('skips a file that has unbalanced braces', () => {
    expect(skipped('namespace Company.App\r\n{\r\n    using Services;\r\n    class C { Svc s; }\r\n')).toMatch(/could not be parsed/);
  });
});
