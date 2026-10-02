import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { newCompilerErrors } from '../scripts/compileOracle';
import { runCleanup } from '../src/cleanup/runCleanup';
import { createDefaultSettings } from '../src/cleanup/types';
import { buildProject, dotnetAvailable, formatErrors, writeProject } from './helpers/dotnetBuild';

/**
 * CA1852 (seal) and CA1822 (make static) change a declaration other files may depend on. They may
 * only do so when the other files of the project, read from disk, do not need the old declaration;
 * the real compiler checks that the project still builds.
 */
const EDITORCONFIG = `root = true

[*.cs]
dotnet_diagnostic.CA1852.severity = warning
dotnet_diagnostic.CA1822.severity = warning
`;

const files: Record<string, string> = {
  '.editorconfig': EDITORCONFIG,
  'Base.cs': 'internal class Base { public int Id => 1; }\n',
  'Derived.cs': 'internal sealed class Derived : Base { public int Twice() => Id * 2; }\n',
  'Generic.cs': 'internal class Constraint { }\ninternal class Holder<T> where T : Constraint { public T? Value { get; set; } }\n',
  'Alone.cs': 'internal class Alone { public int Value => 3; }\n',
  'Util.cs': 'internal class Util { internal int Twice(int x) => x * 2; internal int Unused(int x) => x + 1; }\n',
  'User.cs': 'internal static class User { public static int Use() { var u = new Util(); return u.Twice(3) + new Alone().Value + new Derived().Twice() + new Holder<Constraint>().GetHashCode(); } }\n',
};

const folders: string[] = [];
afterAll(() => folders.forEach((folder) => fs.rmSync(folder, { recursive: true, force: true })));

function cleanProject(): { folder: string; text: (name: string) => string } {
  const folder = writeProject(files);
  folders.push(folder);

  return { folder, text: (name) => fs.readFileSync(path.join(folder, name), 'utf8') };
}

describe.skipIf(!dotnetAvailable)('cross-file facts of seal / make static against the compiler', () => {
  const { folder, text } = cleanProject();
  const before = buildProject(folder);

  it('builds before cleanup', () => {
    expect(before.errors, formatErrors(before)).toEqual([]);
  }, 120_000);

  it('cleans every file, keeps what other files need and still builds', () => {
    for (const name of Object.keys(files).filter((file) => file.endsWith('.cs'))) {
      const file = path.join(folder, name);
      fs.writeFileSync(file, runCleanup(fs.readFileSync(file, 'utf8'), file, createDefaultSettings()));
    }

    expect(text('Base.cs'), 'a base type of another file is never sealed').not.toMatch(/sealed class Base/);
    expect(text('Generic.cs'), 'a type used as a generic constraint is never sealed').not.toMatch(/sealed class Constraint/);
    expect(text('Util.cs'), 'a member another file calls is never made static').toMatch(/int Twice\(int x\)/);
    expect(text('Util.cs')).not.toMatch(/static int Twice/);

    expect(text('Alone.cs'), 'a type nothing derives from is sealed').toMatch(/sealed class Alone/);
    expect(text('Util.cs'), 'a member nothing calls is made static').toMatch(/static int Unused/);

    const after = buildProject(folder);
    expect(newCompilerErrors(before.errors, after.errors), formatErrors(after)).toEqual([]);
  }, 120_000);
});
