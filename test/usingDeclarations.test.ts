import { describe, expect, it } from 'vitest';
import { BCL_TYPES } from '../src/cleanup/usings/bclIndex.generated';
import { createIndex, summarizeDeclarations } from '../src/cleanup/usings/declarations';
import { analyzeLayout } from '../src/cleanup/usings/layout';

function keys(source: string): string[] {
  return [...summarizeDeclarations(source).keys].sort();
}

describe('declarations of a file', () => {
  it('reads block-scoped, dotted, nested and file-scoped namespaces with their prefixes', () => {
    expect(keys('namespace A.B { namespace C { } }')).toEqual(['N:A', 'N:A.B', 'N:A.B.C']);
    expect(keys('namespace A;\n\nclass C { }\n')).toEqual(['N:A', 'T:A.C']);
  });

  it('reads the kinds of types, nested types and records', () => {
    const source = `namespace N
{
    public class C { public class Nested { } enum E { } }
    struct S { }
    interface I { }
    record R(int A);
    record struct P(int A) { }
    record class Q { }
    delegate void D(int x);
    delegate T Generic<T>(T value);
}`;

    expect(keys(source)).toEqual(['N:N', 'T:N.C', 'T:N.C.E', 'T:N.C.Nested', 'T:N.D', 'T:N.Generic`1', 'T:N.I', 'T:N.P', 'T:N.Q', 'T:N.R', 'T:N.S']);
  });

  it('does not take constraints, typeof or local code for declarations', () => {
    const source = `namespace N
{
    class C<T> where T : class, new()
    {
        void M() { var t = typeof(C<>); class Local { } }
    }
}`;

    expect(keys(source)).toEqual(['N:N', 'T:N.C`1']);
  });

  it('records the arity of generic types the way metadata names them', () => {
    const source = 'namespace N { class Box { } class Box<T> { } class Pair<A, B> { } delegate void D<T>(T x); class Attr<[X(1, 2)] T> { } record R<T>(T A); }';

    expect(keys(source)).toEqual(['N:N', 'T:N.Attr`1', 'T:N.Box', 'T:N.Box`1', 'T:N.D`1', 'T:N.Pair`2', 'T:N.R`1']);
  });

  it('reads a file that starts with a byte order mark', () => {
    expect(keys('\uFEFFnamespace Company { public class Foo { } }')).toEqual(['N:Company', 'T:Company.Foo']);
    expect(keys('\uFEFFnamespace Company;\n\npublic class Foo { }\n')).toEqual(['N:Company', 'T:Company.Foo']);
    expect(keys('\uFEFFglobal using Vendor.Tools;\n')).toEqual(['G:Vendor . Tools']);
  });

  it('reads types of the global namespace', () => {
    expect(keys('class Top { }\nenum Kind { }\n')).toEqual(['T:Kind', 'T:Top']);
  });

  it('reads extension methods, generic ones and C# 14 extension blocks', () => {
    const source = `namespace N
{
    static class E
    {
        public static int Plain(this int x) => x;
        public static T Generic<T>(this T x) => x;
        public static void NotOne(int x) { }
    }

    static class Blocks
    {
        extension(string s) { public int Length2 => s.Length; }
    }
}`;

    expect(keys(source)).toEqual(['E:N:Generic', 'E:N:Plain', 'N:N', 'T:N.Blocks', 'T:N.E', 'X:N']);
  });

  it('reads extension methods whose receiver has modifiers or attributes in front of this', () => {
    const source =
      'namespace N { static class E { public static void Inc(ref this int x) {} public static void Dec(this ref int x) {} ' +
      'public static int Len(in this System.Span<int> s) => 0; public static int Peek<T>(ref readonly this T x) => 0; ' +
      'public static void Fill(scoped ref this System.Span<int> s) {} public static int Count([NotNull] this string s) => 0; ' +
      'public static int Plain(ref int x) => 0; } }';

    expect(keys(source)).toEqual(['E:N:Count', 'E:N:Dec', 'E:N:Fill', 'E:N:Inc', 'E:N:Len', 'E:N:Peek', 'N:N', 'T:N.E']);
  });

  it('reads global using directives', () => {
    expect(keys('global using System.Text;\nglobal using A = System.Collections.Generic.List<int>;\n')).toEqual([
      'G:A = System . Collections . Generic . List < int >',
      'G:System . Text',
    ]);
  });

  it.each([
    ['delegate { }', 'static System.Action a = delegate { Run(); };'],
    ['delegate (int x) { }', 'static System.Action<int> a = delegate (int x) { Run(); };'],
    ['a function pointer', 'static unsafe delegate*<void> p;'],
    ['a method returning a function pointer', 'static unsafe delegate*<void> Get() => null;'],
    ['a method returning an unmanaged function pointer', 'static unsafe delegate* unmanaged<int, void> Make() => null;'],
  ])('does not take an anonymous method or function pointer at member level (%s) for a delegate type', (_name, member) => {
    const source = `namespace Ns { public static class C { ${member} static void Run() { } public static string Shout(this string s) => s; } public class D { } }`;

    expect(keys(source)).toEqual(['E:Ns:Shout', 'N:Ns', 'T:Ns.C', 'T:Ns.D']);
  });

  it('reads a delegate type returning a tuple', () => {
    expect(keys('namespace N { delegate (int A, int B) Pair(); class After { } }')).toEqual(['N:N', 'T:N.After', 'T:N.Pair']);
  });

  it('counts a declaration in a disabled #if branch too, marked as one a condition may leave out', () => {
    expect(keys('#if X\nnamespace A { class C { } }\n#else\nnamespace B { class D { } }\n#endif\n')).toEqual([
      'C:N:A',
      'C:N:B',
      'C:T:A.C',
      'C:T:B.D',
      'N:A',
      'N:B',
      'T:A.C',
      'T:B.D',
    ]);
  });

  it('marks only the declarations inside a conditional branch, not those of a region', () => {
    expect(keys('namespace A\n{\n#if X\n    class C { }\n#endif\n#region R\n    class D { }\n#endregion\n}\n')).toEqual(['C:T:A.C', 'N:A', 'T:A.C', 'T:A.D']);
  });
});

