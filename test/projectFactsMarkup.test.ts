import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveEditorConfigProperties } from '../src/cleanup/editorconfig';
import { ProjectInfo } from '../src/cleanup/projectInfo';
import { createEditorConfigCodeStyleConverter } from '../src/cleanup/transformations/editorConfigCodeStyle';

function lines(...text: string[]): string {
  return `${text.join('\n')}\n`;
}

const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

/** An SDK project holding `files`; returns its project info. */
function project(files: Record<string, string>, csproj = '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>'): ProjectInfo {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-markup-'));
  folders.push(directory);
  fs.writeFileSync(path.join(directory, 'App.csproj'), csproj);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    fs.writeFileSync(path.join(directory, name), text);
  }

  return { directory, targetFrameworks: ['net8.0'], languageVersion: 12, modernRuntime: true, nullable: 'enable' };
}

function cleanup(source: string, rule: string, info: ProjectInfo): { output: string; issues: string[] } {
  const props = resolveEditorConfigProperties([{ directory: '/repo', text: `root = true\n[*.cs]\ndotnet_diagnostic.${rule}.severity = warning\n` }], '/repo/Sample.cs');
  const issues: string[] = [];
  const filePath = path.join(info.directory, 'Sample.cs');
  const output = createEditorConfigCodeStyleConverter(props, (issue) => issues.push(issue), { project: info, filePath, fileName: 'Sample.cs' }).apply(source);

  return { output, issues };
}

describe('markup compiled into the project', () => {
  const qualified = lines('using System.IO;', '', 'class C', '{', '    void M()', '    {', '        System.IO.FileInfo file = null;', '    }', '}');

  it('lets IDE0001 simplify names in a project with MVC views or Razor components', () => {
    const info = project({ 'Other.cs': 'class Other { }\n', 'Views/Home/Index.cshtml': '<p>Hi</p>\n', 'Pages/Counter.razor': '<p>0</p>\n' });

    expect(cleanup(qualified, 'IDE0001', info).output).toBe(qualified.replace('System.IO.FileInfo file', 'FileInfo file'));
  });

  it('keeps IDE0001 from binding a name to a Razor component of the project', () => {
    const info = project({ 'Other.cs': 'class Other { }\n', 'Pages/FileInfo.razor': '<p>0</p>\n' });

    expect(cleanup(qualified, 'IDE0001', info).output).toBe(qualified);
  });

  it('reports instead of making static an internal member markup may call', () => {
    const source = lines('internal class Formatter', '{', '    internal string Title() => "x";', '}');
    const info = project({ 'Views/Home/Index.cshtml': '@(new Formatter().Title())\n' });
    const result = cleanup(source, 'CA1822', info);

    expect(result.output).toBe(source);
    expect(result.issues).toEqual([expect.stringMatching(/^CA1822 line 3: 'Title' .*markup/)]);
  });

  it('reports instead of making static an internal property Avalonia markup may bind to', () => {
    const source = lines('internal class MainViewModel', '{', '    internal string Title => "x";', '}');
    const info = project({ 'Views/MainWindow.axaml': '<Window x:DataType="vm:MainViewModel"><TextBlock Text="{Binding Title}" /></Window>\n' });
    const result = cleanup(source, 'CA1822', info);

    expect(result.output).toBe(source);
    expect(result.issues).toEqual([expect.stringMatching(/^CA1822 line 3: 'Title' .*markup/)]);
  });

  describe('in a project that lists its C# files but keeps the default markup items', () => {
    const csproj = [
      '<Project Sdk="Microsoft.NET.Sdk.Web">',
      '  <PropertyGroup><TargetFramework>net8.0</TargetFramework><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup>',
      '  <ItemGroup><Compile Include="Sample.cs" /></ItemGroup>',
      '</Project>',
    ].join('\n');

    it('reports instead of sealing a base class a Razor component may inherit', () => {
      const source = lines('internal class CounterBase', '{', '}');
      const info = project({ 'Sample.cs': source, 'Pages/Counter.razor': '@inherits CounterBase\n' }, csproj);
      const result = cleanup(source, 'CA1852', info);

      expect(result.output).toBe(source);
      expect(result.issues).toEqual([expect.stringMatching(/^CA1852 line 1: 'CounterBase' .*markup/)]);
    });

    it('reports instead of making static an internal member markup may call', () => {
      const source = lines('internal class Formatter', '{', '    internal string Title() => "x";', '}');
      const info = project({ 'Sample.cs': source, 'Views/Home/Index.cshtml': '@(new Formatter().Title())\n' }, csproj);
      const result = cleanup(source, 'CA1822', info);

      expect(result.output).toBe(source);
      expect(result.issues).toEqual([expect.stringMatching(/^CA1822 line 3: 'Title' .*markup/)]);
    });

    it('keeps IDE0001 from binding a name to a Razor component', () => {
      const files = { 'Sample.cs': 'class Other { }\n', 'Pages/FileInfo.razor': '<p>0</p>\n' };

      expect(cleanup(qualified, 'IDE0001', project(files, csproj)).output).toBe(qualified);
    });
  });
});
