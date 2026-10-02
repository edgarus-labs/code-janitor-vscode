import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveEditorConfigProperties } from '../src/cleanup/editorconfig';
import { findProject } from '../src/cleanup/projectInfo';
import { runCleanup } from '../src/cleanup/runCleanup';
import { createDefaultSettings } from '../src/cleanup/types';
import { createEditorConfigCodeStyleConverter, EditorConfigCodeStyleOptions } from '../src/cleanup/transformations/editorConfigCodeStyle';

function lines(...text: string[]): string {
  return `${text.join('\n')}\n`;
}

function cleanup(source: string, rules: string, options: EditorConfigCodeStyleOptions = {}): { output: string; issues: string[] } {
  const props = resolveEditorConfigProperties([{ directory: '/repo', text: `root = true\n[*.cs]\n${rules}\n` }], '/repo/src/Sample.cs');
  const issues: string[] = [];
  const output = createEditorConfigCodeStyleConverter(props, (issue) => issues.push(issue), options).apply(source);

  return { output, issues };
}

const temporaryFolders: string[] = [];

afterEach(() => {
  for (const folder of temporaryFolders.splice(0)) {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

/** A project folder with a `.csproj` and the given files; returns the options for cleaning `file`. */
function project(files: Record<string, string>, file: string, csproj = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>'): EditorConfigCodeStyleOptions {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-quality-'));
  temporaryFolders.push(folder);
  fs.writeFileSync(path.join(folder, 'App.csproj'), csproj);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
    fs.writeFileSync(path.join(folder, name), text);
  }

  const filePath = path.join(folder, file);

  return { filePath, fileName: path.basename(filePath), project: findProject(filePath) };
}

