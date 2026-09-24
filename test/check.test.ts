import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkPaths } from '../src/cli/check';

const EDITORCONFIG = ['root = true', '', '[*.cs]', 'csharp_prefer_braces = true:warning', 'dotnet_naming_rule.public_fields.symbols = public_fields', 'dotnet_naming_rule.public_fields.style = pascal', 'dotnet_naming_rule.public_fields.severity = error', 'dotnet_naming_symbols.public_fields.applicable_kinds = field', 'dotnet_naming_symbols.public_fields.applicable_accessibilities = public', 'dotnet_naming_style.pascal.capitalization = pascal_case', ''].join('\n');

const CLEAN = 'namespace Demo;\n\ninternal class Clean\n{\n    public int Total;\n}\n';

describe('checkPaths (code-janitor check)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codejanitor-check-'));
    fs.writeFileSync(path.join(root, '.editorconfig'), EDITORCONFIG);
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'src', 'obj'));
    fs.writeFileSync(path.join(root, 'src', 'Clean.cs'), CLEAN);
    fs.writeFileSync(path.join(root, 'src', 'obj', 'Generated.cs'), 'internal class Generated { void M(bool b) { if (b) M(b); } }\n');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('passes when no file would change and no enforced rule is violated', async () => {
    const report = await checkPaths([path.join(root, 'src')], root);

    expect(report.lines).toEqual(['Code Janitor check: 1 file(s) checked, all clean.']);
    expect(report.exitCode).toBe(0);
  });

  it('fails and lists file:line: rule for each change cleanup would make and each violation it cannot fix', async () => {
    fs.writeFileSync(
      path.join(root, 'src', 'Dirty.cs'),
      'namespace Demo;\n\ninternal class Dirty\n{\n    public int total;\n\n    public void Add(int value)\n    {\n        if (value > 0)\n            total += value;\n    }\n}\n'
    );

    const report = await checkPaths([path.join(root, 'src')], root);

    expect(report.lines).toEqual([
      'src/Dirty.cs:9: IDE0011 (warning): Code Janitor would change this to: {',
      "src/Dirty.cs:5: IDE1006 (error): field 'total' should be named 'Total'; not renamed because it is not private and may be referenced from other files.",
      'Code Janitor check: 2 file(s) checked, 1 would change, 1 violation(s) cleanup cannot fix.',
    ]);
    expect(report.exitCode).toBe(1);
  });
});