describe('declaration index', () => {
  it('knows the declared namespaces and types, and the framework', () => {
    const index = createIndex(['namespace Company.App { class C { } }']);

    expect(index.hasNamespace('Company.App')).toBe(true);
    expect(index.hasNamespace('Company.Other')).toBe(false);
    expect(index.hasType('Company.App.C')).toBe(true);
    expect(index.hasNamespace('System.Linq')).toBe(true);
    expect(index.hasType('System.String')).toBe(true);
    expect(index.memberKind('Company', 'App')).toBe('namespace');
    expect(index.memberKind('System', 'String')).toBe('type');
    expect(index.memberKind('', 'Nothing')).toBeUndefined();
  });

  it('looks a name up by arity when it is given', () => {
    const index = createIndex(['namespace N { class Box<T> { } class Plain { } }']);

    expect(index.memberKind('N', 'Box')).toBe('type');
    expect(index.memberKind('N', 'Box', 0)).toBeUndefined();
    expect(index.memberKind('N', 'Box', 1)).toBe('type');
    expect(index.memberKind('N', 'Plain', 0)).toBe('type');
    expect(index.memberKind('System', 'Action', 0)).toBe('type');
    expect(index.memberKind('System', 'Action', 2)).toBe('type');
    expect(index.memberKind('System.Collections.Generic', 'List', 0)).toBeUndefined();
    expect(index.memberKind('System.Collections.Generic', 'List', 1)).toBe('type');
  });

  it('tells a member declared only in a conditional branch', () => {
    const index = createIndex(['namespace A\n{\n#if X\n    class C { }\n    class D { }\n#endif\n}\n', 'namespace A { class D { } }']);

    expect(index.declaredOnlyConditionally('A', 'C')).toBe(true);
    expect(index.declaredOnlyConditionally('A', 'D')).toBe(false);
    expect(index.declaredOnlyConditionally('', 'A')).toBe(false);
    expect(index.declaredOnlyConditionally('System', 'String')).toBe(false);
  });

  it('does not list the analyzers and source generators shipped in the reference packs', () => {
    const index = createIndex([]);

    expect(Object.keys(BCL_TYPES).filter((namespace) => /^Microsoft\.Interop\b|SourceGeneration|\.Generators?\b|\.Analyzers\b/.test(namespace))).toEqual([]);
    expect(index.hasNamespace('System.Text.Json.SourceGeneration')).toBe(false);
    expect(index.hasNamespace('Microsoft.Interop')).toBe(false);
    expect(index.hasNamespace('System.Text.Json.Serialization')).toBe(true);
  });

  it('lists the members of a scope and the extension methods of a namespace', () => {
    const index = createIndex(['namespace N { class C { } namespace Inner { } static class E { public static int M(this int x) => x; } }']);

    expect([...index.membersOf('N')].sort()).toEqual([['C', 'type'], ['E', 'type'], ['Inner', 'namespace']]);
    expect([...(index.extensionMethodsOf('N') ?? [])]).toEqual(['M']);
    expect(index.extensionMethodsOf('System.Linq')?.has('Where')).toBe(true);
    expect(index.extensionMethodsOf('Missing')?.size).toBe(0);
  });

  it('reports an unknown set of extension methods where C# 14 extension blocks may add some', () => {
    expect(createIndex(['namespace N { static class E { extension(int x) { } } }']).extensionMethodsOf('N')).toBeUndefined();
  });
});