describe('CA1822 mark members as static', () => {
  const warning = 'dotnet_diagnostic.CA1822.severity = warning';

  it('keeps a member instance when this appears in code the parser reads as loose tokens', () => {
    const source = lines(
      'internal class C',
      '{',
      '    private IEnumerable<(int A, object B)> Pairs(int x)',
      '    {',
      '        yield return (x, this);',
      '    }',
      '}'
    );

    expect(cleanup(source, warning).output).toBe(source);
  });

  it('makes private members that use no instance data static and drops this. at their call sites', () => {
    const source = lines(
      'public class Printer',
      '{',
      '    private readonly string _name = "x";',
      '',
      '    public string Name() => _name + this.Suffix() + Twice;',
      '',
      '    private string Suffix()',
      '    {',
      '        return "!";',
      '    }',
      '',
      '    private int Twice => 2 * 2;',
      '}'
    );

    expect(cleanup(source, warning)).toEqual({
      output: lines(
        'public class Printer',
        '{',
        '    private readonly string _name = "x";',
        '',
        '    public string Name() => _name + Suffix() + Twice;',
        '',
        '    private static string Suffix()',
        '    {',
        '        return "!";',
        '    }',
        '',
        '    private static int Twice => 2 * 2;',
        '}'
      ),
      issues: [],
    });
  });

  it('follows calls: a member only calling members that became static becomes static too', () => {
    const source = lines(
      'class Calculator',
      '{',
      '    private int Add(int a, int b) => a + b;',
      '    private int AddThree(int a) => Add(a, 3);',
      '    private int Count(int n) => n <= 0 ? 0 : Count(n - 1);',
      '}'
    );

    expect(cleanup(source, warning).output).toBe(
      lines(
        'class Calculator',
        '{',
        '    private static int Add(int a, int b) => a + b;',
        '    private static int AddThree(int a) => Add(a, 3);',
        '    private static int Count(int n) => n <= 0 ? 0 : Count(n - 1);',
        '}'
      )
    );
  });

  it('keeps members that use instance data, this, base or members of object', () => {
    const source = lines(
      'class Holder(int seed)',
      '{',
      '    private int _value;',
      '    private int Field() => _value;',
      '    private int Seed() => seed;',
      '    private object Self() => this;',
      '    private string Text() => ToString();',
      '    private string Interpolated() => $"{this}";',
      '    private int Shadowed(int _value) => _value;',
      '}'
    );

    const result = cleanup(source, warning);

    expect(result.output).toBe(source.replace('private int Shadowed', 'private static int Shadowed'));
    expect(result.issues).toEqual([]);
  });

  it('leaves members Roslyn does not analyze alone without reporting them', () => {
    const source = lines(
      'using System;',
      'class Tests : IDisposable',
      '{',
      '    [Fact] public void Test() { }',
      '    [TestMethod] private void Other() { }',
      '    [Obsolete] private void Old() { }',
      '    void IDisposable.Dispose() { }',
      '    private void NotYet() => throw new NotImplementedException();',
      '    private void OnClick(object sender, EventArgs e) { }',
      '    private int Auto { get; set; }',
      '    private void Handler() { }',
      '    private Action Delegate() => Handler;',
      '#pragma warning disable CA1822',
      '    private void Suppressed() { }',
      '#pragma warning restore CA1822',
      '}'
    );

    const result = cleanup(source, warning);

    expect(result.output).toBe(source);
    expect(result.issues).toEqual([]);
  });

  it('reports members it cannot prove safe to change', () => {
    const source = lines(
      'public class Service : ServiceBase',
      '{',
      '    public int Api() => 1;',
      '    private int Helper() => Inherited();',
      '    private int Plain(int x) => x;',
      '    private void Caller(Service other) => other.Plain(this.GetHashCode());',
      '}',
      'partial class Part',
      '{',
      '    private int Local(int x) => x;',
      '}',
      'struct Point',
      '{',
      '    public readonly int Zero() => 0;',
      '}'
    );

    const result = cleanup(source, warning);

    expect(result.output).toBe(source);
    expect(result.issues).toEqual([
      expect.stringMatching(/^CA1822 line 3: 'Api' .*may implement a member of ServiceBase/),
      expect.stringMatching(/^CA1822 line 4: 'Helper' .*'Inherited'.*inherited/),
      expect.stringMatching(/^CA1822 line 5: 'Plain' .*line 6/),
      expect.stringMatching(/^CA1822 line 10: 'Local' .*partial/),
      expect.stringMatching(/^CA1822 line 14: 'Zero' .*readonly/),
    ]);
  });

  it('leaves public members that may implement an interface member alone', () => {
    const source = lines(
      'using System.Collections.Generic;',
      'interface IClient { bool IsConfigured { get; } }',
      'class Owner',
      '{',
      '    private sealed class Comparer : IEqualityComparer<string[]>',
      '    {',
      '        public bool Equals(string[] x, string[] y) => x.Length == y.Length;',
      '        public int GetHashCode(string[] value) => value.Length;',
      '    }',
      '    private sealed class Fake : IClient',
      '    {',
      '        public bool IsConfigured => true;',
      '    }',
      '    private sealed class Loader : IAnalyzerAssemblyLoader',
      '    {',
      '        public void AddDependencyLocation(string path) { }',
      '    }',
      '    private sealed class Plain : IClient',
      '    {',
      '        public bool IsConfigured => false;',
      '        public int Helper() => 1;',
      '    }',
      '}'
    );

    const result = cleanup(source, warning);

    expect(result.output).toBe(source.replace('public int Helper()', 'public static int Helper()'));
    expect(result.issues).toEqual([expect.stringMatching(/^CA1822 line 16: 'AddDependencyLocation' .*may implement a member of IAnalyzerAssemblyLoader/)]);
  });

  it('reports instead of fixing when a member declaration of the type cannot be parsed', () => {
    const source = lines(
      'class Run',
      '{',
      '    private readonly unsafe delegate*<int, void> _applied;',
      '    private unsafe void Record(int id) => _applied(id);',
      '}'
    );

    const result = cleanup(source, warning);

    expect(result.output).toBe(source);
    expect(result.issues).toEqual([expect.stringMatching(/^CA1822 line 4: 'Record' .*could not read every member declaration of Run/)]);
  });

  it('reports a property with a readonly accessor, which a static property cannot have (CS0106)', () => {
    const source = lines('struct Point', '{', '    private int Zero { readonly get => 0; }', '}');

    const result = cleanup(source, warning);
    expect(result.output).toBe(source);
    expect(result.issues).toEqual([expect.stringMatching(/^CA1822 line 3: 'Zero' .*readonly/)]);
  });

  it('honors dotnet_code_quality api_surface', () => {
    const source = lines('class C', '{', '    private int One() => 1;', '    internal int Two() => 2;', '}');
    const options = project({ 'C.cs': source }, 'C.cs');

    expect(cleanup(source, `${warning}\ndotnet_code_quality.CA1822.api_surface = internal`, options).output).toBe(
      lines('class C', '{', '    private int One() => 1;', '    internal static int Two() => 2;', '}')
    );
    expect(cleanup(source, `${warning}\ndotnet_code_quality.Performance.api_surface = private`, options).output).toBe(
      lines('class C', '{', '    private static int One() => 1;', '    internal int Two() => 2;', '}')
    );
  });

  it('changes an internal member only when no other project file uses a member of that name through an instance', () => {
    const source = lines('class Math2', '{', '    internal int Square(int x) => x * x;', '}');

    const unused = project({ 'Math2.cs': source, 'Other.cs': 'class Other { int M() => 1; }\n' }, 'Math2.cs');
    expect(cleanup(source, warning, unused)).toEqual({
      output: lines('class Math2', '{', '    internal static int Square(int x) => x * x;', '}'),
      issues: [],
    });

    const used = project({ 'Math2.cs': source, 'Other.cs': 'class Other { int M(Math2 m) => m.Square(2); }\n' }, 'Math2.cs');
    const result = cleanup(source, warning, used);
    expect(result.output).toBe(source);
    expect(result.issues).toEqual([expect.stringMatching(/^CA1822 line 3: 'Square' .*another file/)]);

    const noProject = cleanup(source, warning);
    expect(noProject.output).toBe(source);
    expect(noProject.issues).toEqual([expect.stringMatching(/^CA1822 line 3: 'Square' .*project/)]);
  });

  it('keeps an internal member another file uses inside an interpolated string or a property pattern', () => {
    const helper = lines('internal class Helper', '{', '    public string Format() => "x";', '}');
    const interpolated = project({ 'Helper.cs': helper, 'Use.cs': 'internal static class Use { public static string M(Helper h) => $"{h.Format()}"; }\n' }, 'Helper.cs');
    const result = cleanup(helper, warning, interpolated);
    expect(result.output).toBe(helper);
    expect(result.issues).toEqual([expect.stringMatching(/^CA1822 line 3: 'Format' .*another file/)]);

    const shape = lines('internal class Shape', '{', '    public string Kind => "square";', '}');
    const pattern = project({ 'Shape.cs': shape, 'Use.cs': 'internal static class Use { public static bool M(object o) => o is Shape { Kind: "square" }; }\n' }, 'Shape.cs');
    const patternResult = cleanup(shape, warning, pattern);
    expect(patternResult.output).toBe(shape);
    expect(patternResult.issues).toEqual([expect.stringMatching(/^CA1822 line 3: 'Kind' .*another file/)]);

    const box = lines('internal class Box', '{', '    public Box Inner => new Box();', '}');
    const extended = project({ 'Box.cs': box, 'Use.cs': 'internal static class Use { public static bool M(object o) => o is Box { Inner.Inner: not null }; }\n' }, 'Box.cs');
    expect(cleanup(box, warning, extended).output).toBe(box);
  });

  it('reports a public member of a derivable type that a derived type may use to implement an interface', () => {
    const source = lines(
      'internal class Base',
      '{',
      '    public string Name() => "x";',
      '}',
      'internal interface INamed { string Name(); }',
      'internal sealed class D : Base, INamed { }',
      'internal class Other',
      '{',
      '    public string Label() => "y";',
      '}',
      'internal sealed class E : Other, IExternal { }'
    );
    const result = cleanup(source, warning, project({ 'Base.cs': source }, 'Base.cs'));

    expect(result.output).toBe(source);
    expect(result.issues).toEqual([
      expect.stringMatching(/^CA1822 line 3: 'Name' .*derived type/),
      expect.stringMatching(/^CA1822 line 9: 'Label' .*IExternal/),
    ]);
  });

  it('reports members the compiler binds to through a pattern (foreach, deconstruction, fixed)', () => {
    const source = lines(
      'using System.Collections.Generic;',
      'public static class Use',
      '{',
      '    private sealed class Bag',
      '    {',
      '        public IEnumerator<int> GetEnumerator() { yield return 1; }',
      '        internal void Deconstruct(out int a, out int b) { a = 1; b = 2; }',
      '    }',
      '    public static int M()',
      '    {',
      '        var s = 0;',
      '        foreach (var x in new Bag()) { s += x; }',
      '        var (a, b) = new Bag();',
      '        return s + a + b;',
      '    }',
      '}'
    );
    const result = cleanup(source, warning);

    expect(result.output).toBe(source);
    expect(result.issues).toEqual([
      expect.stringMatching(/^CA1822 line 6: 'GetEnumerator' .*pattern/),
      expect.stringMatching(/^CA1822 line 7: 'Deconstruct' .*pattern/),
    ]);
  });

  it('reports query pattern members (Select, Where, ...) where a query expression may bind to them, and fixes them elsewhere', () => {
    const query = lines(
      'using System;',
      'class Q',
      '{',
      '    private Q Select(Func<int, int> f) => null;',
      '    public object M() => from x in this select x * 2;',
      '}'
    );
    const result = cleanup(query, warning);

    expect(result.output).toBe(query);
    expect(result.issues).toEqual([expect.stringMatching(/^CA1822 line 4: 'Select' .*pattern/)]);

    const helper = lines('class J', '{', '    private string Join(string a, string b) => a + b;', '    public string M() => Join("a", "b");', '}');
    expect(cleanup(helper, warning).output).toContain('private static string Join(');
  });

  it('reports Length and Count of a type that may inherit an indexer, and fixes them when no indexer can apply', () => {
    const inherited = lines(
      'class B { public int this[int i] => i; }',
      'class D : B',
      '{',
      '    private int Length => 3;',
      '    public int U() => this[^1];',
      '}',
      'class E : Unknown',
      '{',
      '    private int Count => 3;',
      '}'
    );
    const result = cleanup(inherited, warning);

    expect(result.output).toBe(inherited);
    expect(result.issues).toEqual([
      expect.stringMatching(/^CA1822 line 4: 'Length' .*pattern/),
      expect.stringMatching(/^CA1822 line 9: 'Count' .*pattern/),
    ]);

    const plain = lines('class B { }', 'class D : B, System.IDisposable', '{', '    private int Count => 3;', '    public void Dispose() { }', '}');
    expect(cleanup(plain, warning).output).toContain('private static int Count');
  });

  it('applies only while CA1822 is enforced, including through its category', () => {
    const source = lines('class C', '{', '    private int One() => 1;', '}');

    for (const rules of ['', 'dotnet_diagnostic.CA1822.severity = none', 'dotnet_diagnostic.CA1822.severity = silent']) {
      expect(cleanup(source, rules)).toEqual({ output: source, issues: [] });
    }

    expect(cleanup(source, 'dotnet_analyzer_diagnostic.category-Performance.severity = warning').output).toContain('private static int One()');
    expect(
      cleanup(source, 'dotnet_analyzer_diagnostic.category-Performance.severity = warning\ndotnet_diagnostic.CA1822.severity = none').output
    ).toBe(source);
  });

  it('does not touch generated code', () => {
    const source = lines('// <auto-generated/>', 'class C', '{', '    private int One() => 1;', '}');

    expect(cleanup(source, warning)).toEqual({ output: source, issues: [] });
  });
});

