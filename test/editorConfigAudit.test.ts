import { describe, expect, it } from 'vitest';
import { resolveEditorConfigProperties } from '../src/cleanup/editorconfig';
import { ProjectInfo } from '../src/cleanup/projectInfo';
import { createEditorConfigCodeStyleConverter } from '../src/cleanup/transformations/editorConfigCodeStyle';
import { createExplicitAccessModifierConverter } from '../src/cleanup/transformations/explicitAccessModifier';
import { singleStatementLambdaConverter } from '../src/cleanup/transformations/lambdaAndJson';
import { createIndex } from '../src/cleanup/usings/declarations';
import { placeUsings } from '../src/cleanup/usings/placement';
import { nullCheckPatternMatchingConverter } from '../src/cleanup/transformations/nullCheckPatternMatching';
import { outVarInliningConverter } from '../src/cleanup/transformations/outVarInlining';
import { readonlyFieldConverter } from '../src/cleanup/transformations/readonlyFieldAndSingleLineMethods';
import { varWhenApparentConverter } from '../src/cleanup/transformations/varWhenApparent';
import { createDefaultSettings } from '../src/cleanup/types';

/**
 * Cases where a rewrite would not compile or would change behavior under the C# rules; each
 * rewrite must leave them alone.
 */

function lines(...text: string[]): string {
  return `${text.join('\n')}\n`;
}

function method(...body: string[]): string {
  return lines('class C', '{', '    public int? P { get; set; }', '', '    void M(object o, int i, string s, int? n)', '    {', ...body.map((line) => `        ${line}`), '    }', '}');
}

function codeStyle(source: string, rules: string, project?: ProjectInfo): { output: string; issues: string[] } {
  const props = resolveEditorConfigProperties([{ directory: '/repo', text: `root = true\n[*.cs]\n${rules}\n` }], '/repo/C.cs');
  const issues: string[] = [];
  const output = createEditorConfigCodeStyleConverter(props, (issue) => issues.push(issue), { project }).apply(source);

  return { output, issues };
}

function expectUnchanged(source: string, rules: string, project?: ProjectInfo): void {
  expect(codeStyle(source, rules, project).output).toBe(source);
}

const OVERLOADED_EQUALS = 'class V { public static bool operator ==(V a, V b) => true; public static bool operator !=(V a, V b) => false; }';

