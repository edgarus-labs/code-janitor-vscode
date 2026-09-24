import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveEditorConfigProperties } from '../src/cleanup/editorconfig';
import { ProjectInfo, findProject } from '../src/cleanup/projectInfo';
import { createEditorConfigCodeStyleConverter } from '../src/cleanup/transformations/editorConfigCodeStyle';

const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

/** A folder with the given files; returns the path of `App/A.cs` in it. */
function sourceIn(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-project-info-'));
  folders.push(root);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }

  return path.join(root, 'App', 'A.cs');
}

const project = (body: string): string => `<Project Sdk="Microsoft.NET.Sdk">\n${body}\n</Project>\n`;

describe('findProject reads MSBuild properties as MSBuild evaluates them', () => {
  it('ignores properties in XML comments and lets Directory.Build.targets override the project', () => {
    const commented = sourceIn({ 'App/App.csproj': project('<!-- <PropertyGroup><Nullable>enable</Nullable></PropertyGroup> -->\n<PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>') });
    expect(findProject(commented)).toMatchObject({ nullable: 'disable', targetFrameworks: ['net8.0'] });

    const targets = sourceIn({
      'App/App.csproj': project('<PropertyGroup><TargetFramework>net8.0</TargetFramework><Nullable>disable</Nullable></PropertyGroup>'),
      'Directory.Build.targets': '<Project><PropertyGroup><Nullable>enable</Nullable></PropertyGroup></Project>',
    });
    expect(findProject(targets)).toMatchObject({ nullable: 'enable' });
  });

  it('leaves a property unknown when a Condition, a Choose or an unknown property decides it', () => {
    const conditional = sourceIn({
      'App/App.csproj': project(
        '<PropertyGroup><TargetFramework>net8.0</TargetFramework><Nullable>disable</Nullable></PropertyGroup>\n<PropertyGroup Condition="\'$(Configuration)\' == \'Release\'"><Nullable>enable</Nullable><LangVersion>9</LangVersion></PropertyGroup>'
      ),
    });
    const info = findProject(conditional) as ProjectInfo;
    expect(info.nullable).toBeUndefined();
    expect(info.languageVersion).toBeUndefined();
    expect(info.targetFrameworks).toEqual(['net8.0']);

    const choose = sourceIn({
      'App/App.csproj': project('<PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>\n<Choose><When Condition="true"><PropertyGroup><Nullable>enable</Nullable></PropertyGroup></When></Choose>'),
    });
    expect(findProject(choose)?.nullable).toBeUndefined();

    const unknown = sourceIn({ 'App/App.csproj': project('<PropertyGroup><TargetFrameworks>$(Frameworks)</TargetFrameworks><Nullable>$(NullableSetting)</Nullable><RootNamespace>$(Company).App</RootNamespace></PropertyGroup>') });
    const unknownInfo = findProject(unknown) as ProjectInfo;
    expect([unknownInfo.targetFrameworks, unknownInfo.nullable, unknownInfo.rootNamespace]).toEqual([undefined, undefined, undefined]);
  });

  it('follows imports it can resolve and treats the others as setting anything', () => {
    const imported = sourceIn({
      'App/App.csproj': project('<Import Project="..\\common.props" />\n<PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>'),
      'common.props': '<Project><PropertyGroup><Nullable>enable</Nullable><RootNamespace>Company.App</RootNamespace></PropertyGroup></Project>',
    });
    expect(findProject(imported)).toMatchObject({ nullable: 'enable', rootNamespace: 'Company.App' });

    const chained = sourceIn({
      'App/App.csproj': project('<PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>'),
      'App/Directory.Build.props': '<Project><Import Project="$([MSBuild]::GetPathOfFileAbove(\'Directory.Build.props\', \'$(MSBuildThisFileDirectory)../\'))" /></Project>',
      'Directory.Build.props': '<Project><PropertyGroup><Nullable>enable</Nullable></PropertyGroup></Project>',
    });
    expect(findProject(chained)?.nullable).toBe('enable');

    // What an unknown import may set is unknown; what is set after it is not.
    const opaque = sourceIn({ 'App/App.csproj': project('<Import Project="$(SolutionDir)build.props" />\n<PropertyGroup><TargetFramework>net8.0</TargetFramework><LangVersion>11</LangVersion></PropertyGroup>') });
    const opaqueInfo = findProject(opaque) as ProjectInfo;
    expect([opaqueInfo.nullable, opaqueInfo.targetFrameworks, opaqueInfo.languageVersion]).toEqual([undefined, undefined, 11]);
  });
});

describe('IDE0240 with an unknown nullable context', () => {
  function cleanup(source: string, info: ProjectInfo): { output: string; issues: string[] } {
    const props = resolveEditorConfigProperties([{ directory: '/repo', text: 'root = true\n[*.cs]\ndotnet_diagnostic.IDE0240.severity = warning\n' }], '/repo/A.cs');
    const issues: string[] = [];
    const output = createEditorConfigCodeStyleConverter(props, (issue) => issues.push(issue), { project: info }).apply(source);

    return { output, issues };
  }

  const info: ProjectInfo = { directory: '/repo', targetFrameworks: ['net8.0'], languageVersion: 12, modernRuntime: true };

  it('keeps and reports a directive that may repeat the project context', () => {
    const source = '#nullable enable\nclass C\n{\n}\n';

    expect(cleanup(source, info)).toEqual({ output: source, issues: [expect.stringMatching(/^IDE0240 line 1: .*unknown/)] });
    expect(cleanup(source, { ...info, nullable: 'enable' }).output).toBe('class C\n{\n}\n');
  });

  it('still removes directives that repeat the file\'s own context', () => {
    const source = '#nullable enable\nclass C\n{\n}\n#nullable enable\nclass D\n{\n}\n#nullable restore\n';

    expect(cleanup(source, info).output).toBe('#nullable enable\nclass C\n{\n}\nclass D\n{\n}\n#nullable restore\n');
  });
});
