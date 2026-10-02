import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveEditorConfigProperties } from '../src/cleanup/editorconfig';
import { unsupportedEditorConfigSettings } from '../src/cleanup/editorConfigRegistry';
import { ProjectInfo } from '../src/cleanup/projectInfo';
import { createEditorConfigCodeStyleConverter } from '../src/cleanup/transformations/editorConfigCodeStyle';

function lines(...text: string[]): string {
  return `${text.join('\n')}\n`;
}

function method(...body: string[]): string {
  return lines('using System;', 'using System.Linq;', '', 'class C', '{', '    void M(object o, string[] items)', '    {', ...body.map((line) => `        ${line}`), '    }', '}');
}

const LATEST: ProjectInfo = { directory: '/repo', targetFrameworks: ['net9.0'], languageVersion: 99, modernRuntime: true, nullable: 'enable' };

function codeStyle(source: string, rules: string, project: ProjectInfo | undefined = LATEST): { output: string; issues: string[] } {
  const props = resolveEditorConfigProperties([{ directory: '/repo', text: `root = true\n[*.cs]\n${rules}\n` }], '/repo/Sample.cs');
  const issues: string[] = [];
  const output = createEditorConfigCodeStyleConverter(props, (issue) => issues.push(issue), { project }).apply(source);

  return { output, issues };
}

const enforced = (id: string): string => `dotnet_diagnostic.${id}.severity = warning`;

