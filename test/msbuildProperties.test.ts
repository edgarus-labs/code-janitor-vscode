import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MSBuildProject, readMSBuildProject } from '../src/cleanup/msbuildProperties';

const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

/** Reads `App.csproj` with the given body, next to the other given files. */
function read(body: string, files: Record<string, string> = {}): MSBuildProject {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-msbuild-'));
  folders.push(root);
  for (const [name, text] of Object.entries({ ...files, 'App.csproj': `<Project Sdk="Microsoft.NET.Sdk">\n${body}\n</Project>\n` })) {
    fs.writeFileSync(path.join(root, name), text);
  }

  return readMSBuildProject(path.join(root, 'App.csproj')) as MSBuildProject;
}

const RELEASE = `Condition="'$(Configuration)' == 'Release'"`;

describe('self-closing elements', () => {
  it.each(['<PropertyGroup />', '<PropertyGroup Label="Empty" />', '<ItemGroup />', '<ImportGroup Label="Empty" />', '<Target Name="Empty" />'])(
    '%s does not swallow the following conditional groups',
    (empty) => {
      const project = read(
        `${empty}\n<PropertyGroup ${RELEASE}><Nullable>enable</Nullable></PropertyGroup>\n<ItemGroup ${RELEASE}><GlobalAnalyzerConfigFiles Include="release.globalconfig" /></ItemGroup>\n<ImportGroup ${RELEASE}><Import Project="release.props" /></ImportGroup>\n<Target Name="Build"><PropertyGroup><LangVersion>9</LangVersion></PropertyGroup></Target>\n<PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>`,
        { 'release.props': '<Project><PropertyGroup><TreatWarningsAsErrors>true</TreatWarningsAsErrors></PropertyGroup></Project>' }
      );

      expect([project.property('Nullable'), project.isCertain('Nullable')]).toEqual([undefined, false]);
      expect(project.items('GlobalAnalyzerConfigFiles')).toEqual([]);
      expect(project.property('TreatWarningsAsErrors')).toBeUndefined();
      expect(project.property('LangVersion')).toBeUndefined();
      expect([project.property('TargetFramework'), project.isCertain('TargetFramework')]).toEqual(['net8.0', true]);
    }
  );
});

describe('imports through unknown properties', () => {
  it.each([
    ['an unknown Project path and Exists() argument', `<Import Project="$(SolutionDir)Common.props" Condition="Exists('$(SolutionDir)Common.props')" />`],
    ['an unknown Project path', `<Import Project="$(SolutionDir)Common.props" />`],
    ['an unknown Exists() argument', `<Import Project="../Common.props" Condition="Exists('$(SolutionDir)Common.props')" />`],
  ])('%s may set anything', (_, element) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-msbuild-'));
    folders.push(root);
    fs.mkdirSync(path.join(root, 'Proj'));
    fs.writeFileSync(path.join(root, 'Common.props'), '<Project><PropertyGroup><Nullable>enable</Nullable></PropertyGroup></Project>');
    fs.writeFileSync(path.join(root, 'Proj', 'Proj.csproj'), `<Project Sdk="Microsoft.NET.Sdk">\n${element}\n<PropertyGroup><TargetFramework>net48</TargetFramework></PropertyGroup>\n</Project>\n`);

    const project = readMSBuildProject(path.join(root, 'Proj', 'Proj.csproj')) as MSBuildProject;

    expect(project.isCertain('Nullable')).toBe(false);
    expect([project.property('TargetFramework'), project.isCertain('TargetFramework')]).toEqual(['net48', true]);
  });

  it('does not resolve an item Include through an unknown property', () => {
    const project = read('<ItemGroup><GlobalAnalyzerConfigFiles Include="$(SolutionDir)team.globalconfig" /></ItemGroup>', { 'team.globalconfig': 'is_global = true\n' });

    expect(project.items('GlobalAnalyzerConfigFiles')).toEqual([]);
  });
});

describe('property functions', () => {
  it('treats an instance property function such as $(X.Replace(...)) as uncertain', () => {
    const project = read(`<PropertyGroup><RootNamespace>$(MSBuildProjectName.Replace(" ", "_"))</RootNamespace></PropertyGroup>`);

    expect(project.isCertain('RootNamespace')).toBe(false);
  });
});

describe('reserved properties', () => {
  it('stay certain after an unresolvable import', () => {
    const project = read(`<Import Project="$(MSBuildToolsPath)\\Microsoft.CSharp.targets" />\n<PropertyGroup><RootNamespace>Company.$(MSBuildProjectName)</RootNamespace></PropertyGroup>`);

    expect([project.isCertain('MSBuildProjectName'), project.isCertain('MSBuildProjectDirectory')]).toEqual([true, true]);
    expect([project.property('RootNamespace'), project.isCertain('RootNamespace')]).toEqual(['Company.App', true]);
  });
});
