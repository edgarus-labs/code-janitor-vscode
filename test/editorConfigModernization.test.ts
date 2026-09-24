import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveEditorConfigProperties } from '../src/cleanup/editorconfig';
import { unsupportedEditorConfigSettings } from '../src/cleanup/editorConfigRegistry';
import { findProject } from '../src/cleanup/projectInfo';
import { createEditorConfigCodeStyleConverter, EditorConfigCodeStyleOptions } from '../src/cleanup/transformations/editorConfigCodeStyle';

function lines(...text: string[]): string {
  return `${text.join('\n')}\n`;
}

/** A method body wrapped in a class. */
function method(...body: string[]): string {
  return lines('class Sample', '{', '    void M(string s, object o, int[] items)', '    {', ...body.map((line) => (line ? `        ${line}` : '')), '    }', '}');
}

function codeStyle(source: string, rules: string, options: EditorConfigCodeStyleOptions = {}): { output: string; issues: string[] } {
  const props = resolveEditorConfigProperties([{ directory: '/repo', text: `root = true\n[*.cs]\n${rules}\n` }], '/repo/Sample.cs');
  const issues: string[] = [];
  const output = createEditorConfigCodeStyleConverter(props, (issue) => issues.push(issue), options).apply(source);

  return { output, issues };
}

/** Asserts the option rewrites `before` to `after` while enforced, and leaves `before` alone while silent. */
function expectRewrite(option: string, before: string, after: string): void {
  expect(codeStyle(before, `${option} = true:warning`).output).toBe(after);
  expect(codeStyle(before, `${option} = true:silent`).output).toBe(before);
  expect(codeStyle(before, `${option} = true:warning\ndotnet_diagnostic.${idOf(option)}.severity = none`).output).toBe(before);
}

const IDS: Record<string, string> = {
  csharp_style_implicit_object_creation_when_type_is_apparent: 'IDE0090',
  csharp_prefer_simple_default_expression: 'IDE0034',
  csharp_style_prefer_index_operator: 'IDE0056',
  csharp_style_prefer_range_operator: 'IDE0057',
  csharp_style_throw_expression: 'IDE0016',
  csharp_style_prefer_null_check_over_type_check: 'IDE0150',
  csharp_style_prefer_tuple_swap: 'IDE0180',
  csharp_style_prefer_local_over_anonymous_function: 'IDE0039',
  csharp_style_deconstructed_variable_declaration: 'IDE0042',
  csharp_style_prefer_utf8_string_literals: 'IDE0230',
  csharp_style_prefer_implicitly_typed_lambda_expression: 'IDE0350',
  csharp_style_prefer_unbound_generic_type_in_nameof: 'IDE0340',
};

function idOf(option: string): string {
  return IDS[option];
}

describe('IDE0090 csharp_style_implicit_object_creation_when_type_is_apparent', () => {
  it('uses new() where the declared type is the created type', () => {
    expectRewrite(
      'csharp_style_implicit_object_creation_when_type_is_apparent',
      method('List<int> a = new List<int>();', 'Foo f = new Foo { X = 1 };', 'IFoo g = new Foo();', 'var h = new Foo();'),
      method('List<int> a = new();', 'Foo f = new() { X = 1 };', 'IFoo g = new Foo();', 'var h = new Foo();')
    );
  });
});

describe('IDE0034 csharp_prefer_simple_default_expression', () => {
  it('uses default where the target type is written', () => {
    const before = lines('class Sample', '{', '    int M(int x = default(int))', '    {', '        int a = default(int);', '        var b = default(int);', '        return default(int);', '    }', '}');

    expectRewrite(
      'csharp_prefer_simple_default_expression',
      before,
      lines('class Sample', '{', '    int M(int x = default)', '    {', '        int a = default;', '        var b = default(int);', '        return default;', '    }', '}')
    );
  });
});