describe('CA1852 seal internal types', () => {
  const warning = 'dotnet_diagnostic.CA1852.severity = warning';

  it('seals internal and private types nothing in the project derives from', () => {
    const source = lines(
      'namespace App;',
      '',
      'internal class Leaf',
      '{',
      '    private class Nested { }',
      '    private class Base { }',
      '    private class Derived : Base { }',
      '}',
      '',
      'public class Visible { }',
      'abstract class Abstract { }',
      'static class Helpers { }',
      'record Data(int X);',
      'record struct Value(int X);'
    );
    const options = project({ 'Leaf.cs': source }, 'Leaf.cs');

    expect(cleanup(source, warning, options)).toEqual({
      output: lines(
        'namespace App;',
        '',
        'internal sealed class Leaf',
        '{',
        '    private sealed class Nested { }',
        '    private class Base { }',
        '    private sealed class Derived : Base { }',
        '}',
        '',
        'public class Visible { }',
        'abstract class Abstract { }',
        'static class Helpers { }',
        'sealed record Data(int X);',
        'record struct Value(int X);'
      ),
      issues: [],
    });
  });

  it('keeps types derived from or used as a constraint in another project file', () => {
    const source = lines('class Shape { }', 'class Rule { }');
    const options = project(
      { 'Shape.cs': source, 'Sub/Circle.cs': 'class Circle : Shape { }\nclass Check<T> where T : Rule { }\n' },
      'Shape.cs'
    );

    expect(cleanup(source, warning, options)).toEqual({ output: source, issues: [] });
  });

  it('ignores other projects nested in the folder', () => {
    const source = lines('class Shape { }');
    const options = project({ 'Shape.cs': source, 'Tests/Tests.csproj': '<Project />', 'Tests/Circle.cs': 'class Circle : Shape { }\n' }, 'Shape.cs');

    expect(cleanup(source, warning, options).output).toBe(lines('sealed class Shape { }'));
  });

  it('follows InternalsVisibleTo and ignore_internalsvisibleto', () => {
    const source = lines('class Shape { }');
    const files = { 'Shape.cs': source, 'Properties/AssemblyInfo.cs': '[assembly: System.Runtime.CompilerServices.InternalsVisibleTo("Tests")]\n' };

    expect(cleanup(source, warning, project(files, 'Shape.cs'))).toEqual({ output: source, issues: [] });

    const reported = cleanup(source, `${warning}\ndotnet_code_quality.CA1852.ignore_internalsvisibleto = true`, project(files, 'Shape.cs'));
    expect(reported.output).toBe(source);
    expect(reported.issues).toEqual([expect.stringMatching(/^CA1852 line 1: 'Shape' .*InternalsVisibleTo/)]);
  });

  it('reports types it cannot seal safely', () => {
    const source = lines('class Open', '{', '    public virtual void M() { }', '}', 'partial class Part { }', 'class Guarded', '{', '    protected int Value;', '}');
    const result = cleanup(source, warning, project({ 'Open.cs': source }, 'Open.cs'));

    expect(result.output).toBe(source);
    expect(result.issues).toEqual([
      expect.stringMatching(/^CA1852 line 1: 'Open' .*virtual/),
      expect.stringMatching(/^CA1852 line 5: 'Part' .*partial/),
      expect.stringMatching(/^CA1852 line 6: 'Guarded' .*protected/),
    ]);

    const noProject = cleanup(lines('class Lone { }'), warning);
    expect(noProject.output).toBe(lines('class Lone { }'));
    expect(noProject.issues).toEqual([expect.stringMatching(/^CA1852 line 1: 'Lone' .*project/)]);
  });

  it('never seals a type containing abstract members or nested abstract types, at any depth', () => {
    const source = lines(
      'internal class Host',
      '{',
      '    private abstract class Nested { }',
      '    private class Impl : Nested { }',
      '}',
      'internal class Deep',
      '{',
      '    private class Middle',
      '    {',
      '        private abstract class Leaf { }',
      '    }',
      '}'
    );
    const result = cleanup(source, warning, project({ 'Host.cs': source }, 'Host.cs'));

    expect(result.output).toBe(source.replace('    private class Impl', '    private sealed class Impl'));
    expect(result.issues).toEqual([
      expect.stringMatching(/^CA1852 line 1: 'Host' .*contains abstract members\/types/),
      expect.stringMatching(/^CA1852 line 6: 'Deep' .*contains abstract members\/types/),
      expect.stringMatching(/^CA1852 line 8: 'Middle' .*contains abstract members\/types/),
    ]);
  });

  it('decides alone, instead of the sealing setting, while it is enforced', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-quality-'));
    temporaryFolders.push(folder);
    fs.writeFileSync(path.join(folder, '.editorconfig'), `root = true\n[*.cs]\n${warning}\n`);
    const filePath = path.join(folder, 'Lone.cs');
    const settings = { ...createDefaultSettings(), sealClassesWhenSafe: true };
    const messages: string[] = [];

    const output = runCleanup(lines('internal class Lone { }'), filePath, settings, undefined, (issue) => messages.push(issue.detail));

    expect(output).toBe(lines('internal class Lone { }'));
    expect(messages).toEqual([expect.stringMatching(/CA1852 line 1: 'Lone' .*project/)]);
  });

  it('applies only while CA1852 is enforced', () => {
    const source = lines('class Shape { }');
    const options = project({ 'Shape.cs': source }, 'Shape.cs');

    for (const rules of ['', 'dotnet_diagnostic.CA1852.severity = none', 'dotnet_diagnostic.CA1852.severity = silent']) {
      expect(cleanup(source, rules, options)).toEqual({ output: source, issues: [] });
    }
  });

  it('reports instead of sealing when the project compiles Razor or XAML markup it does not read', () => {
    const source = lines('internal class PageBase { }');

    for (const markup of ['Pages/Index.razor', 'Views/Home.cshtml', 'MainWindow.xaml']) {
      const result = cleanup(source, warning, project({ 'PageBase.cs': source, [markup]: '@inherits PageBase\n' }, 'PageBase.cs'));
      expect(result.output).toBe(source);
      expect(result.issues).toEqual([expect.stringMatching(/^CA1852 line 1: 'PageBase' .*markup/)]);
    }
  });
});