describe('language version and runtime', () => {
  const framework: ProjectInfo = { directory: '/repo', languageVersion: 7.3, modernRuntime: false };

  it('does not use syntax the project language version lacks, and reports it', () => {
    const source = method('if (!(o is string)) { }');
    const { output, issues } = codeStyle(source, 'csharp_style_prefer_not_pattern = true:warning', framework);

    expect(output).toBe(source);
    expect(issues).toEqual([expect.stringMatching(/^csharp_style_prefer_not_pattern: not applied, the project uses C# 7\.3 and the rewrite needs C# 9\.$/)]);
    expect(codeStyle(source, 'csharp_style_prefer_not_pattern = true:warning', { directory: '/repo', languageVersion: 9 }).output).not.toBe(source);
  });

  it('does not use index and range operators without the runtime types', () => {
    expectUnchanged(method('var a = s[s.Length - 1];'), 'csharp_style_prefer_index_operator = true:warning', { directory: '/repo', languageVersion: 99, modernRuntime: false });
  });

  it('does not use unbound generic types in nameof before C# 14', () => {
    expectUnchanged(method('var a = nameof(List<int>);'), 'csharp_style_prefer_unbound_generic_type_in_nameof = true:warning', { directory: '/repo', languageVersion: 13 });
  });
});

describe('IDE0090 target-typed new', () => {
  it('keeps new for nullable value types (new() creates the underlying value) and type parameters', () => {
    const rules = 'csharp_style_implicit_object_creation_when_type_is_apparent = true:warning';

    expectUnchanged(method('int? x = new int?();', 'Nullable<int> y = new Nullable<int>();'), rules);
    expectUnchanged(lines('class G<T> where T : new()', '{', '    T M() { T t = new T(); return t; }', '}'), rules);
  });
});

describe('null checks against types that overload ==', () => {
  it('IDE0016 keeps if/throw when == may be user-defined', () => {
    const source = lines(OVERLOADED_EQUALS, 'class C', '{', '    V _v;', '    C(V v)', '    {', '        if (v == null) throw new System.ArgumentNullException();', '        _v = v;', '    }', '}');

    expectUnchanged(source, 'csharp_style_throw_expression = true:warning');
  });

  it('the pattern-matching null check setting keeps == null for such types and for non-nullable values', () => {
    const source = lines(OVERLOADED_EQUALS, 'class C { bool M(V v, int i, Unknown u) { return v == null || i == null || u == null; } }');

    expect(nullCheckPatternMatchingConverter.apply(source)).toBe(source);
  });
});

describe('null checks on non-nullable value types', () => {
  it('IDE0150 and IDE0041 leave value types alone (is null does not compile for them)', () => {
    expectUnchanged(method('if (i is object) { }'), 'csharp_style_prefer_null_check_over_type_check = true:warning');
    expectUnchanged(method('if (ReferenceEquals(i, null)) { }'), 'dotnet_style_prefer_is_null_check_over_reference_equality_method = true:warning');
  });
});

describe('IDE0074 ??=', () => {
  it('does not turn P = P ?? v into P ??= v for a property: the setter would no longer run', () => {
    const source = method('P = P ?? 1;', 'n = n ?? 1;');

    expect(codeStyle(source, 'dotnet_style_prefer_compound_assignment = true:warning').output).toBe(method('P = P ?? 1;', 'n ??= 1;'));
  });
});

describe('IDE0053 expression-bodied lambdas', () => {
  it('keeps block lambdas passed to methods: an expression body can bind to an Expression<T> overload', () => {
    expectUnchanged(method('var q = items.Where(x => { return x > 1; });'), 'csharp_style_expression_bodied_lambdas = true:warning');
  });
});

describe('IDE0200 method groups', () => {
  it('keeps lambdas calling methods with attributes ([Conditional] methods cannot become delegates)', () => {
    const source = lines('class C', '{', '    [Conditional("DEBUG")] static void Log(string t) { }', '    void M() { Action<string> a = x => Log(x); }', '}');

    expectUnchanged(source, 'csharp_style_prefer_method_group_conversion = true:warning');
  });
});

describe('IDE0032 auto properties', () => {
  it('keeps a field whose initializer would run in a different order', () => {
    const source = lines('class C', '{', '    private static int _a = Next();', '    private static int _b = Next();', '    public static int A { get { return _a; } }', '    static int Next() => 1;', '}');

    expectUnchanged(source, 'dotnet_style_prefer_auto_properties = true:warning');
  });
});

describe('readonly fields (IDE0044 and the readonly field setting)', () => {
  it('keeps fields of possibly mutable struct types whose members are called or assigned', () => {
    const source = lines('class C', '{', '    private S _s;', '    void M() { _s.Inc(); }', '}');

    expect(readonlyFieldConverter.apply(source)).toBe(source);
    expectUnchanged(source, 'dotnet_style_readonly_field = true:warning');
  });
});

describe('var when apparent', () => {
  it('keeps explicit types that differ from the initializer type', () => {
    const source = 'class C { void M() { IFoo f = new Foo(); object o = (object)1; int? n = new int?(); } }\n';

    expect(varWhenApparentConverter.apply(source)).toBe('class C { void M() { IFoo f = new Foo(); var o = (object)1; var n = new int?(); } }\n');
  });
});

describe('moving usings outside the namespace (setting and IDE0065)', () => {
  it('keeps usings that only resolve relative to the enclosing namespace', () => {
    const source = lines('namespace Oracle.Inside', '{', '    using Records;', '    using System;', '', '    class C { }', '}');
    const records = 'namespace Oracle.Inside.Records { public class R { } }\n';

    // `using Records;` means Oracle.Inside.Records here; the move qualifies it rather than writing `using Records;` at file level.
    expect(placeUsings(source, 'outside', { index: createIndex([records, source]), externalReferences: false, indent: '    ' })).toEqual({
      status: 'moved',
      text: lines('using Oracle.Inside.Records;', 'using System;', '', 'namespace Oracle.Inside', '{', '    class C { }', '}'),
    });
    // With no such namespace in the project the directive cannot be resolved, so nothing moves.
    expect(placeUsings(source, 'outside', { index: createIndex([source]), externalReferences: false, indent: '    ' })).toMatchObject({ status: 'skipped' });
  });
});

describe('inlining out variables (setting and IDE0018)', () => {
  it('keeps the declaration when the out variable would go out of scope', () => {
    const source = 'class C { void M() { int x; while (Try(out x)) { } Use(x); int y; { Get(out y); } Use(y); } }';

    expect(outVarInliningConverter.apply(source)).toBe(source);
  });
});

describe('IDE0056 index operator', () => {
  it('only uses ^ on receivers of known indexable types', () => {
    const source = method('var b = unknown[unknown.Count - 1];');

    expectUnchanged(source, 'csharp_style_prefer_index_operator = true:warning');
  });
});

describe('simplifying single-statement lambdas (setting)', () => {
  it('keeps statement lambdas and lambdas passed to methods, whose overload could change', () => {
    const source = 'class C { void M() { Task.Run(() => { Work(); }); var q = items.Where(x => { return x > 1; }); } }';

    expect(singleStatementLambdaConverter.apply(source)).toBe(source);
    expect(singleStatementLambdaConverter.apply('class C { void M() { Func<int, int> f = x => { return x + 1; }; } }')).toBe(
      'class C { void M() { Func<int, int> f = x => x + 1; } }'
    );
  });
});

describe('IDE0071 simplified interpolation', () => {
  it('keeps ToString on references, which throws on null where a hole formats an empty string', () => {
    const { output, issues } = codeStyle(method('var t = $"{s.ToString()} {o.ToString()} {i.ToString()}";'), 'dotnet_style_prefer_simplified_interpolation = true:warning');

    expect(output).toBe(method('var t = $"{s.ToString()} {o.ToString()} {i}";'));
    expect(issues).toEqual([expect.stringMatching(/IDE0071 .*'s.ToString\(\)' was kept/), expect.stringMatching(/IDE0071 .*'o.ToString\(\)' was kept/)]);
  });
});

describe('IDE0040 and the access modifier setting', () => {
  const source = lines(
    'public class Handler<T> : IHandler<T>',
    '{',
    '    Task IHandler<T>.Handle(T item) => Task.CompletedTask;',
    '    IEnumerable<(Type ExceptionType, object Action)> Actions(Type type) => null;',
    '}'
  );

  it('adds no modifier to explicit interface implementations of generic interfaces, and one before a tuple-typed member', () => {
    const expected = lines(
      'public class Handler<T> : IHandler<T>',
      '{',
      '    Task IHandler<T>.Handle(T item) => Task.CompletedTask;',
      '    private IEnumerable<(Type ExceptionType, object Action)> Actions(Type type) => null;',
      '}'
    );

    expect(codeStyle(source, 'dotnet_style_require_accessibility_modifiers = always:warning').output).toBe(expected);
    expect(createExplicitAccessModifierConverter(createDefaultSettings()).apply(source)).toBe(expected);
  });

  it('adds nothing to a member the parser could not read, or to the one after it', () => {
    const unreadable = lines('class Native', '{', '    unsafe delegate*<int, void> _callback;', '    void Run() { }', '}');

    expect(createExplicitAccessModifierConverter(createDefaultSettings()).apply(unreadable)).toBe(unreadable);
  });
});

describe('IDE0047 parentheses', () => {
  it('keeps the argument list of an awaited call in a condition', () => {
    const source = lines('class C', '{', '    async Task<bool> M(Func<int, Task<bool>> f, int x)', '    {', '        while (await f(x)) { }', '        if (await f(x)) { return true; }', '        return false;', '    }', '}');

    expectUnchanged(source, 'dotnet_style_parentheses_in_other_operators = never_if_unnecessary:warning');
  });

  it('keeps the argument list of an awaited call in an async lambda argument', () => {
    const source = lines('class C', '{', '    async Task M(Func<int, Task> f, string name)', '    {', '        await Watch(new[] { name }, async values => await f(values[0]));', '    }', '}');

    expectUnchanged(source, 'dotnet_style_parentheses_in_other_operators = never_if_unnecessary:warning');
  });
});

describe('IDE0160 block-scoped namespace', () => {
  it('reports instead of converting a namespace that a conditional directive wraps', () => {
    const source = lines('#if NETFRAMEWORK', 'namespace System.Runtime.CompilerServices;', '', 'internal sealed class X', '{', '}', '#endif');
    const { output, issues } = codeStyle(source, 'csharp_style_namespace_declarations = block_scoped:warning');

    expect(output).toBe(source);
    expect(issues).toEqual([expect.stringMatching(/IDE0160 .*#if/)]);
  });
});

describe('IDE0003 this. qualification', () => {
  it('keeps this. where (Name) followed by an operand would read as a cast', () => {
    const source = lines(
      'class C',
      '{',
      '    System.Func<int, int> Transform;',
      '    C Self;',
      '    int M(int x) => (this.Transform)(5) + (this.Self.Transform)(x) + (this.Transform)(-x) + this.Transform(1);',
      '    bool N() => (this.Self) is null || (this.Self) == null;',
      '}'
    );
    const { output } = codeStyle(source, 'dotnet_style_qualification_for_field = false:warning');

    expect(output).toBe(source.replace('this.Transform(1)', 'Transform(1)').replace('(this.Self) is null || (this.Self) == null', '(Self) is null || (Self) == null'));
  });
});
