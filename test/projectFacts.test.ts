import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ProjectInfo } from '../src/cleanup/projectInfo';
import { ProjectFacts, computeSourceFacts, loadProjectFacts, targetFrameworksOf } from '../src/cleanup/transformations/editorConfigQualityRulesProject';

const folders: string[] = [];
afterAll(() => folders.forEach((folder) => fs.rmSync(folder, { recursive: true, force: true })));

type Files = Readonly<Record<string, string>>;

function project(files: Files): { directory: string; info: ProjectInfo } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-facts-'));
  folders.push(directory);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(directory, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }

  return { directory, info: { directory } as ProjectInfo };
}

const SDK = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>';

describe('computeSourceFacts', () => {
  const facts = computeSourceFacts(
    [
      '[assembly: System.Runtime.CompilerServices.InternalsVisibleTo("Tests")]',
      'global using System;',
      'global using System.Collections.Generic;',
      'global using Alias = System.Text;',
      'namespace N;',
      'public interface IShape { int Area { get; } void Draw(); }',
      'public class Base { }',
      'public class Derived : Base, IShape { public int Area => 1; public void Draw() { } }',
      'public class Box<T> where T : Base { void M(Derived d, Derived? e) { d.Area.ToString(); e?.Draw(); var @event = d.@Area; } }',
      'public record R(int A); public struct S { } public enum E { A } public delegate void D();',
    ].join('\n'),
  );

  it('collects member access names, also through ?. and with an @ prefix', () => {
    // Qualified names (`System.Collections`) count as member accesses too: the set only ever over-approximates.
    expect([...facts.memberAccessNames]).toEqual(expect.arrayContaining(['Area', 'Draw', 'ToString']));
    expect([...facts.memberAccessNames].some((name) => name.startsWith('@'))).toBe(false);
  });

  it('collects the declared type and interface names and the members interfaces declare', () => {
    expect([...facts.typeNames].sort()).toEqual(['Base', 'Box', 'D', 'Derived', 'E', 'IShape', 'R', 'S']);
    expect([...facts.interfaceNames]).toEqual(['IShape']);
    expect([...facts.interfaceMemberNames].sort()).toEqual(['Area', 'Draw']);
  });

  it('collects base types and constraints', () => {
    expect([...facts.derivedOrConstrainedNames]).toContain('Base');
  });

  it('reads global usings and InternalsVisibleTo', () => {
    expect([...facts.globalUsings].sort()).toEqual(['System', 'System.Collections.Generic']);
    expect(facts.internalsVisibleTo).toBe(true);
  });

  it('reports no InternalsVisibleTo when the source has none', () => {
    expect(computeSourceFacts('class C { }').internalsVisibleTo).toBe(false);
  });

  it('collects member uses inside interpolation holes, nested ones included', () => {
    const names = computeSourceFacts('class U { string M(H h) => $"{h.Format()} {$"{h?.Inner}"}" + $@"{h.Verbatim}"; }').memberAccessNames;

    expect([...names]).toEqual(expect.arrayContaining(['Format', 'Inner', 'Verbatim']));
  });

  it('collects the members a property pattern reads without a receiver', () => {
    const names = computeSourceFacts('class U { bool M(object o) => o is Shape { Kind: "square", Inner.Size: 1 }; }').memberAccessNames;

    expect([...names]).toEqual(expect.arrayContaining(['Kind', 'Inner', 'Size']));
  });
});

