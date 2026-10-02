import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { QUALITY_RULES_METADATA } from '../src/cleanup/analyzerRules';
import { loadEditorConfigProperties, resolveDiagnosticSeverity } from '../src/cleanup/editorconfig';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();

  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

const folders: string[] = [];
afterAll(() => folders.forEach((folder) => fs.rmSync(folder, { recursive: true, force: true })));

/** An SDK project with one `.cs` file in each of `count` folders (and a `.globalconfig` in the last one), all modified an hour ago. */
function project(count: number, globalConfig = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-globalconfig-cache-'));
  folders.push(root);
  fs.writeFileSync(path.join(root, '.editorconfig'), 'root = true\n');
  fs.writeFileSync(path.join(root, 'App.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>');
  for (let i = 0; i < count; i++) {
    fs.mkdirSync(path.join(root, `D${i}`));
    fs.writeFileSync(path.join(root, `D${i}`, `F${i}.cs`), `class C${i} { }\n`);
  }

  if (globalConfig) {
    fs.writeFileSync(path.join(root, `D${count - 1}`, '.globalconfig'), 'is_global = true\ndotnet_diagnostic.CA1805.severity = warning\n');
  }

  // Folders changed this recently could still change unnoticed, so their listing would never be reused.
  const anHourAgo = new Date(Date.now() - 3_600_000);
  for (const folder of [root, ...Array.from({ length: count }, (_, i) => path.join(root, `D${i}`))]) {
    fs.utimesSync(folder, anHourAgo, anHourAgo);
  }

  return root;
}

describe('.globalconfig discovery across the files of one project', () => {
  it('does not look for .globalconfig above every compile folder again for each file', () => {
    const root = project(40);
    const severity = (file: string) => resolveDiagnosticSeverity(loadEditorConfigProperties(file), 'CA1805', undefined, QUALITY_RULES_METADATA.CA1805.category);
    expect(severity(path.join(root, 'D0', 'F0.cs'))).toBe('warning');

    const exists = vi.mocked(fs.existsSync);
    exists.mockClear();
    expect(severity(path.join(root, 'D1', 'F1.cs'))).toBe('warning');

    const globalConfigLookups = exists.mock.calls.filter(([candidate]) => String(candidate).endsWith('.globalconfig')).length;
    // Only the folders above the file and the project are looked at again; the 40 compile folders are known from the first file.
    expect(globalConfigLookups).toBeLessThan(20);
  });

  it('finds a .globalconfig added to a compile folder after the first file', () => {
    const root = project(3, false);
    const severity = (file: string) => resolveDiagnosticSeverity(loadEditorConfigProperties(file), 'CA1805', undefined, QUALITY_RULES_METADATA.CA1805.category);
    expect(severity(path.join(root, 'D0', 'F0.cs'))).not.toBe('error');

    fs.writeFileSync(path.join(root, 'D1', '.globalconfig'), 'is_global = true\ndotnet_diagnostic.CA1805.severity = error\n');

    expect(severity(path.join(root, 'D2', 'F2.cs'))).toBe('error');
  });
});