describe('IDE0056 csharp_style_prefer_index_operator', () => {
  it('uses ^ for Length and Count from the end of the same receiver', () => {
    expectRewrite(
      'csharp_style_prefer_index_operator',
      method('List<int> list = Load();', 'var a = items[items.Length - 1];', 'var b = list[list.Count - (n + 1)];', 'var c = items[other.Length - 1];', 'Expression<Func<int>> e = () => items[items.Length - 1];'),
      method('List<int> list = Load();', 'var a = items[^1];', 'var b = list[^(n + 1)];', 'var c = items[other.Length - 1];', 'Expression<Func<int>> e = () => items[items.Length - 1];')
    );
  });
});

describe('IDE0057 csharp_style_prefer_range_operator', () => {
  it('uses ranges for Substring on provable strings and reports other receivers', () => {
    const before = method('var a = s.Substring(1);', 'var b = s.Substring(0, 3);', 'var c = s.Substring(1, s.Length - 2);', 'var d = s.Substring(i, j - i);', 'var e = o.Substring(1);');
    const { output, issues } = codeStyle(before, 'csharp_style_prefer_range_operator = true:warning');

    expect(output).toBe(method('var a = s[1..];', 'var b = s[..3];', 'var c = s[1..^1];', 'var d = s[i..j];', 'var e = o.Substring(1);'));
    expect(issues).toEqual([expect.stringMatching(/^IDE0057 .* 'o.Substring\(1\)' was not changed to a range/)]);
    expect(codeStyle(before, 'csharp_style_prefer_range_operator = true:silent')).toEqual({ output: before, issues: [] });
  });
});

describe('IDE0016 csharp_style_throw_expression', () => {
  it('folds a null check that throws into the following assignment', () => {
    const before = lines(
      'class Sample',
      '{',
      '    private string _name;',
      '    private string _other;',
      '',
      '    public Sample(string name, string other)',
      '    {',
      '        if (name == null) throw new ArgumentNullException(nameof(name));',
      '        _name = name;',
      '        if (other is null)',
      '        {',
      '            throw new ArgumentNullException(nameof(other));',
      '        }',
      '        _other = other;',
      '    }',
      '}'
    );

    expectRewrite(
      'csharp_style_throw_expression',
      before,
      lines(
        'class Sample',
        '{',
        '    private string _name;',
        '    private string _other;',
        '',
        '    public Sample(string name, string other)',
        '    {',
        '        _name = name ?? throw new ArgumentNullException(nameof(name));',
        '        _other = other ?? throw new ArgumentNullException(nameof(other));',
        '    }',
        '}'
      )
    );
  });

  it('keeps checks that are not followed by an assignment of the checked value', () => {
    const source = method('if (s == null) throw new ArgumentNullException(nameof(s));', 'Use(s);');

    expect(codeStyle(source, 'csharp_style_throw_expression = true:warning').output).toBe(source);
  });
});

describe('IDE0150 csharp_style_prefer_null_check_over_type_check', () => {
  it('replaces object type checks with null checks', () => {
    expectRewrite(
      'csharp_style_prefer_null_check_over_type_check',
      method('if (o is object) { }', 'if (o is not object) { }', 'if (o is string) { }'),
      method('if (o is not null) { }', 'if (o is null) { }', 'if (o is string) { }')
    );
  });
});

describe('IDE0180 csharp_style_prefer_tuple_swap', () => {
  it('swaps with a tuple when the temporary is used for nothing else', () => {
    expectRewrite(
      'csharp_style_prefer_tuple_swap',
      method('var temp = a;', 'a = b;', 'b = temp;', 'Use(a, b);'),
      method('(a, b) = (b, a);', 'Use(a, b);')
    );
  });

  it('keeps the temporary when it is used again', () => {
    const source = method('var temp = a;', 'a = b;', 'b = temp;', 'Use(temp);');

    expect(codeStyle(source, 'csharp_style_prefer_tuple_swap = true:warning').output).toBe(source);
  });
});

