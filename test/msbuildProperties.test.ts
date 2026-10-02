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