describe('layout of a file', () => {
  it('reads extern aliases, global usings, aliases and static usings', () => {
    const source = 'extern alias V1;\nglobal using G = System.String;\nusing static System.Math;\nusing V1::Ext;\nusing Str = System.String;\nnamespace N;\n';
    const layout = analyzeLayout(source);

    expect(layout.externs.map((item) => item.name)).toEqual(['V1']);
    expect(layout.usings.map((item) => [item.isGlobal, item.isStatic, item.alias ?? null])).toEqual([
      [true, false, 'G'],
      [false, true, null],
      [false, false, null],
      [false, false, 'Str'],
    ]);
    expect(layout.ok).toBe(true);
    expect(layout.otherTopLevel).toBe(false);
  });

  it('tells a using directive from a using statement of top-level statements', () => {
    const layout = analyzeLayout('using System;\nusing var stream = new System.IO.MemoryStream();\nusing (var other = stream) { }\n');

    expect(layout.usings).toHaveLength(1);
    expect(layout.otherTopLevel).toBe(true);
  });

  it('reads nested and file-scoped namespaces with their directives', () => {
    const layout = analyzeLayout('namespace A.B\n{\n    extern alias V1;\n    using System;\n\n    namespace C\n    {\n        using System.Text;\n        class D { }\n    }\n}\n');
    const [outer, inner] = layout.namespaces;

    expect(layout.topLevel).toEqual([outer]);
    expect([outer.kind, outer.fullName, outer.externs.length, outer.usings.length, outer.hasMembers]).toEqual(['block', 'A.B', 1, 1, true]);
    expect([inner.fullName, inner.usings.length, inner.parent]).toEqual(['A.B.C', 1, outer]);
    expect(analyzeLayout('namespace A;\nusing System;\nclass C { }\n').namespaces[0]).toMatchObject({ kind: 'file', usings: [expect.anything()] });
  });

  it('notes global attributes and other top-level members', () => {
    const layout = analyzeLayout('using System;\n[assembly: CLSCompliant(true)]\nclass Top { }\nnamespace N { }\n');

    expect(layout.hasGlobalAttributes).toBe(true);
    expect(layout.otherTopLevel).toBe(true);
    expect(layout.topLevel).toHaveLength(1);
  });

  it('reads a namespace that directly follows global attributes', () => {
    const layout = analyzeLayout('using System;\n[assembly: CLSCompliant(true)]\n[module: System.Runtime.CompilerServices.SkipLocalsInit]\nnamespace Demo\n{\n    using System.Text;\n    class C { }\n}\n');

    expect([layout.hasGlobalAttributes, layout.otherTopLevel, layout.ok]).toEqual([true, true, true]);
    expect(layout.topLevel.map((namespace) => [namespace.fullName, namespace.usings.length])).toEqual([['Demo', 1]]);
  });

  it('is not ok when the braces do not balance', () => {
    expect(analyzeLayout('namespace A\n{\n    using System;\n').ok).toBe(false);
  });

  it('separates comments and preprocessor directives from code', () => {
    const source = '// header\n#region R\nusing System; // tail\n#endregion\n';
    const layout = analyzeLayout(source);

    expect(layout.comments.map((comment) => source.slice(comment.start, comment.end))).toEqual(['// header', '// tail']);
    expect(layout.directives.map((directive) => directive.type)).toEqual(['preproc_region', 'preproc_endregion']);
  });
});