describe('IDE0039 csharp_style_prefer_local_over_anonymous_function', () => {
  it('turns a delegate variable that is only called into a local function', () => {
    expectRewrite(
      'csharp_style_prefer_local_over_anonymous_function',
      method('Func<int, string> format = x => x.ToString();', 'Action log = () => { Write(); };', 'Use(format(1));', 'log();'),
      method('string format(int x) => x.ToString();', 'void log() { Write(); }', 'Use(format(1));', 'log();')
    );
  });

  it('keeps delegate variables used as values', () => {
    const source = method('Func<int, int> twice = x => x * 2;', 'Apply(twice);');

    expect(codeStyle(source, 'csharp_style_prefer_local_over_anonymous_function = true:warning').output).toBe(source);
  });
});

describe('IDE0042 csharp_style_deconstructed_variable_declaration', () => {
  it('deconstructs named tuples used only through their element names', () => {
    expectRewrite(
      'csharp_style_deconstructed_variable_declaration',
      method('var point = (x: 1, y: 2);', 'Use(point.x, point.y);', '(int width, int height) size = GetSize();', 'Use(size.width);'),
      method('var (x, y) = (1, 2);', 'Use(x, y);', '(int width, int height) = GetSize();', 'Use(width);')
    );
  });

  it('keeps tuples used as a whole or whose element names are taken', () => {
    const source = method('var point = (x: 1, y: 2);', 'Use(point);', 'var pair = (a: 1, b: 2);', 'Use(pair.a, b);');

    expect(codeStyle(source, 'csharp_style_deconstructed_variable_declaration = true:warning').output).toBe(source);
  });
});

describe('IDE0230 csharp_style_prefer_utf8_string_literals', () => {
  it('turns ASCII byte arrays into UTF-8 string literals', () => {
    expectRewrite(
      'csharp_style_prefer_utf8_string_literals',
      method('byte[] a = new byte[] { 0x48, 0x69 };', 'ReadOnlySpan<byte> b = new byte[] { 72, 105, 10 };', 'byte[] c = new byte[] { 0, 1 };'),
      method('byte[] a = "Hi"u8.ToArray();', 'ReadOnlySpan<byte> b = "Hi\\n"u8;', 'byte[] c = new byte[] { 0, 1 };')
    );
  });
});

describe('IDE0350 csharp_style_prefer_implicitly_typed_lambda_expression', () => {
  it('removes parameter types that the declared delegate type gives, reporting other lambdas', () => {
    const before = method('Func<int, int> f = (int x) => x + 1;', 'Run((int y) => y);');
    const { output, issues } = codeStyle(before, 'csharp_style_prefer_implicitly_typed_lambda_expression = true:warning');

    expect(output).toBe(method('Func<int, int> f = x => x + 1;', 'Run((int y) => y);'));
    expect(issues).toEqual([expect.stringMatching(/^IDE0350 .* line 6: lambda parameter types were not removed/)]);
  });
});

describe('IDE0340 csharp_style_prefer_unbound_generic_type_in_nameof', () => {
  it('drops type arguments inside nameof', () => {
    expectRewrite(
      'csharp_style_prefer_unbound_generic_type_in_nameof',
      method('var a = nameof(List<int>);', 'var b = nameof(Dictionary<int, List<string>>.KeyCollection);', 'var c = nameof(s);'),
      method('var a = nameof(List<>);', 'var b = nameof(Dictionary<,>.KeyCollection);', 'var c = nameof(s);')
    );
  });
});

