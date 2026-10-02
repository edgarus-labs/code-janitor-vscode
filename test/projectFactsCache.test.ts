import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectInfo } from '../src/cleanup/projectInfo';
import { loadProjectFacts } from '../src/cleanup/transformations/editorConfigQualityRulesProject';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();

  return { ...actual, statSync: vi.fn(actual.statSync) };
});

const folders: string[] = [];
afterAll(() => folders.forEach((folder) => fs.rmSync(folder, { recursive: true, force: true })));
afterEach(() => vi.useRealTimers());

const SDK = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>';

/** A project of `count` files `F0.cs` ... with one class each. */
function project(count: number): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-facts-cache-'));
  folders.push(directory);
  fs.writeFileSync(path.join(directory, 'App.csproj'), SDK);
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(directory, `F${i}.cs`), `class C${i} { }\n`);
  }

  return directory;
}

/** What `findProject` returns: a new object for every file. */
function info(directory: string): ProjectInfo {
  return { directory };
}

describe('loadProjectFacts across the files of one batch', () => {
  it('does not stat every file of the project again for each file', () => {
    const directory = project(50);
    loadProjectFacts(info(directory), path.join(directory, 'F0.cs'));

    const stat = vi.mocked(fs.statSync);
    stat.mockClear();
    for (let i = 1; i < 50; i++) {
      loadProjectFacts(info(directory), path.join(directory, `F${i}.cs`));
    }

    // One stat per file just cleaned, not one per file of the project per file cleaned.
    expect(stat.mock.calls.length).toBeLessThan(100);
  });

  it('reads a file the batch cleaned before again, so the next file sees its new declarations', () => {
    const directory = project(2);
    const first = path.join(directory, 'F0.cs');
    expect(loadProjectFacts(info(directory), first).others.typeNames.has('C1')).toBe(true);

    fs.writeFileSync(first, 'class Renamed : C1 { }\n');
    const next = loadProjectFacts(info(directory), path.join(directory, 'F1.cs'));
    expect([...next.others.typeNames]).toEqual(['Renamed']);
    expect(next.others.derivedOrConstrainedNames.has('C1')).toBe(true);
  });

  it('scans the whole project again for a later cleanup', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const directory = project(3);
    expect(loadProjectFacts(info(directory), path.join(directory, 'F0.cs')).others.typeNames.has('C2')).toBe(true);

    // Edited outside the cleanup (not a file the batch cleaned), seen once the batch is over.
    fs.writeFileSync(path.join(directory, 'F2.cs'), 'class Edited { }\n');
    vi.advanceTimersByTime(60_000);
    expect([...loadProjectFacts(info(directory), path.join(directory, 'F1.cs')).others.typeNames].sort()).toEqual(['C0', 'Edited']);
  });

  it('scans the whole project again when a file is cleaned again, which starts a new cleanup', () => {
    const directory = project(2);
    const current = path.join(directory, 'F0.cs');
    expect(loadProjectFacts(info(directory), current).others.typeNames.has('C1')).toBe(true);

    fs.writeFileSync(path.join(directory, 'F1.cs'), 'class Edited { }\n');
    expect([...loadProjectFacts(info(directory), current).others.typeNames]).toEqual(['Edited']);
  });
});
