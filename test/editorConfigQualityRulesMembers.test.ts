import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveEditorConfigProperties } from '../src/cleanup/editorconfig';
import { findProject } from '../src/cleanup/projectInfo';
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
      '    private readonly List<(string Id, int Count)> _applied = new List<(string Id, int Count)>();',
      '    private void Record(string id) => _applied.Add((id, 1));',
      '}'
    );

    const result = cleanup(source, warning);

    expect(result.output).toBe(source);
    expect(result.issues).toEqual([expect.stringMatching(/^CA1822 line 4: 'Record' .*could not read every member declaration of Run/)]);
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

  it('applies only while CA1852 is enforced', () => {
    const source = lines('class Shape { }');
    const options = project({ 'Shape.cs': source }, 'Shape.cs');

    for (const rules of ['', 'dotnet_diagnostic.CA1852.severity = none', 'dotnet_diagnostic.CA1852.severity = silent']) {
      expect(cleanup(source, rules, options)).toEqual({ output: source, issues: [] });
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