describe('targetFrameworksOf', () => {
  it('returns the target frameworks the project info already has, and undefined for no project', () => {
    expect(targetFrameworksOf(undefined)).toBeUndefined();
    expect(targetFrameworksOf({ directory: '/x', targetFrameworks: ['net8.0'] } as ProjectInfo)).toEqual(['net8.0']);
  });

  it('maps TargetFrameworkVersion of an old-style project', () => {
    const old472 = project({ 'A.csproj': '<Project><PropertyGroup><TargetFrameworkVersion>v4.7.2</TargetFrameworkVersion></PropertyGroup></Project>' });
    const old48 = project({ 'A.csproj': '<Project><PropertyGroup><TargetFrameworkVersion>v4.8</TargetFrameworkVersion></PropertyGroup></Project>' });

    expect(targetFrameworksOf(old472.info)).toEqual(['net472']);
    expect(targetFrameworksOf(old48.info)).toEqual(['net48']);
  });

  it('ignores a TargetFrameworkVersion in an XML comment', () => {
    const commented = project({ 'A.csproj': '<Project><!-- <PropertyGroup><TargetFrameworkVersion>v4.0</TargetFrameworkVersion></PropertyGroup> --><PropertyGroup><TargetFrameworkVersion>v4.8</TargetFrameworkVersion></PropertyGroup></Project>' });
    const only = project({ 'A.csproj': '<Project><!-- <PropertyGroup><TargetFrameworkVersion>v4.8</TargetFrameworkVersion></PropertyGroup> --></Project>' });

    expect(targetFrameworksOf(commented.info)).toEqual(['net48']);
    expect(targetFrameworksOf(only.info)).toBeUndefined();
  });

  it('is unknown without a version, without exactly one project file or without a folder', () => {
    expect(targetFrameworksOf(project({ 'A.csproj': '<Project />' }).info)).toBeUndefined();
    expect(targetFrameworksOf(project({ 'A.csproj': SDK, 'B.csproj': SDK }).info)).toBeUndefined();
    expect(targetFrameworksOf({ directory: path.join(os.tmpdir(), 'cj-does-not-exist-xyz') } as ProjectInfo)).toBeUndefined();
  });
});