describe('newer rules', () => {
  it('are supported, so they are not listed as unsupported', () => {
    const settings = [
      ...['IDE0280', 'IDE0380', 'IDE0064', 'IDE0240', 'IDE0241', 'IDE0120', 'IDE0121', 'IDE0001', 'IDE0002', 'IDE0079', 'IDE0390', 'IDE0391', 'IDE0260', 'IDE0270'].map(enforced),
      'csharp_prefer_static_anonymous_function = true:warning',
      'csharp_style_prefer_simple_property_accessors = true:warning',
      'csharp_style_prefer_top_level_statements = false:warning',
      'dotnet_style_prefer_foreach_explicit_cast_in_source = always:warning',
      'csharp_style_unused_value_expression_statement_preference = discard_variable:warning',
      'csharp_style_unused_value_assignment_preference = discard_variable:warning',
      'dotnet_remove_unnecessary_suppression_exclusions = none:warning',
    ];
    const props = resolveEditorConfigProperties([{ directory: '/repo', text: `root = true\n[*.cs]\n${settings.join('\n')}\n` }], '/repo/Sample.cs');

    expect(unsupportedEditorConfigSettings(props)).toEqual([]);
  });

  it('IDE0270 folds a null check that throws into the declaration, for plain reference types', () => {
    const before = method('string s = o as string;', 'if (s == null) throw new ArgumentException();', 'object u = Find();', 'if (u is null)', '{', '    throw new InvalidOperationException();', '}', 'var v = Find();', 'if (v == null) throw new Exception();');
    const after = method('string s = o as string ?? throw new ArgumentException();', 'object u = Find() ?? throw new InvalidOperationException();', 'var v = Find();', 'if (v == null) throw new Exception();');

    expect(codeStyle(before, 'dotnet_style_coalesce_expression = true:warning\ndotnet_diagnostic.IDE0270.severity = none').output).toBe(before);
    expect(codeStyle(before, 'dotnet_style_coalesce_expression = true\ndotnet_diagnostic.IDE0270.severity = warning').output).toBe(after);
  });

  it('IDE0260 turns an `as` compared with null into `is`, and reports `?.` reads', () => {
    const before = method('if ((o as string) != null) { }', 'if ((o as string) == null) { }', 'if ((o as Uri) != null) { }', 'var n = (o as Uri)?.Host;');
    const { output, issues } = codeStyle(before, 'csharp_style_pattern_matching_over_as_with_null_check = true\ndotnet_diagnostic.IDE0260.severity = warning');

    expect(output).toBe(method('if (o is string) { }', 'if (o is not string) { }', 'if ((o as Uri) != null) { }', 'var n = (o as Uri)?.Host;'));
    expect(issues).toEqual([expect.stringMatching(/^IDE0260 .*line 11: .*'\(o as Uri\)\?\.Host'/)]);
  });

  it('IDE0280 uses nameof for parameter names in NotNullIfNotNull and CallerArgumentExpression', () => {
    const before = lines(
      'class C',
      '{',
      '    [return: NotNullIfNotNull("input")]',
      '    string? M(string? input, [CallerArgumentExpression("input")] string expression = "") => input;',
      '    void N([NotNullIfNotNull("other")] string? value) { }',
      '}'
    );
    const after = lines(
      'class C',
      '{',
      '    [return: NotNullIfNotNull(nameof(input))]',
      '    string? M(string? input, [CallerArgumentExpression(nameof(input))] string expression = "") => input;',
      '    void N([NotNullIfNotNull("other")] string? value) { }',
      '}'
    );

    expect(codeStyle(before, enforced('IDE0280')).output).toBe(after);
    expect(codeStyle(before, enforced('IDE0280'), { ...LATEST, languageVersion: 10 }).output).toBe(before);
  });

  it('IDE0320 makes lambdas that capture nothing static', () => {
    const before = lines(
      'using System;',
      '',
      'class C',
      '{',
      '    int _field;',
      '    static int Twice(int x) => x * 2;',
      '    void M(int p)',
      '    {',
      '        Func<int, int> a = x => x + 1;',
      '        Func<int, int> b = x => x + p;',
      '        Func<int, int> c = x => x + _field;',
      '        Func<int, int> d = x => Math.Abs(Twice(x));',
      '        Func<int, int> e = delegate (int x) { return x; };',
      '        Func<int, int> f = static x => x;',
      '        Func<int, int> g = x => this.GetHashCode();',
      '        Func<int, Task> h = async x => await Task.Delay(x);',
      '        Func<int, Task> i = static async x => await Task.Delay(x);',
      '        Action<int> j = static v => { Console.WriteLine(v); };',
      '    }',
      '}'
    );
    const after = before
      .replace('a = x => x + 1', 'a = static x => x + 1')
      .replace('d = x => Math.Abs', 'd = static x => Math.Abs')
      .replace('e = delegate (int x)', 'e = static delegate (int x)')
      .replace('h = async x', 'h = static async x');

    expect(codeStyle(before, 'csharp_prefer_static_anonymous_function = true:warning').output).toBe(after);
    const derived = before.replace('class C', 'class C : Base');
    expect(codeStyle(derived, 'csharp_prefer_static_anonymous_function = true:warning').output).toBe(derived.replace('a = x => x + 1', 'a = static x => x + 1').replace('e = delegate (int x)', 'e = static delegate (int x)'));
  });

  it('IDE0320 treats an accessor\'s value as captured and recognizes static async lambdas', () => {
    const source = lines(
      'using System;',
      'using System.Threading.Tasks;',
      '',
      'class C',
      '{',
      '    int P',
      '    {',
      '        get => 0;',
      '        set { Action a = () => Console.WriteLine(value); a(); }',
      '    }',
      '    void M()',
      '    {',
      '        Func<int, Task> h = static async x => await Task.Delay(x);',
      '        Func<int, Task> i = static async x => { await Task.Delay(x); };',
      '        Func<int, int> k = x => x;',
      '    }',
      '}'
    );
    const { output, issues } = codeStyle(source, 'csharp_prefer_static_anonymous_function = true:warning');

    expect(output).toBe(source.replace('k = x => x', 'k = static x => x'));
    expect(issues).toEqual([]);
  });

  it('IDE0059 keeps an initializer a local function or lambda of the member may read', () => {
    const source = lines(
      'class C',
      '{',
      '    int M()',
      '    {',
      '        int x = 0;',
      '        x = Next();',
      '        int y = 0;',
      '        y = 5;',
      '        System.Func<int> read = () => y;',
      '        return x + read();',
      '        int Next() => x + 1;',
      '    }',
      '}'
    );
    const { output } = codeStyle(source, 'csharp_style_unused_value_assignment_preference = discard_variable:warning');

    expect(output).toBe(source);
  });

  it('IDE0360 simplifies accessors that only read or write field (C# 14)', () => {
    const before = lines('class C', '{', '    int P { get { return field; } set { field = value; } }', '    int Q { get => field; set => field = value > 0 ? value : 0; }', '}');
    const after = lines('class C', '{', '    int P { get; set; }', '    int Q { get; set => field = value > 0 ? value : 0; }', '}');

    expect(codeStyle(before, 'csharp_style_prefer_simple_property_accessors = true:warning').output).toBe(after);
    expect(codeStyle(before, 'csharp_style_prefer_simple_property_accessors = true:warning', { ...LATEST, languageVersion: 13 }).output).toBe(before);
  });

  it('IDE0380 removes unsafe when the declaration uses no pointer syntax', () => {
    const before = lines('unsafe class A', '{', '    void M() { var x = 5; }', '}', 'class B', '{', '    unsafe void N(int* p) { }', '    unsafe void O(int v) { System.Console.WriteLine(v); }', '}');
    const after = lines('class A', '{', '    void M() { var x = 5; }', '}', 'class B', '{', '    unsafe void N(int* p) { }', '    void O(int v) { System.Console.WriteLine(v); }', '}');

    expect(codeStyle(before, enforced('IDE0380')).output).toBe(after);
  });

  it('IDE0064 makes the readonly fields of a struct that assigns `this` writable', () => {
    const before = lines('struct S', '{', '    public readonly int Value;', '    static readonly int Shared = 1;', '    public S(int value) { Value = value; }', '    public void Reset() { this = new S(5); }', '}');
    const after = lines('struct S', '{', '    public int Value;', '    static readonly int Shared = 1;', '    public S(int value) { Value = value; }', '    public void Reset() { this = new S(5); }', '}');

    expect(codeStyle(before, enforced('IDE0064')).output).toBe(after);
  });

  it('IDE0240 removes #nullable directives that repeat the current context; IDE0241 reports #nullable disable around enums', () => {
    const before = lines('#nullable enable', 'class C', '{', '}', '#nullable disable', 'enum E { A }', '#nullable restore');
    const { output, issues } = codeStyle(before, `${enforced('IDE0240')}\n${enforced('IDE0241')}`);

    expect(output).toBe(lines('class C', '{', '}', '#nullable disable', 'enum E { A }', '#nullable restore'));
    expect(issues).toEqual([expect.stringMatching(/^IDE0241 line 4: /)]);
    const unknownProject = codeStyle(before, enforced('IDE0240'), { directory: '/repo' });
    expect(unknownProject.output).toBe(before);
  });

  it('IDE0120 and IDE0121 simplify Where followed by a predicate method or a cast', () => {
    const before = method(
      'var a = items.Where(x => x.Length > 1).Any();',
      'var b = items.Where(x => x != null).Count();',
      'var c = items.Where((x, i) => i > 0).First();',
      'var d = new object[0].Where(x => x is string).Cast<string>();',
      'var e = new object[0].Where(x => x is int).Select(x => (int)x);'
    );
    const after = method(
      'var a = items.Any(x => x.Length > 1);',
      'var b = items.Count(x => x != null);',
      'var c = items.Where((x, i) => i > 0).First();',
      'var d = new object[0].OfType<string>();',
      'var e = new object[0].OfType<int>();'
    );

    expect(codeStyle(before, `${enforced('IDE0120')}\n${enforced('IDE0121')}`).output).toBe(after);
    const ownWhere = before.replace('class C\n{', 'class C\n{\n    int Where(int x) => x;');
    expect(codeStyle(ownWhere, `${enforced('IDE0120')}\n${enforced('IDE0121')}`).output).toBe(ownWhere);
  });

  it('IDE0002 drops the type from static members used inside it; IDE0001 drops imported namespaces where no other type can bind', () => {
    const before = lines(
      'using System;',
      'using System.IO;',
      '',
      'class C',
      '{',
      '    static int Count;',
      '    static void M1() { }',
      '    void M2(int Count2)',
      '    {',
      '        C.M1();',
      '        var n = C.Count;',
      '        System.IO.FileInfo file = null;',
      '        System.Timers.Timer timer = null;',
      '    }',
      '}'
    );
    const after = before.replace('C.M1();', 'M1();').replace('C.Count;', 'Count;').replace('System.IO.FileInfo file', 'FileInfo file');

    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-ide0001-'));
    try {
      fs.writeFileSync(path.join(folder, 'App.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>');
      fs.writeFileSync(path.join(folder, 'Other.cs'), 'class Other { }\n');
      const project: ProjectInfo = { ...LATEST, directory: folder };

      expect(codeStyle(before, `${enforced('IDE0001')}\n${enforced('IDE0002')}`, project).output).toBe(after);
      const thirdParty = before.replace('using System.IO;', 'using System.IO;\nusing Vendor.Library;');
      expect(codeStyle(thirdParty, enforced('IDE0001'), project).output).toBe(thirdParty);
      fs.writeFileSync(path.join(folder, 'FileInfo.cs'), 'class FileInfo { }\n');
      expect(codeStyle(before, enforced('IDE0001'), { ...project }).output).toBe(before);
      expect(codeStyle(before, enforced('IDE0001'), { directory: '/missing' }).output).toBe(before);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it('IDE0058 discards the unused value of a call to a method of the file; IDE0059 drops an initializer overwritten right away', () => {
    const before = lines(
      'class C',
      '{',
      '    int Compute() => 1;',
      '    void Run() { }',
      '    void M()',
      '    {',
      '        Compute();',
      '        Run();',
      '        int v = 0;',
      '        v = Compute();',
      '        int w = Compute();',
      '        w = 2;',
      '        _ = v + w;',
      '    }',
      '}'
    );
    const after = before.replace('        Compute();\n        Run();', '        _ = Compute();\n        Run();').replace('int v = 0;', 'int v;');
    const { output, issues } = codeStyle(
      before,
      'csharp_style_unused_value_expression_statement_preference = discard_variable:warning\ncsharp_style_unused_value_assignment_preference = discard_variable:warning'
    );

    expect(output).toBe(after);
    expect(issues).toEqual([expect.stringMatching(/^IDE0059 .*line 11: /)]);
  });

  it('IDE0058 only discards the value of a method of the type that makes the call', () => {
    const source = lines(
      'class A',
      '{',
      '    int Run() => 1;',
      '    int Own() => 1;',
      '    void M() { Run(); Own(); }',
      '}',
      'class B : Base',
      '{',
      '    int Own() => 1;',
      '    void M() { Run(); Own(); }',
      '}',
      'class C',
      '{',
      '    void M() { Run(); }',
      '}',
      'partial class D',
      '{',
      '    int Twice(int x) => x * 2;',
      '    void M() { Twice(1); }',
      '}'
    );
    const { output } = codeStyle(source, 'csharp_style_unused_value_expression_statement_preference = discard_variable:warning');

    expect(output).toBe(source.replace('void M() { Run(); Own(); }', 'void M() { _ = Run(); _ = Own(); }'));
  });

  it('IDE0058 binds a call in an interface nested in a class to the interface, not the outer class', () => {
    const source = lines(
      'class C',
      '{',
      '    static int Run() => 1;',
      '    interface I',
      '    {',
      '        void Run();',
      '        void M() { Run(); }',
      '    }',
      '    interface J',
      '    {',
      '        int Count();',
      '        void M() { Count(); }',
      '    }',
      '    interface K : I',
      '    {',
      '        int Own();',
      '        void N() { Own(); }',
      '    }',
      '}'
    );
    const { output } = codeStyle(source, 'csharp_style_unused_value_expression_statement_preference = discard_variable:warning');

    expect(output).toBe(source.replace('void M() { Count(); }', 'void M() { _ = Count(); }'));
  });

  it('IDE0058 still discards in a class whose base list names only interfaces', () => {
    const source = lines(
      'using System;',
      'interface IService { void M(); }',
      'class Service : IService',
      '{',
      '    int Save() => 1;',
      '    public void M() { Save(); }',
      '}',
      'record R(int X) : IEquatable<R>, IService',
      '{',
      '    int Load() => 1;',
      '    public void M() { Load(); }',
      '}',
      'class Derived : Service, IService',
      '{',
      '    int Keep() => 1;',
      '    public void N() { Keep(); }',
      '}'
    );
    const { output } = codeStyle(source, 'csharp_style_unused_value_expression_statement_preference = discard_variable:warning');

    expect(output).toBe(source.replace('{ Save(); }', '{ _ = Save(); }').replace('{ Load(); }', '{ _ = Load(); }'));
  });

  it('IDE0058 and IDE0320 treat an interface declared in another file of the project as an interface', () => {
    const source = lines(
      'using System;',
      'class Service : IService',
      '{',
      '    int Save() => 1;',
      '    static int Twice(int x) => x * 2;',
      '    public void M() { Save(); Func<int, int> f = x => Twice(x); }',
      '}'
    );
    const rules = 'csharp_style_unused_value_expression_statement_preference = discard_variable:warning\ncsharp_prefer_static_anonymous_function = true:warning';
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-ide0058-'));
    try {
      fs.writeFileSync(path.join(folder, 'App.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>');
      fs.writeFileSync(path.join(folder, 'IService.cs'), 'interface IService { void M(); }\n');
      const project: ProjectInfo = { ...LATEST, directory: folder };

      expect(codeStyle(source, rules, project).output).toBe(source.replace('{ Save();', '{ _ = Save();').replace('= x => Twice', '= static x => Twice'));
      fs.writeFileSync(path.join(folder, 'IService.cs'), 'class IService { public virtual int Save() => 0; }\n');
      expect(codeStyle(source, rules, { ...project }).output).toBe(source);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it('reports top-level statements, hidden foreach casts, unneeded suppressions and async methods without await', () => {
    const source = lines(
      '#pragma warning disable IDE0005',
      'using System.Collections.Generic;',
      '#pragma warning restore IDE0005',
      '',
      'internal class Program',
      '{',
      '    static void Main() { }',
      '    async System.Threading.Tasks.Task Run(List<object> items)',
      '    {',
      '        foreach (string s in items) { }',
      '    }',
      '}'
    );
    const { output, issues } = codeStyle(
      source,
      [
        'csharp_style_prefer_top_level_statements = true:warning',
        'dotnet_style_prefer_foreach_explicit_cast_in_source = always:warning',
        enforced('IDE0079'),
        'dotnet_diagnostic.IDE0005.severity = none',
        enforced('IDE0390'),
      ].join('\n')
    );

    expect(output).toBe(source);
    expect(issues).toEqual([
      expect.stringMatching(/^IDE0079 line 1: .*IDE0005/),
      expect.stringMatching(/^IDE0390 line 8: 'Run'/),
      expect.stringMatching(/^IDE0210 \(csharp_style_prefer_top_level_statements\) line 7: /),
      expect.stringMatching(/^IDE0220 \(dotnet_style_prefer_foreach_explicit_cast_in_source\) line 10: .*object.*string/),
    ]);
  });
});

describe('IDE0320 never makes a capturing lambda static (shapes found in real code)', () => {
  const RULE = 'csharp_prefer_static_anonymous_function = true:warning';
  const unchanged = (source: string): void => {
    expect(codeStyle(source, RULE).output).toBe(source);
  };

  it('keeps a lambda that reads an instance field declared with a nullable type', () => {
    unchanged(lines(
      'using System;',
      '',
      'class P',
      '{',
      '    private object? _scope;',
      '',
      '    public Func<object?> Get() => () => _scope;',
      '}'
    ));
  });

  it('keeps a lambda that reads a field of a type with a primary constructor', () => {
    unchanged(lines('using System;', '', 'class P(int x)', '{', '    private int _y = x;', '    public Func<int> Get() => () => _y + x;', '}'));
  });

  it('keeps a lambda in a constructor initializer that reads a constructor parameter', () => {
    unchanged(lines(
      'using System;',
      '',
      'class P',
      '{',
      '    public P(string device) : this(() => device)',
      '    {',
      '    }',
      '',
      '    private P(Func<string> factory)',
      '    {',
      '    }',
      '}'
    ));
  });

  it('keeps a lambda that reads an enclosing parameter inside an interpolated string', () => {
    unchanged(lines(
      'using System;',
      'using System.Linq;',
      '',
      'class P',
      '{',
      '    string[] M(string[] ids, Profile profile) => ids.Select(id => $"{id:D} of {profile.Name:D}.").ToArray();',
      '}',
      'class Profile { public string Name = ""; }'
    ));
  });

  it('keeps a lambda that reads a local only inside an interpolation hole or a nested hole', () => {
    for (const body of ['$"{local}"', '$@"{local}"', '$"""{local}"""', '$"a{$"b{local}"}"']) {
      unchanged(lines('using System;', '', 'class P', '{', '    Func<int, string> M(int local) => x => ' + body + ';', '}'));
    }
  });

  it('keeps a lambda whose with expression reads a local, a parameter or a closure of the method', () => {
    unchanged(lines(
      'using System;',
      'using System.Linq;',
      '',
      'record State(int Count, string Names, int[] Items);',
      '',
      'class P',
      '{',
      '    void M(int[] devices, int now)',
      '    {',
      '        var tracked = devices.Where(d => d > 0).ToArray();',
      '        Update(current => current with',
      '        {',
      '            Count = tracked.Any(item => item > 1) ? now : current.Count,',
      '            Names = string.Join(",", devices.Select(item => item.ToString())),',
      '            Items = tracked,',
      '        });',
      '    }',
      '',
      '    void Update(Func<State, State> change) { }',
      '}'
    ).replace('Where(d => d > 0)', 'Where(static d => d > 0)'));
  });

  it.each([
    ['a local declared in an earlier statement', ['var source = new Item("a");', 'var found = new[] { new Item("a") }.FirstOrDefault(i => i.Name == source.Name);']],
    ['a local used after an await', ['var source = new Item("a");', 'await System.Threading.Tasks.Task.Delay(1);', 'var found = new[] { new Item("a") }.FirstOrDefault(i => i.Name == source.Name);']],
    ['a local function of the program', ['int Twice(int x) => x * 2;', 'var found = new[] { 1, 2 }.Select(i => Twice(i));']],
    ['a lambda inside an if statement', ['var source = new Item("a");', 'if (source.Name.Length > 0)', '{', '    var found = new[] { new Item("a") }.Any(i => i.Name == source.Name);', '}']],
  ])('keeps a lambda in top-level statements that reads %s', (_name, statements) => {
    unchanged(lines('using System;', 'using System.Linq;', '', ...statements, '', 'record Item(string Name);'));
  });

  it.each([
    ['a local of a var deconstruction', ['var (a, b) = (new int[0], 1);', 'Func<int> h = () => a.Length;']],
    ['a local of a nested var deconstruction', ['var (a, (b, c)) = (1, (2, new int[0]));', 'Func<int> h = () => c.Length;']],
    ['a local of a typed deconstruction', ['(int p, int q) = (1, 2);', 'Func<int> h = () => p.GetHashCode();']],
    ['a case label pattern variable', ['switch (o)', '{', '    case string t:', '        Func<int> h = () => t.Length;', '        break;', '}']],
    ['a switch expression arm pattern variable', ['var n = o switch { string s => ((Func<int>)(() => s.Length))(), _ => 0 };']],
  ])('keeps a lambda that reads %s', (_name, statements) => {
    unchanged(lines('using System;', '', 'class C', '{', '    void M(object o)', '    {', ...statements.map((line) => `        ${line}`), '    }', '}'));
  });

  it('keeps a lambda that reads a field in a tuple literal or a case guard of its own body', () => {
    unchanged(lines(
      'using System;',
      '',
      'class C',
      '{',
      '    string _name = "";',
      '    int _count;',
      '    void M()',
      '    {',
      '        Func<int, (int, int)> pair = x => (x, _count);',
      '        Func<object, int> length = x => { switch (x) { case string t when t == _name: return t.Length; } return 0; };',
      '    }',
      '}'
    ));
  });

  it('still makes a lambda static inside a type of a file that also has top-level statements', () => {
    const source = lines('using System;', 'using System.Linq;', '', 'var total = 3;', 'Console.WriteLine(total);', '', 'class Helper', '{', '    public int[] Doubled(int[] items) => items.Select(x => x * 2).ToArray();', '}');

    expect(codeStyle(source, RULE).output).toContain('items.Select(static x => x * 2)');
  });

  it('still makes a lambda static when an interpolation only uses its own parameter and types', () => {
    const before = lines('using System;', '', 'class P', '{', '    Func<int, string> M() => x => $"{x} {Math.Abs(x)} {string.Empty}";', '}');

    expect(codeStyle(before, RULE).output).toContain('static x => $"{x}');
  });

  it('keeps a lambda in an interface nested in a class that calls an instance member of the interface', () => {
    unchanged(lines('using System;', '', 'class C', '{', '    static int Run() => 1;', '    interface I', '    {', '        int Run();', '        Func<int> M() => () => Run();', '    }', '}'));
  });

  it('keeps a lambda in a partial class that qualifies a member another part may declare', () => {
    unchanged(lines('using System;', '', 'partial class P', '{', '    Func<string> M() => () => Other.ToString();', '}'));
  });

  it('still makes a lambda static in a class whose base list names only interfaces', () => {
    const before = lines('using System;', '', 'interface IService { }', 'class S : IService, IDisposable', '{', '    static int Twice(int x) => x * 2;', '    public void Dispose() { }', '    Func<int, int> M() => x => Twice(x);', '}');

    expect(codeStyle(before, RULE).output).toContain('static x => Twice(x)');
  });
});

describe('IDE0002 inside a nested interface', () => {
  it('keeps the type qualifier where the interface declares a member of the same name', () => {
    const source = lines('class C', '{', '    static int X = 1;', '    interface I', '    {', '        int X { get; }', '        int M() => C.X;', '    }', '}');

    expect(codeStyle(source, enforced('IDE0002')).output).toBe(source);
  });
});
