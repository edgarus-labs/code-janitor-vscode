import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveEditorConfigProperties } from '../src/cleanup/editorconfig';
import { unsupportedEditorConfigSettings } from '../src/cleanup/editorConfigRegistry';
import { ProjectInfo, findProject } from '../src/cleanup/projectInfo';
import { createEditorConfigCodeStyleConverter } from '../src/cleanup/transformations/editorConfigCodeStyle';

function lines(...text: string[]): string {
  return `${text.join('\n')}\n`;
}

function method(...body: string[]): string {
  return lines('using System;', '', 'class C', '{', '    void M(bool b, object o, int i)', '    {', ...body.map((line) => `        ${line}`), '    }', '}');
}

function codeStyle(source: string, rules: string, project?: ProjectInfo): { output: string; issues: string[] } {
  const props = resolveEditorConfigProperties([{ directory: '/repo', text: `root = true\n[*.cs]\n${rules}\n` }], '/repo/Sample.cs');
  const issues: string[] = [];
  const output = createEditorConfigCodeStyleConverter(props, (issue) => issues.push(issue), { project }).apply(source);

  return { output, issues };
}

/** Asserts `id` rewrites `before` to `after` while enforced, and leaves it alone otherwise. */
function expectRewrite(id: string, before: string, after: string): void {
  expect(codeStyle(before, `dotnet_diagnostic.${id}.severity = warning`).output).toBe(after);
  expect(codeStyle(before, `dotnet_diagnostic.${id}.severity = silent`).output).toBe(before);
}

