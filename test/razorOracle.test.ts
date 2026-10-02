import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { newCompilerErrors } from '../scripts/compileOracle';
import { formatRazor } from '../src/razor/razorFormatter';
import { RazorFormatOptions } from '../src/razor/razorOptions';
import { dotnetAvailable, formatErrors } from './helpers/dotnetBuild';
import { buildRazorProject, copyProject, projectFiles } from './helpers/razorBuild';

/**
 * The Razor formatter against the real compiler: a Razor class library (Microsoft.NET.Sdk.Razor,
 * framework reference Microsoft.AspNetCore.App) with realistic components and views is built
 * before and after formatting with several option combinations; no new `CSxxxx` / `RZxxxx` error
 * may appear, and formatting again must not change anything.
 */
const ORACLE = path.resolve(__dirname, 'oracle', 'Razor');
const PROJECT = 'RazorOracle.csproj';
const isRazor = (file: string): boolean => /\.(razor|cshtml)$/i.test(file);

const combinations: [string, Partial<RazorFormatOptions>, boolean][] = [
  ['defaults', {}, false],
  ['two spaces', { indentSize: 2, indentStyle: 'space' }, false],
  ['tabs', { indentStyle: 'tab' }, false],
  ['eight spaces', { indentSize: 8, indentStyle: 'space' }, false],
  ['CRLF files', {}, true],
];

const folders: string[] = [];
afterAll(() => folders.forEach((folder) => fs.rmSync(folder, { recursive: true, force: true })));

describe.skipIf(!dotnetAvailable)('formatRazor against the compiler', () => {
  const baselineFolder = copyProject(ORACLE);
  folders.push(baselineFolder);
  const baseline = buildRazorProject(baselineFolder, PROJECT);

  it('builds the unformatted oracle project without errors', () => {
    // A build that fails without a CS/RZ error (restore, SDK, MSBuild) compiles nothing: it must fail the test.
    expect(baseline.ok, baseline.output).toBe(true);
    expect(baseline.errors, formatErrors(baseline)).toEqual([]);
  }, 180_000);

  it.each(combinations)('adds no error and stays idempotent: %s', (_name, options, crlf) => {
    const folder = copyProject(ORACLE);
    folders.push(folder);
    let changed = 0;
    for (const file of projectFiles(folder).filter(isRazor)) {
      const target = path.join(folder, file);
      const original = fs.readFileSync(target, 'utf8');
      const input = crlf ? original.replace(/\r?\n/g, '\r\n') : original;
      const formatted = formatRazor(input, options);
      expect(formatRazor(formatted, options), `${file} is not idempotent`).toBe(formatted);
      if (formatted !== input) {
        changed++;
      }

      fs.writeFileSync(target, formatted);
    }

    expect(changed, 'the formatter changed no file').toBeGreaterThan(4);
    const after = buildRazorProject(folder, PROJECT);
    expect(baseline.ok, baseline.output).toBe(true);
    expect(after.ok, after.output).toBe(true);
    expect(newCompilerErrors(baseline.errors, after.errors), formatErrors(after)).toEqual([]);
  }, 180_000);
});