describe('IDE0051 remove unused private members', () => {
  const warning = 'dotnet_diagnostic.IDE0051.severity = warning';

  it('removes private members nothing references, with their doc comments', () => {
    const source = lines(
      'class C',
      '{',
      '    private int _used;',
      '    private int _unused;',
      '',
      '    /// <summary>Unused.</summary>',
      '    private int Helper() => Other();',
      '',
      '    private int Other() => 1;',
      '',
      '    public int Value => _used;',
      '}'
    );

    expect(cleanup(source, warning)).toEqual({
      output: lines('class C', '{', '    private int _used;', '', '    public int Value => _used;', '}'),
      issues: [],
    });
  });

  it('reports unused members it cannot remove safely and keeps used or special ones', () => {
    const source = lines(
      'using System;',
      'class C : IDisposable',
      '{',
      '    [Obsolete] private int _attributed;',
      '    private int _reflected;',
      '    private readonly object _created = Create();',
      '    private int _nameOf;',
      '    void IDisposable.Dispose() { }',
      '    private static void Main() { }',
      '    public string Name() => nameof(_nameOf) + "_reflected";',
      '    private static object Create() => new object();',
      '}',
      'struct S',
      '{',
      '    private int _padding;',
      '}'
    );

    const result = cleanup(source, warning);

    expect(result.output).toBe(source);
    expect(result.issues).toEqual([
      expect.stringMatching(/^IDE0051 line 4: '_attributed' .*attribute/),
      expect.stringMatching(/^IDE0051 line 5: '_reflected' .*string/),
      expect.stringMatching(/^IDE0051 line 6: '_created' .*initializer/),
      expect.stringMatching(/^IDE0051 line 15: '_padding' .*struct/),
    ]);
  });

  it('keeps CRLF line endings and blank lines tidy when removing', () => {
    const source = ['class C', '{', '    private int _used;', '', '    private int _unused;', '', '    public int Value => _used;', '}', ''].join('\r\n');

    expect(cleanup(source, warning).output).toBe(['class C', '{', '    private int _used;', '', '    public int Value => _used;', '}', ''].join('\r\n'));
  });

  it('keeps a private member the compiler binds to through a pattern (deconstruction)', () => {
    const source = lines(
      'class Pair',
      '{',
      '    private void Deconstruct(out int a, out int b) { a = 1; b = 2; }',
      '    public int Sum() { var (a, b) = this; return a + b; }',
      '}'
    );
    const result = cleanup(source, warning);

    expect(result.output).toBe(source);
    expect(result.issues).toEqual([expect.stringMatching(/^IDE0051 line 3: 'Deconstruct' .*pattern/)]);
  });

  it('keeps a private member a query expression binds to (Where), and removes one no query can use', () => {
    const source = lines(
      'using System;',
      'class Q',
      '{',
      '    private Q Where(Func<int, bool> f) => this;',
      '    public object M() => from x in this where x > 0 select x;',
      '}'
    );
    const result = cleanup(source, warning);

    expect(result.output).toBe(source);
    expect(result.issues).toEqual([expect.stringMatching(/^IDE0051 line 4: 'Where' .*pattern/)]);

    expect(cleanup(lines('class P', '{', '    private int Select() => 1;', '}'), warning).output).toBe(lines('class P', '{', '}'));
  });

  it('applies only while IDE0051 is enforced', () => {
    const source = lines('class C', '{', '    private int _unused;', '}');

    for (const rules of ['', 'dotnet_diagnostic.IDE0051.severity = none', 'dotnet_diagnostic.IDE0051.severity = silent']) {
      expect(cleanup(source, rules)).toEqual({ output: source, issues: [] });
    }
  });
});

describe('IDE0052 remove unread private members', () => {
  it('reports private members that are only written', () => {
    const source = lines(
      'class C',
      '{',
      '    private int _written;',
      '    private int _read;',
      '    public C() { _written = 1; this._written = 2; _read = 3; }',
      '    public int Read() => _read;',
      '}'
    );

    expect(cleanup(source, 'dotnet_diagnostic.IDE0052.severity = warning')).toEqual({
      output: source,
      issues: [expect.stringMatching(/^IDE0052 line 3: '_written' .*never read/)],
    });
    expect(cleanup(source, 'dotnet_diagnostic.IDE0052.severity = silent')).toEqual({ output: source, issues: [] });
  });
});