describe('rules without options', () => {
  it('are supported, so they are not listed as unsupported', () => {
    const ids = ['IDE0100', 'IDE0110', 'IDE0082', 'IDE0035', 'IDE0080', 'IDE0050', 'IDE0072', 'IDE0076', 'IDE0077'];
    const props = resolveEditorConfigProperties(
      [{ directory: '/repo', text: `root = true\n[*.cs]\n${ids.map((id) => `dotnet_diagnostic.${id}.severity = warning`).join('\n')}\ndotnet_prefer_system_hash_code = true:warning\n` }],
      '/repo/Sample.cs'
    );

    expect(unsupportedEditorConfigSettings(props)).toEqual([]);
  });

  it('IDE0100 removes comparisons of a bool with true or false, and leaves bool? and unknown types', () => {
    expectRewrite(
      'IDE0100',
      method('if (b == true) { }', 'if (b != false) { }', 'if (b == false) { }', 'if (i > 0 == true) { }', 'bool? n = null;', 'if (n == true) { }', 'if (Other() == true) { }'),
      method('if (b) { }', 'if (b) { }', 'if (!b) { }', 'if (i > 0) { }', 'bool? n = null;', 'if (n == true) { }', 'if (Other() == true) { }')
    );
  });

  it('IDE0110 removes discards of type patterns, but not of var or names that may be constants', () => {
    expectRewrite(
      'IDE0110',
      method('switch (o) { case int _: break; case var _: break; }', 'var s = o is string _;', 'var r = o switch { long _ => 1, _ => 2 };'),
      method('switch (o) { case int: break; case var _: break; }', 'var s = o is string;', 'var r = o switch { long => 1, _ => 2 };')
    );
    const withConstant = lines('class C', '{', '    const int Foo = 1;', '    bool M(object o) => o is Foo _;', '}');
    expect(codeStyle(withConstant, 'dotnet_diagnostic.IDE0110.severity = warning').output).toBe(withConstant);
  });

  it('IDE0110 needs C# 9', () => {
    const source = method('var s = o is string _;');
    const { output, issues } = codeStyle(source, 'dotnet_diagnostic.IDE0110.severity = warning', { directory: '/repo', languageVersion: 8 });

    expect(output).toBe(source);
    expect(issues).toEqual([expect.stringMatching(/IDE0110: not applied, the project uses C# 8/)]);
  });

  it('IDE0082 uses nameof for typeof(T).Name when the name is the same, keeping single names that may be aliases of other files', () => {
    expectRewrite(
      'IDE0082',
      lines(
        'using System;',
        'using Alias = System.Collections.Generic.List<int>;',
        '',
        'class C<T>',
        '{',
        '    string[] Names() => new[] { typeof(C<T>).Name, typeof(Uri).Name, typeof(int).Name, typeof(T).Name, typeof(Alias).Name, typeof(System.IO.File).Name };',
        '}'
      ),
      lines(
        'using System;',
        'using Alias = System.Collections.Generic.List<int>;',
        '',
        'class C<T>',
        '{',
        '    string[] Names() => new[] { typeof(C<T>).Name, typeof(Uri).Name, nameof(Int32), typeof(T).Name, typeof(Alias).Name, nameof(System.IO.File) };',
        '}'
      )
    );
  });

  it('IDE0082 keeps global using and project aliases of other files', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-nameof-'));
    try {
      fs.writeFileSync(
        path.join(folder, 'App.csproj'),
        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup><ItemGroup><Using Include="System.Text.StringBuilder" Alias="Sb" /></ItemGroup></Project>'
      );
      fs.writeFileSync(path.join(folder, 'GlobalUsings.cs'), 'global using Json = System.Text.Json.JsonSerializer;\n');
      const source = lines('using System;', '', 'class C', '{', '    string[] Names() => new[] { typeof(Json).Name, typeof(Sb).Name, typeof(Uri).Name, typeof(C).Name };', '}');
      const filePath = path.join(folder, 'C.cs');
      fs.writeFileSync(filePath, source);
      const props = resolveEditorConfigProperties([{ directory: folder, text: 'root = true\n[*.cs]\ndotnet_diagnostic.IDE0082.severity = warning\n' }], filePath);
      const clean = createEditorConfigCodeStyleConverter(props, () => undefined, { filePath, fileName: 'C.cs', project: findProject(filePath) }).apply(source);

      expect(clean).toBe(source.replace('typeof(Uri).Name, typeof(C).Name', 'nameof(Uri), nameof(C)'));
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it('IDE0035 removes statements after return, throw, break or continue in the same block', () => {
    expectRewrite(
      'IDE0035',
      method('if (b)', '{', '    return;', '    M(b, o, i);', '}', 'throw new Exception();', 'int v = 0;'),
      method('if (b)', '{', '    return;', '}', 'throw new Exception();')
    );
  });

  it('IDE0035 keeps unreachable code that holds a label, a local function or a comment', () => {
    const source = method('return;', 'int Local() => 1;', 'label:', 'M(b, o, i);');
    expect(codeStyle(source, 'dotnet_diagnostic.IDE0035.severity = warning').output).toBe(source);
    const commented = method('return;', '// kept for later', 'M(b, o, i);');
    expect(codeStyle(commented, 'dotnet_diagnostic.IDE0035.severity = warning').output).toBe(commented);
  });

  it('IDE0080 removes suppression operators that have no effect', () => {
    expectRewrite(
      'IDE0080',
      method('var s = "a"!;', 'var c = new object()!;', 'var n = (string)null!;', 'if (o !is string) { }', 'string d = default!;'),
      method('var s = "a";', 'var c = new object();', 'var n = (string)null!;', 'if (o is string) { }', 'string d = default!;')
    );
  });

  it('reports what cannot be fixed safely: IDE0050, IDE0072, IDE0070, IDE0076, IDE0077', () => {
    const source = lines(
      '[assembly: System.Diagnostics.CodeAnalysis.SuppressMessage("Style", "IDE0001", Scope = "everywhere", Target = "~T:C")]',
      '[assembly: System.Diagnostics.CodeAnalysis.SuppressMessage("Style", "IDE0002", Scope = "member", Target = "C.#M()")]',
      '',
      'enum Color { Red, Green, Blue }',
      '',
      'class C',
      '{',
      '    int _a;',
      '    object Pair() => new { A = 1, B = 2 };',
      '    string Name(Color c) => c switch { Color.Red => "r", Color.Green => "g" };',
      '    public override int GetHashCode() => _a * 31 ^ 17;',
      '}'
    );
    const { output, issues } = codeStyle(
      source,
      [
        'dotnet_diagnostic.IDE0050.severity = warning',
        'dotnet_diagnostic.IDE0072.severity = warning',
        'dotnet_prefer_system_hash_code = true:warning',
        'dotnet_diagnostic.IDE0076.severity = warning',
        'dotnet_diagnostic.IDE0077.severity = warning',
      ].join('\n')
    );

    expect(output).toBe(source);
    expect(issues).toEqual([
      expect.stringMatching(/^IDE0076 line 1: .*scope 'everywhere'/),
      expect.stringMatching(/^IDE0077 line 2: .*'C\.#M\(\)'/),
      expect.stringMatching(/^IDE0050 line 9: /),
      expect.stringMatching(/^IDE0072 line 10: .*Blue/),
      expect.stringMatching(/^IDE0070 \(dotnet_prefer_system_hash_code\) line 11: /),
    ]);
  });

  it('IDE0100 follows a module-level SuppressMessage in another file of the project', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-simplify-'));
    try {
      fs.writeFileSync(path.join(folder, 'App.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>');
      const source = method('if (b == true) { }');
      const filePath = path.join(folder, 'C.cs');
      fs.writeFileSync(filePath, source);
      const clean = (): string => {
        const props = resolveEditorConfigProperties([{ directory: folder, text: 'root = true\n[*.cs]\ndotnet_diagnostic.IDE0100.severity = warning\n' }], filePath);
        return createEditorConfigCodeStyleConverter(props, () => undefined, { filePath, fileName: 'C.cs', project: findProject(filePath) }).apply(source);
      };

      expect(clean()).toBe(method('if (b) { }'));

      fs.writeFileSync(path.join(folder, 'GlobalSuppressions.cs'), '[module: System.Diagnostics.CodeAnalysis.SuppressMessage("Style", "IDE0100:Remove redundant equality")]\n');
      expect(clean()).toBe(source);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});
