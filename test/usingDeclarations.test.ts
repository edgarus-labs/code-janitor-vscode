import { describe, expect, it } from 'vitest';
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

    expect(keys(source)).toEqual(['N:N', 'T:N.C', 'T:N.C.E', 'T:N.C.Nested', 'T:N.D', 'T:N.Generic', 'T:N.I', 'T:N.P', 'T:N.Q', 'T:N.R', 'T:N.S']);
  });

  it('does not take constraints, typeof or local code for declarations', () => {
    const source = `namespace N
{
    class C<T> where T : class, new()
    {
        void M() { var t = typeof(C<>); class Local { } }
    }
}`;

    expect(keys(source)).toEqual(['N:N', 'T:N.C']);
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

  it('counts a declaration in a disabled #if branch too', () => {
    expect(keys('#if X\nnamespace A { class C { } }\n#else\nnamespace B { class D { } }\n#endif\n')).toEqual(['N:A', 'N:B', 'T:A.C', 'T:B.D']);
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
