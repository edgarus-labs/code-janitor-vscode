import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ProjectInfo } from '../src/cleanup/projectInfo';
import { computeSourceFacts, loadProjectFacts, targetFrameworksOf } from '../src/cleanup/transformations/editorConfigQualityRulesProject';

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

  it('is unknown without a version, without exactly one project file or without a folder', () => {
    expect(targetFrameworksOf(project({ 'A.csproj': '<Project />' }).info)).toBeUndefined();
    expect(targetFrameworksOf(project({ 'A.csproj': SDK, 'B.csproj': SDK }).info)).toBeUndefined();
    expect(targetFrameworksOf({ directory: path.join(os.tmpdir(), 'cj-does-not-exist-xyz') } as ProjectInfo)).toBeUndefined();
  });

  it('answers the same for the same project object', () => {
    const { info } = project({ 'A.csproj': '<Project><PropertyGroup><TargetFrameworkVersion>v4.6.1</TargetFrameworkVersion></PropertyGroup></Project>' });

    expect(targetFrameworksOf(info)).toEqual(['net461']);
    expect(targetFrameworksOf(info)).toBe(targetFrameworksOf(info));
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

  it('caches per project object and current file', () => {
    const { directory, info } = project({ 'App.csproj': SDK, 'A.cs': 'class A { }' });
    const current = path.join(directory, 'A.cs');

    expect(loadProjectFacts(info, current)).toBe(loadProjectFacts(info, current));
    expect(loadProjectFacts(info, undefined)).not.toBe(loadProjectFacts(info, current));
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

  it('prefers the project own ImplicitUsings over the inherited one', () => {
    const { directory } = project({
      'Directory.Build.props': '<Project><PropertyGroup><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>',
      'src/App.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><ImplicitUsings>disable</ImplicitUsings></PropertyGroup></Project>',
    });

    expect(loadProjectFacts({ directory: path.join(directory, 'src') } as ProjectInfo, undefined).importsSystem).toBe(false);
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