describe('IDE0330 csharp_prefer_system_threading_lock', () => {
  const source = lines(
    'class Sample',
    '{',
    '    private readonly object _gate = new object();',
    '    private readonly object _shared = new();',
    '',
    '    void M()',
    '    {',
    '        lock (_gate) { }',
    '        lock (this._shared) { }',
    '        Monitor.Enter(_shared);',
    '    }',
    '}'
  );
  const rules = 'csharp_prefer_system_threading_lock = true:warning';

  it('uses System.Threading.Lock for fields only locked on, on .NET 9 and later', () => {
    const { output, issues } = codeStyle(source, rules, { project: { directory: '/repo', targetFrameworks: ['net9.0'] } });

    expect(output).toBe(source.replace('private readonly object _gate = new object();', 'private readonly System.Threading.Lock _gate = new();'));
    expect(issues).toEqual([expect.stringMatching(/^IDE0330 .* '_shared' was not changed .*more than lock statements/)]);
  });

  it('reports instead of converting when the project does not target .NET 9', () => {
    const { output, issues } = codeStyle(source, rules, { project: { directory: '/repo', targetFrameworks: ['net8.0', 'net9.0'] } });

    expect(output).toBe(source);
    expect(issues).toHaveLength(2);
  });

  it('reads the target frameworks of the nearest project file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-project-'));
    try {
      fs.mkdirSync(path.join(root, 'src'));
      fs.writeFileSync(path.join(root, 'App.csproj'), '<Project><PropertyGroup><TargetFrameworks>net9.0;net10.0</TargetFrameworks></PropertyGroup></Project>');

      expect(findProject(path.join(root, 'src', 'A.cs'))).toEqual({
        directory: root,
        rootNamespace: 'App',
        targetFrameworks: ['net9.0', 'net10.0'],
        languageVersion: 13,
        modernRuntime: true,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads the C# language version from LangVersion, Directory.Build.props or the framework default', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-project-'));
    const project = (name: string, content: string): string => {
      fs.mkdirSync(path.join(root, name));
      fs.writeFileSync(path.join(root, name, `${name}.csproj`), `<Project><PropertyGroup>${content}</PropertyGroup></Project>`);

      return path.join(root, name, 'A.cs');
    };
    try {
      expect(findProject(project('Framework', '<TargetFrameworkVersion>v4.7.2</TargetFrameworkVersion>'))).toMatchObject({ languageVersion: 7.3, modernRuntime: false });
      expect(findProject(project('Latest', '<TargetFramework>net472</TargetFramework><LangVersion>latest</LangVersion>'))).toMatchObject({ languageVersion: 99, modernRuntime: false });
      expect(findProject(project('Pinned', '<TargetFramework>net8.0</TargetFramework><LangVersion>9.0</LangVersion>'))).toMatchObject({ languageVersion: 9, modernRuntime: true });
      fs.writeFileSync(path.join(root, 'Directory.Build.props'), '<Project><PropertyGroup><LangVersion>10</LangVersion></PropertyGroup></Project>');
      expect(findProject(project('Props', '<TargetFramework>netstandard2.0</TargetFramework>'))).toMatchObject({ languageVersion: 10, modernRuntime: false });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('IDE0290 csharp_style_prefer_primary_constructors', () => {
  it('reports the types that do not follow the preference without changing them', () => {
    const withPrimary = lines('class Point(int x)', '{', '    public int X => x;', '}');
    const candidate = lines('class Point', '{', '    private readonly int _x;', '', '    public Point(int x)', '    {', '        _x = x;', '    }', '}');

    expect(codeStyle(withPrimary, 'csharp_style_prefer_primary_constructors = false:suggestion')).toEqual({
      output: withPrimary,
      issues: [expect.stringMatching(/^IDE0290 .* 'Point' keeps its primary constructor/)],
    });
    expect(codeStyle(candidate, 'csharp_style_prefer_primary_constructors = true:suggestion')).toEqual({
      output: candidate,
      issues: [expect.stringMatching(/^IDE0290 .* 'Point' could use a primary constructor/)],
    });
    expect(codeStyle(candidate, 'csharp_style_prefer_primary_constructors = true:silent').issues).toEqual([]);
  });
});

describe('unsupported settings and rule severities', () => {
  it('lets dotnet_diagnostic silence an unsupported option', () => {
    const props = resolveEditorConfigProperties(
      [
        {
          directory: '/repo',
          text: 'root = true\n[*.cs]\ncsharp_style_unused_value_assignment_preference = discard_variable:suggestion\ndotnet_diagnostic.IDE0059.severity = none\ncsharp_prefer_static_anonymous_function = true\ndotnet_diagnostic.IDE0320.severity = warning\n',
        },
      ],
      '/repo/A.cs'
    );

    expect(unsupportedEditorConfigSettings(props)).toEqual([
      '"csharp_prefer_static_anonymous_function = true" is not supported and was not applied.',
      '"dotnet_diagnostic.ide0320.severity = warning" is not supported and was not applied.',
    ]);
  });
});