describe('loadProjectFacts', () => {
  it('merges the facts of the other files and leaves the current file out', () => {
    const { directory, info } = project({
      'App.csproj': SDK,
      'A.cs': 'class A : Shared { void M(B b) { b.Run(); } }',
      'sub/B.cs': 'public class B { public void Run() { } }',
      'Current.cs': 'class OnlyHere { void M(X x) { x.OnlyCurrent(); } }',
    });

    const facts = loadProjectFacts(info, path.join(directory, 'Current.cs'));

    expect(facts.incomplete).toBeUndefined();
    expect([...facts.others.typeNames].sort()).toEqual(['A', 'B']);
    expect([...facts.others.memberAccessNames]).toEqual(['Run']);
    expect([...facts.others.derivedOrConstrainedNames]).toContain('Shared');
  });

  it('leaves out the current file asked for, also when the same project object is asked for another file', () => {
    const { directory, info } = project({ 'App.csproj': SDK, 'A.cs': 'class A { }', 'B.cs': 'class B { }' });

    expect([...loadProjectFacts(info, path.join(directory, 'A.cs')).others.typeNames]).toEqual(['B']);
    expect([...loadProjectFacts(info, path.join(directory, 'B.cs')).others.typeNames]).toEqual(['A']);
    expect([...loadProjectFacts(info, undefined).others.typeNames].sort()).toEqual(['A', 'B']);
    expect([...loadProjectFacts(info, path.join(directory, 'A.cs')).others.typeNames]).toEqual(['B']);
  });

  it('skips bin, obj, hidden folders and folders of other projects', () => {
    const { info } = project({
      'App.csproj': SDK,
      'Own.cs': 'class Own { }',
      'bin/Debug/Gen.cs': 'class FromBin { }',
      'obj/Gen.cs': 'class FromObj { }',
      '.hidden/H.cs': 'class Hidden { }',
      'Other/Other.csproj': SDK,
      'Other/Theirs.cs': 'class Theirs { }',
    });

    expect([...loadProjectFacts(info, undefined).others.typeNames]).toEqual(['Own']);
  });

  it('reads a file again when it changes', () => {
    const { directory, info } = project({ 'App.csproj': SDK, 'A.cs': 'class First { }' });
    expect([...loadProjectFacts(info, undefined).others.typeNames]).toEqual(['First']);

    fs.writeFileSync(path.join(directory, 'A.cs'), 'class Second { } // longer, so the size differs');
    const fresh = { directory } as ProjectInfo;

    expect([...loadProjectFacts(fresh, undefined).others.typeNames]).toEqual(['Second']);
  });

  it('sees files added to or removed from a folder listed before, and names the current file shares with others', () => {
    const { directory } = project({ 'App.csproj': SDK, 'src/A.cs': 'class A { void M(X x) { x.Shared(); } }', 'src/Current.cs': 'class Current { void M(X x) { x.Shared(); x.Own(); } }' });
    // Folders last changed long ago: their listing is reused until their modification time changes.
    const old = new Date(Date.now() - 60_000);
    for (const folder of [directory, path.join(directory, 'src')]) {
      fs.utimesSync(folder, old, old);
    }

    const load = (): ProjectFacts => loadProjectFacts({ directory } as ProjectInfo, path.join(directory, 'src', 'Current.cs'));
    expect([...load().others.typeNames]).toEqual(['A']);
    expect(load().others.memberAccessNames.has('Shared')).toBe(true);
    expect(load().others.memberAccessNames.has('Own')).toBe(false);

    fs.writeFileSync(path.join(directory, 'src', 'B.cs'), 'class B { void M(X x) { x.Own(); } }');
    expect([...load().others.typeNames].sort()).toEqual(['A', 'B']);
    expect(load().others.memberAccessNames.has('Own')).toBe(true);

    fs.rmSync(path.join(directory, 'src', 'A.cs'));
    fs.rmSync(path.join(directory, 'src', 'B.cs'));
    expect([...load().others.typeNames]).toEqual([]);
    expect(load().others.memberAccessNames.has('Shared')).toBe(false);
  });

  it('forgets a removed file, so one recreated with the same size and time is read again', () => {
    const { directory } = project({ 'App.csproj': SDK, 'A.cs': 'class Aaaa { }' });
    const file = path.join(directory, 'A.cs');
    const time = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(file, time, time);
    const load = (): ProjectFacts => loadProjectFacts({ directory } as ProjectInfo, undefined);
    expect([...load().others.typeNames]).toEqual(['Aaaa']);

    fs.rmSync(file);
    expect([...load().others.typeNames]).toEqual([]);

    fs.writeFileSync(file, 'class Bbbb { }');
    fs.utimesSync(file, time, time);
    expect([...load().others.typeNames]).toEqual(['Bbbb']);
  });

  it('ignores a byte order mark', () => {
    const { info } = project({ 'App.csproj': SDK, 'A.cs': '\uFEFFclass WithBom { }' });

    expect([...loadProjectFacts(info, undefined).others.typeNames]).toEqual(['WithBom']);
  });

  it('reads InternalsVisibleTo, global usings, implicit usings and the web SDK', () => {
    const fromSource = project({ 'App.csproj': SDK, 'A.cs': '[assembly: InternalsVisibleTo("T")] global using System;' });
    const fromProject = project({
      'App.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><ImplicitUsings>enable</ImplicitUsings></PropertyGroup><ItemGroup><InternalsVisibleTo Include="T" /></ItemGroup></Project>',
    });
    const usingItem = project({ 'App.csproj': '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><Using Include="System" /></ItemGroup></Project>' });
    const inherited = project({ 'Directory.Build.props': '<Project><PropertyGroup><ImplicitUsings>true</ImplicitUsings></PropertyGroup></Project>', 'src/App.csproj': SDK });

    expect(loadProjectFacts(fromSource.info, undefined)).toMatchObject({ internalsVisibleTo: true, importsSystem: true, webProject: false });
    expect(loadProjectFacts(fromProject.info, undefined)).toMatchObject({ internalsVisibleTo: true, importsSystem: true, webProject: true });
    expect(loadProjectFacts(usingItem.info, undefined).importsSystem).toBe(true);
    expect(loadProjectFacts({ directory: path.join(inherited.directory, 'src') } as ProjectInfo, undefined).importsSystem).toBe(true);
    expect(loadProjectFacts(project({ 'App.csproj': SDK }).info, undefined)).toMatchObject({ importsSystem: false, internalsVisibleTo: false });
  });

  it('reads InternalsVisibleTo added as an AssemblyAttribute item', () => {
    const item = (include: string): ProjectFacts =>
      loadProjectFacts(
        project({ 'App.csproj': `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><AssemblyAttribute Include="${include}"><_Parameter1>App.Tests</_Parameter1></AssemblyAttribute></ItemGroup></Project>` }).info,
        undefined
      );

    expect(item('System.Runtime.CompilerServices.InternalsVisibleToAttribute').internalsVisibleTo).toBe(true);
    expect(item('System.Runtime.CompilerServices.InternalsVisibleTo').internalsVisibleTo).toBe(true);
    expect(item('System.CLSCompliantAttribute').internalsVisibleTo).toBe(false);
  });

  it('prefers the project own ImplicitUsings over the inherited one', () => {
    const { directory } = project({
      'Directory.Build.props': '<Project><PropertyGroup><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>',
      'src/App.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><ImplicitUsings>disable</ImplicitUsings></PropertyGroup></Project>',
    });

    expect(loadProjectFacts({ directory: path.join(directory, 'src') } as ProjectInfo, undefined).importsSystem).toBe(false);
  });

  it('reads only the nearest Directory.Build file, and its ancestors only when it imports them', () => {
    const enable = '<Project><PropertyGroup><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>';
    const chain = '<Import Project="$([MSBuild]::GetPathOfFileAbove(\'Directory.Build.props\', \'$(MSBuildThisFileDirectory)../\'))" />';
    const importsSystem = (files: Files): boolean =>
      loadProjectFacts({ directory: path.join(project(files).directory, 'src') } as ProjectInfo, undefined).importsSystem;

    expect(importsSystem({ 'Directory.Build.props': enable, 'src/Directory.Build.props': '<Project />', 'src/App.csproj': SDK })).toBe(false);
    expect(importsSystem({ 'Directory.Build.props': enable, 'src/Directory.Build.props': `<Project>${chain}</Project>`, 'src/App.csproj': SDK })).toBe(true);
    expect(
      importsSystem({
        'Directory.Build.props': enable,
        'src/Directory.Build.props': `<Project>${chain}<PropertyGroup><ImplicitUsings>disable</ImplicitUsings></PropertyGroup></Project>`,
        'src/App.csproj': SDK,
      })
    ).toBe(false);
    expect(
      importsSystem({
        'src/Directory.Build.targets': '<Project><PropertyGroup><ImplicitUsings>disable</ImplicitUsings></PropertyGroup></Project>',
        'src/App.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>',
      })
    ).toBe(false);
    expect(
      importsSystem({
        'src/App.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><ImplicitUsings>enable</ImplicitUsings></PropertyGroup><ItemGroup><Using Remove="System" /></ItemGroup></Project>',
      })
    ).toBe(false);
  });

  it('follows a Directory.Build file importing the next one above through $(MSBuildThisFile)', () => {
    const friend = '<Project><ItemGroup><InternalsVisibleTo Include="Friend" /></ItemGroup></Project>';
    const above = (name: string): string => `<Import Project="$([MSBuild]::GetPathOfFileAbove('${name}', '$(MSBuildThisFileDirectory)../'))" />`;
    const exposed = (files: Files): ProjectFacts => loadProjectFacts({ directory: path.join(project(files).directory, 'src') } as ProjectInfo, undefined);

    for (const chain of [above('$(MSBuildThisFile)'), above('$(MSBuildThisFileName)$(MSBuildThisFileExtension)'), `<Import Project="$([MSBuild]::GetPathOfFileAbove($(MSBuildThisFile), $(MSBuildThisFileDirectory)..))" />`]) {
      const facts = exposed({ 'Directory.Build.props': friend, 'src/Directory.Build.props': `<Project>${chain}</Project>`, 'src/App.csproj': SDK });
      expect(facts.internalsVisibleTo, chain).toBe(true);
      expect(facts.incomplete, chain).toBeUndefined();
    }
  });

  it('reads the files a Directory.Build file imports by path, and reports an import it cannot resolve as incomplete', () => {
    const friend = '<Project><ItemGroup><InternalsVisibleTo Include="Friend" /></ItemGroup></Project>';
    const facts = (props: string, extra: Files = {}): ProjectFacts =>
      loadProjectFacts({ directory: path.join(project({ 'src/Directory.Build.props': props, 'src/App.csproj': SDK, ...extra }).directory, 'src') } as ProjectInfo, undefined);

    const relative = facts('<Project><Import Project="$(MSBuildThisFileDirectory)eng\\Friends.props" /></Project>', { 'src/eng/Friends.props': friend });
    expect(relative.internalsVisibleTo).toBe(true);
    expect(relative.incomplete).toBeUndefined();

    const optional = facts('<Project><Import Project="Local.props" Condition="Exists(\'Local.props\')" /><Import Project="Sdk.props" Sdk="Microsoft.NET.Sdk" /></Project>');
    expect(optional.incomplete).toBeUndefined();

    expect(facts('<Project><Import Project="$(RepoRoot)eng/Versions.props" /></Project>').incomplete).toContain('$(RepoRoot)eng/Versions.props');
    expect(facts('<Project><Import Project="eng/Missing.props" /></Project>').incomplete).toContain('Missing.props');
  });

  it('reads the files the project file imports, in place, and reports an import of it that cannot be resolved', () => {
    const friend = '<Project><ItemGroup><InternalsVisibleTo Include="Friend" /></ItemGroup></Project>';
    const importing = (imports: string, extra: Files = {}): ProjectFacts =>
      loadProjectFacts(
        { directory: path.join(project({ 'src/App.csproj': `<Project Sdk="Microsoft.NET.Sdk">${imports}</Project>`, ...extra }).directory, 'src') } as ProjectInfo,
        undefined
      );

    const shared = importing('<Import Project="..\\common.props" />', { 'common.props': friend });
    expect(shared.internalsVisibleTo).toBe(true);
    expect(shared.incomplete).toBeUndefined();

    const ordered = importing('<Import Project="..\\on.props" /><PropertyGroup><ImplicitUsings>disable</ImplicitUsings></PropertyGroup>', {
      'on.props': '<Project><PropertyGroup><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>',
    });
    expect(ordered.importsSystem).toBe(false);

    const itemsOff = importing('<Import Project="..\\off.props" />', {
      'off.props': '<Project><PropertyGroup><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup></Project>',
      'src/Own.cs': 'class Own { }',
    });
    expect([...itemsOff.others.typeNames]).toEqual([]);

    const included = importing('<Import Project="..\\files.props" />', { 'files.props': '<Project><ItemGroup><Compile Include="../x.cs" /></ItemGroup></Project>' });
    expect(included.incomplete).toContain('<Compile Include>');

    expect(importing('<Import Project="$(RepoRoot)eng/Versions.props" />').incomplete).toContain('$(RepoRoot)eng/Versions.props');
    expect(importing('<Import Project="eng/Missing.props" />').incomplete).toContain('Missing.props');
  });

  it('ignores properties, items and imports in XML comments', () => {
    const commented = (body: string, extra: Files = {}): ProjectFacts =>
      loadProjectFacts(project({ 'App.csproj': `<Project Sdk="Microsoft.NET.Sdk"><!-- ${body} --></Project>`, 'Own.cs': 'class Own { }', ...extra }).info, undefined);

    expect(commented('<PropertyGroup><ImplicitUsings>enable</ImplicitUsings></PropertyGroup>').importsSystem).toBe(false);
    expect(commented('<ItemGroup><Using Include="System" /></ItemGroup>').importsSystem).toBe(false);
    expect([...commented('<PropertyGroup><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup>').others.typeNames]).toEqual(['Own']);
    expect(commented('<ItemGroup><InternalsVisibleTo Include="Friend" /></ItemGroup>').internalsVisibleTo).toBe(false);
    expect(commented('<ItemGroup><Page Include="MainWindow.xaml" /></ItemGroup>').markup).toBeUndefined();
    expect(commented('<ItemGroup><Compile Include="Gen\\**\\*.cs" /></ItemGroup>').incomplete).toBeUndefined();

    const inherited = project({
      'Directory.Build.props': '<Project><!-- <PropertyGroup><ImplicitUsings>enable</ImplicitUsings></PropertyGroup> --></Project>',
      'src/App.csproj': SDK,
    });
    expect(loadProjectFacts({ directory: path.join(inherited.directory, 'src') } as ProjectInfo, undefined).importsSystem).toBe(false);
  });

  it('imports a Directory.Build file once when imports by path and GetPathOfFileAbove form a cycle', () => {
    const above = '<Import Project="$([MSBuild]::GetPathOfFileAbove(\'Directory.Build.props\', \'$(MSBuildThisFileDirectory)../\'))" />';
    const { directory } = project({
      'Directory.Build.props': '<Project><Import Project="src/Directory.Build.props" /><ItemGroup><InternalsVisibleTo Include="Friend" /></ItemGroup></Project>',
      'src/Directory.Build.props': `<Project>${above}</Project>`,
      'src/App.csproj': SDK,
    });
    const facts = loadProjectFacts({ directory: path.join(directory, 'src') } as ProjectInfo, undefined);

    expect(facts.incomplete).toBeUndefined();
    expect(facts.internalsVisibleTo).toBe(true);
  });

  it('keeps markup apart from incomplete sources, and counts Razor components as declared types', () => {
    const mvc = loadProjectFacts(project({ 'App.csproj': SDK, 'Other.cs': 'class Other { }', 'Views/Home/Index.cshtml': '<p>Hi</p>', 'Pages/Counter.razor': '<p>0</p>' }).info, undefined);
    expect(mvc.incomplete).toBeUndefined();
    expect(mvc.markup).toMatch(/\.(?:cshtml|razor)$/);
    expect([...mvc.others.typeNames].sort()).toEqual(['Counter', 'Other']);

    const listed = loadProjectFacts(project({ 'App.csproj': '<Project><ItemGroup><Compile Include="Own.cs" /><Page Include="MainWindow.xaml" /></ItemGroup></Project>', 'Own.cs': 'class Own { }' }).info, undefined);
    expect(listed.incomplete).toBeUndefined();
    expect(listed.markup).toContain('MainWindow.xaml');

    expect(loadProjectFacts(project({ 'App.csproj': SDK, 'Other.cs': 'class Other { }' }).info, undefined).markup).toBeUndefined();
  });

  it('lists the default compile items even when a Directory.Build file the project does not import turns them off', () => {
    const { directory } = project({
      'Directory.Build.props': '<Project><PropertyGroup><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup></Project>',
      'src/Directory.Build.props': '<Project />',
      'src/App.csproj': SDK,
      'src/Own.cs': 'class Own { }',
    });

    expect([...loadProjectFacts({ directory: path.join(directory, 'src') } as ProjectInfo, undefined).others.typeNames]).toEqual(['Own']);
  });

  it('adds explicit <Compile Include> files of an old-style project', () => {
    const { info } = project({
      'App.csproj': '<Project><ItemGroup><Compile Include="Own.cs" /><Compile Include="..\\Shared\\Shared.cs" /></ItemGroup></Project>',
      'Own.cs': 'class Own { }',
    });

    // An old-style project lists its files: only the listed ones are read, and an include that does
    // not exist makes the facts incomplete instead of being skipped silently.
    const facts = loadProjectFacts(info, undefined);

    expect([...facts.others.typeNames]).toEqual(['Own']);
    expect(facts.incomplete).toContain('could not be read');
  });

  it('reports a pattern in <Compile Include>, a shared project and Directory.Build includes as incomplete', () => {
    const pattern = project({ 'App.csproj': '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><Compile Include="Gen\\**\\*.cs" /></ItemGroup></Project>' });
    const shared = project({ 'App.csproj': '<Project Sdk="Microsoft.NET.Sdk"><Import Project="..\\Shared\\Shared.projitems" /></Project>' });
    const build = project({ 'Directory.Build.props': '<Project><ItemGroup><Compile Include="../x.cs" /></ItemGroup></Project>', 'src/App.csproj': SDK });

    expect(loadProjectFacts(pattern.info, undefined).incomplete).toContain('pattern');
    expect(loadProjectFacts(shared.info, undefined).incomplete).toContain('shared project');
    expect(loadProjectFacts({ directory: path.join(build.directory, 'src') } as ProjectInfo, undefined).incomplete).toContain('Directory.Build');
  });

  it('reports a folder without exactly one project file as incomplete', () => {
    expect(loadProjectFacts(project({ 'A.csproj': SDK, 'B.csproj': SDK }).info, undefined).incomplete).toContain('exactly one project file');
    expect(loadProjectFacts(project({ 'X.cs': 'class X { }' }).info, undefined).incomplete).toContain('exactly one project file');
  });

  it('reports a project folder that cannot be read as incomplete', () => {
    const missing = { directory: path.join(os.tmpdir(), 'cj-missing-folder-abc') } as ProjectInfo;

    expect(loadProjectFacts(missing, undefined).incomplete).toBeDefined();
  });

  it('adds nothing for an SDK project with default items turned off', () => {
    const { info } = project({
      'App.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup><ItemGroup><Compile Include="Own.cs" /></ItemGroup></Project>',
      'Own.cs': 'class Own { }',
      'Other.cs': 'class Other { }',
    });

    expect([...loadProjectFacts(info, undefined).others.typeNames]).toEqual(['Own']);
  });
});
