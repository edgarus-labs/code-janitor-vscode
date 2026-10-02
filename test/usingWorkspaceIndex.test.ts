import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectContext, clearUsingIndexCache, projectContextOf } from '../src/cleanup/usings/workspaceIndex';

const PLAIN_PROJECT = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>';

let root: string;

function write(relative: string, text: string): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);

  return file;
}

function context(file: string, source = fs.readFileSync(file, 'utf8')): ProjectContext {
  const result = projectContextOf(file, source);
  if ('unavailable' in result) {
    throw new Error(result.unavailable);
  }

  return result;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-index-'));
  clearUsingIndexCache();
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('project context of a file', () => {
  it('indexes the declarations of the project, the file being cleaned as it reads now', () => {
    write('App/App.csproj', PLAIN_PROJECT);
    write('App/Other.cs', 'namespace Company.Other { class Thing { } }');
    const file = write('App/Sample.cs', 'namespace Company.OnDisk { class Old { } }');
    const index = context(file, 'namespace Company.Edited { class New { } }').index;

    expect(index.hasType('Company.Other.Thing')).toBe(true);
    expect(index.hasType('Company.Edited.New')).toBe(true);
    // What the file declared on disk is no longer there: its text is the one being cleaned.
    expect(index.hasType('Company.OnDisk.Old')).toBe(false);
  });

  it('includes the projects it references, also through other projects', () => {
    write('App/App.csproj', '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><ProjectReference Include="../Mid/Mid.csproj" /></ItemGroup></Project>');
    write('Mid/Mid.csproj', '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><ProjectReference Include="../Core/Core.csproj" /></ItemGroup></Project>');
    write('Core/Core.csproj', PLAIN_PROJECT);
    write('Core/Core.cs', 'namespace Company.Core { public class Engine { } }');
    write('Mid/Mid.cs', 'namespace Company.Mid { public class Bridge { } }');
    write('Elsewhere/Elsewhere.csproj', PLAIN_PROJECT);
    write('Elsewhere/Elsewhere.cs', 'namespace Company.Elsewhere { public class Unrelated { } }');
    const { index } = context(write('App/Sample.cs', 'class Sample { }'));

    expect(index.hasType('Company.Core.Engine')).toBe(true);
    expect(index.hasType('Company.Mid.Bridge')).toBe(true);
    expect(index.hasType('Company.Elsewhere.Unrelated')).toBe(false);
  });

  it('does not count the files of a nested project for the outer one', () => {
    write('App/App.csproj', PLAIN_PROJECT);
    write('App/Tools/Tools.csproj', PLAIN_PROJECT);
    write('App/Tools/Tool.cs', 'namespace Company.Tools { class Tool { } }');
    const { index } = context(write('App/Sample.cs', 'class Sample { }'));

    expect(index.hasType('Company.Tools.Tool')).toBe(false);
  });

  it('reads global usings of any file of the project', () => {
    write('App/App.csproj', PLAIN_PROJECT);
    write('App/Globals.cs', 'global using System.Text;\n');

    expect(context(write('App/Sample.cs', 'class Sample { }')).index.globalUsings()).toEqual(['System . Text']);
  });

  it.each([
    ['a file without a project', () => path.join(os.tmpdir(), 'cj-no-project', 'Lonely.cs'), /not part of a C# project/],
    ['an empty path', () => '', /not part of a C# project/],
  ])('has none for %s', (_name, file, reason) => {
    expect(projectContextOf(file(), 'class C { }')).toEqual({ unavailable: expect.stringMatching(reason) });
  });

  it('has none where several project files share the folder', () => {
    write('App/One.csproj', PLAIN_PROJECT);
    write('App/Two.csproj', PLAIN_PROJECT);

    expect(projectContextOf(write('App/Sample.cs', 'class Sample { }'), 'class Sample { }')).toEqual({ unavailable: expect.stringMatching(/several project files/) });
  });

  it('finds the project from a subfolder', () => {
    write('App/App.csproj', PLAIN_PROJECT);
    write('App/Other.cs', 'namespace Company.Other { class Thing { } }');

    expect(context(write('App/Deep/Er/Sample.cs', 'class Sample { }')).index.hasType('Company.Other.Thing')).toBe(true);
  });

  it('marks the index incomplete when the project compiles files from outside its folder', () => {
    write('App/App.csproj', '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><Compile Include="../Shared/**/*.cs" /></ItemGroup></Project>');

    expect(context(write('App/Sample.cs', 'class Sample { }')).incomplete).toMatch(/adds C# files from outside its folder/);
  });

  it('notices a declaration added to the project after the first look', () => {
    write('App/App.csproj', PLAIN_PROJECT);
    const file = write('App/Sample.cs', 'class Sample { }');
    expect(context(file).index.hasType('Company.Added.Late')).toBe(false);

    write('App/Late.cs', 'namespace Company.Added { class Late { } }');
    clearUsingIndexCache();

    expect(context(file).index.hasType('Company.Added.Late')).toBe(true);
  });
});

describe('implicit usings', () => {
  const globals = (file: string): string[] => context(file).index.globalUsings().sort();

  it('are global usings of the project when the SDK adds them', () => {
    write('App/App.csproj', '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>');

    expect(globals(write('App/Sample.cs', 'class Sample { }'))).toEqual(
      ['System', 'System . Collections . Generic', 'System . IO', 'System . Linq', 'System . Net . Http', 'System . Threading', 'System . Threading . Tasks'].sort()
    );
  });

  it('come from Directory.Build.props too, and the project can turn them off', () => {
    write('Directory.Build.props', '<Project><PropertyGroup><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>');
    write('App/App.csproj', PLAIN_PROJECT);
    write('Off/Off.csproj', '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><ImplicitUsings>disable</ImplicitUsings></PropertyGroup></Project>');

    expect(globals(write('App/Sample.cs', 'class Sample { }'))).toContain('System . Linq');
    expect(globals(write('Off/Sample.cs', 'class Sample { }'))).toEqual([]);
  });

  it('include those of the web SDK, and mark the index incomplete for an SDK that is not known', () => {
    write('Web/Web.csproj', '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>');
    write('Other/Other.csproj', '<Project Sdk="Vendor.Sdk"><PropertyGroup><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>');

    expect(globals(write('Web/Sample.cs', 'class Sample { }'))).toContain('Microsoft . AspNetCore . Builder');
    expect(context(write('Other/Sample.cs', 'class Sample { }')).incomplete).toMatch(/implicit usings of the SDK Vendor\.Sdk are not known/);
  });

  it('are none when nothing enables them', () => {
    write('App/App.csproj', PLAIN_PROJECT);

    expect(globals(write('App/Sample.cs', 'class Sample { }'))).toEqual([]);
  });

  it('include the <Using> items of the project and of Directory.Build.props, even with implicit usings off', () => {
    write('Directory.Build.props', '<Project><ItemGroup><Using Include="Lib" /></ItemGroup></Project>');
    write(
      'App/App.csproj',
      `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>
  <Using Include="System.Math" Static="true" />
  <Using Include="System.Text.StringBuilder" Alias="Builder" />
  <Using Include="Tools"><Static>True</Static></Using>
</ItemGroup></Project>`
    );

    expect(globals(write('App/Sample.cs', 'class Sample { }'))).toEqual(['Builder = System . Text . StringBuilder', 'Lib', 'static System . Math', 'static Tools'].sort());
  });

  it('drop an item a later <Using Remove> takes out, implicit ones too', () => {
    write(
      'App/App.csproj',
      '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><ImplicitUsings>enable</ImplicitUsings></PropertyGroup><ItemGroup><Using Include="Lib" /><Using Remove="Lib" /><Using Remove="System.Net.Http" /></ItemGroup></Project>'
    );
    const found = globals(write('App/Sample.cs', 'class Sample { }'));

    expect(found).toContain('System . Linq');
    expect(found).not.toContain('Lib');
    expect(found).not.toContain('System . Net . Http');
  });

  it.each([
    ['in a conditioned ItemGroup', `<ItemGroup Condition="'$(TargetFramework)' == 'net48'"><Using Remove="System.Linq" /></ItemGroup>`],
    ['in a conditioned When', `<Choose><When Condition="'$(X)' == '1'"><ItemGroup><Using Remove="System.Linq" /></ItemGroup></When></Choose>`],
    ['in an Otherwise', `<Choose><When Condition="'$(X)' == '1'"></When><Otherwise><ItemGroup><Using Remove="System.Linq" /></ItemGroup></Otherwise></Choose>`],
    ['in a Target', '<Target Name="T"><ItemGroup><Using Remove="System.Linq" /></ItemGroup></Target>'],
    ['in an XML comment', '<ItemGroup><!-- <Using Remove="System.Linq" /> --></ItemGroup>'],
  ])('keep an item a <Using Remove> %s may not take out', (_name, group) => {
    write('App/App.csproj', `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><ImplicitUsings>enable</ImplicitUsings></PropertyGroup>${group}</Project>`);

    expect(globals(write('App/Sample.cs', 'class Sample { }'))).toContain('System . Linq');
  });

  it('apply a <Using Remove> after a conditioned ItemGroup has closed', () => {
    write(
      'App/App.csproj',
      `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><ImplicitUsings>enable</ImplicitUsings></PropertyGroup><ItemGroup Condition="'$(X)' == '1'"><Using Include="Lib" /></ItemGroup><ItemGroup><Using Remove="System.Linq" /></ItemGroup></Project>`
    );

    expect(globals(write('App/Sample.cs', 'class Sample { }'))).not.toContain('System . Linq');
  });

  it('read <Using> items and the SDK written with single quotes', () => {
    write('App/App.csproj', `<Project Sdk='Microsoft.NET.Sdk.Web'><ItemGroup><Using Include='Lib' /><Using Include='System.Math' Static='true' /></ItemGroup><PropertyGroup><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>`);
    const found = globals(write('App/Sample.cs', 'class Sample { }'));

    expect(found).toContain('Lib');
    expect(found).toContain('static System . Math');
    expect(found).toContain('Microsoft . AspNetCore . Builder');
  });

  it('do not take implicit usings or items from an XML comment', () => {
    write('App/App.csproj', '<Project Sdk="Microsoft.NET.Sdk"><!-- <PropertyGroup><ImplicitUsings>enable</ImplicitUsings></PropertyGroup><ItemGroup><Using Include="Lib" /></ItemGroup> --></Project>');

    expect(globals(write('App/Sample.cs', 'class Sample { }'))).toEqual([]);
  });

  it('mark the index incomplete for a <Using> item MSBuild has to evaluate', () => {
    write('App/App.csproj', '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><Using Include="$(RootNamespace).Models" /></ItemGroup></Project>');

    expect(context(write('App/Sample.cs', 'class Sample { }')).incomplete).toMatch(/<Using> item/);
  });
});

describe('references outside the framework', () => {
  it.each([
    ['none in a plain project', PLAIN_PROJECT, undefined, false],
    ['a PackageReference', '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Newtonsoft.Json" Version="13.0.3" /></ItemGroup></Project>', undefined, true],
    ['an assembly Reference', '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><Reference Include="Vendor"><HintPath>v.dll</HintPath></Reference></ItemGroup></Project>', undefined, true],
    ['a web SDK', '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>', undefined, true],
    ['a package added by Directory.Build.props', PLAIN_PROJECT, '<Project><ItemGroup><PackageReference Include="X" Version="1" /></ItemGroup></Project>', true],
  ])('%s', (_name, project, props, expected) => {
    write('App/App.csproj', project);
    if (props) {
      write('Directory.Build.props', props);
    }

    expect(context(write('App/Sample.cs', 'class Sample { }')).externalReferences).toBe(expected);
  });
});
