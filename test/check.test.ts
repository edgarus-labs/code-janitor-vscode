import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runServerCheck } from '../scripts/engineServer';
import { dotnetAvailable } from './helpers/dotnetBuild';

const EDITORCONFIG = ['root = true', '', '[*.cs]', 'csharp_prefer_braces = true:warning', ''].join('\n');

const CLEAN = 'namespace Demo;\n\ninternal sealed class Clean\n{\n    public int Total;\n}\n';
// A change or unfixable violation (`path:line: label: message`), or a note of the engine (`path: note: message`).
const REPORT_LINE = /^[^:]+\.cs(:\d+: .+: .+|: note: .+)$/;

describe.skipIf(!dotnetAvailable)('npm run check (the C# engine check command)', () => {
  let root: string;
  const check = (...paths: string[]) => runServerCheck(['--root', root, ...paths], root);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codejanitor-check-'));
    fs.writeFileSync(path.join(root, '.editorconfig'), EDITORCONFIG);
    fs.mkdirSync(path.join(root, 'src', 'obj'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'Clean.cs'), CLEAN);
    fs.writeFileSync(path.join(root, 'src', 'obj', 'Generated.cs'), 'internal class Generated { void M(bool b) { if (b) M(b); } }\n');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('passes when no file would change, skipping bin and obj', () => {
    const report = check('src');

    expect(report.lines.at(-1)).toBe('Code Janitor check: 1 file(s) checked, all clean.');
    expect(report.exitCode).toBe(0);
  });

  it('fails and lists file:line: rule (severity): message for each change cleanup would make', () => {
    fs.writeFileSync(
      path.join(root, 'src', 'Dirty.cs'),
      'namespace Demo;\n\ninternal sealed class Dirty\n{\n    public int Total;\n\n    public void Add(int value)\n    {\n        if (value > 0)\n            Total += value;\n    }\n}\n'
    );

    const report = check('src');

    const findings = report.lines.slice(0, -1);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((line) => REPORT_LINE.test(line))).toBe(true);
    expect(findings.some((line) => line.startsWith('src/Dirty.cs:9: IDE0011 (warning): '))).toBe(true);
    expect(report.lines.at(-1)).toMatch(/^Code Janitor check: 2 file\(s\) checked, 1 would change, \d+ violation\(s\) cleanup cannot fix\.$/);
    expect(report.exitCode).toBe(1);
  });

  it('applies the nearest .codejanitor of each file, walking up from its folder', () => {
    const source = 'namespace Demo;\n\ninternal sealed class Holder\n{\n}\n\n#region Helpers\n\n#endregion Helpers\n';
    fs.mkdirSync(path.join(root, 'kept', 'deeper'), { recursive: true });
    fs.mkdirSync(path.join(root, 'removed'));
    fs.writeFileSync(path.join(root, 'kept', '.codejanitor'), JSON.stringify({ cleanup: { removeRegions: false } }));
    fs.writeFileSync(path.join(root, 'kept', 'deeper', 'Holder.cs'), source);
    fs.writeFileSync(path.join(root, 'removed', 'Holder.cs'), source);

    expect(check('kept').exitCode).toBe(0);
    const removed = check('removed');
    expect(removed.exitCode).toBe(1);
    expect(removed.lines.some((line) => line.startsWith('removed/Holder.cs:7: '))).toBe(true);
  });

  it('skips a file passed explicitly when it is not a .cs file', () => {
    fs.writeFileSync(path.join(root, 'src', 'readme.md'), 'hello  \n');

    const report = check('src/readme.md', 'src/Clean.cs');

    expect(report.lines.at(-1)).toBe('Code Janitor check: 1 file(s) checked, all clean.');
    expect(report.exitCode).toBe(0);
  });

  it('exits with 2 on a usage error', () => {
    expect(runServerCheck(['--root'], root).exitCode).toBe(2);
  });
});
