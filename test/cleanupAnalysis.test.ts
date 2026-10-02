import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyzeCleanup, applyRuleOnly, fixFindingOccurrence } from '../src/cleanup/analysis';
import { createDefaultSettings } from '../src/cleanup/types';

const EDITORCONFIG = [
  'root = true',
  '',
  '[*.cs]',
  'csharp_prefer_braces = true:warning',
  'dotnet_naming_rule.private_fields.symbols = private_fields',
  'dotnet_naming_rule.private_fields.style = underscore',
  'dotnet_naming_rule.private_fields.severity = error',
  'dotnet_naming_symbols.private_fields.applicable_kinds = field',
  'dotnet_naming_symbols.private_fields.applicable_accessibilities = private',
  'dotnet_naming_style.underscore.capitalization = camel_case',
  'dotnet_naming_style.underscore.required_prefix = _',
  'dotnet_naming_rule.public_fields.symbols = public_fields',
  'dotnet_naming_rule.public_fields.style = pascal',
  'dotnet_naming_rule.public_fields.severity = warning',
  'dotnet_naming_symbols.public_fields.applicable_kinds = field',
  'dotnet_naming_symbols.public_fields.applicable_accessibilities = public',
  'dotnet_naming_style.pascal.capitalization = pascal_case',
  '',
].join('\n');

const SOURCE = [
  'namespace Demo;',
  '',
  'internal class Counter',
  '{',
  '    private int count;',
  '',
  '    public int total;',
  '',
  '    public void Add(int value)',
  '    {',
  '        if (value > 0)',
  '            count += value;',
  '',
  '        if (value < 0)',
  '            total -= value;',
  '    }',
  '}',
  '',
].join('\n');

describe('analyzeCleanup', () => {
  let root: string;
  let filePath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codejanitor-analysis-'));
    fs.writeFileSync(path.join(root, '.editorconfig'), EDITORCONFIG);
    filePath = path.join(root, 'Counter.cs');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const editorConfigFindings = () =>
    analyzeCleanup(SOURCE, filePath, createDefaultSettings())
      .findings.filter((finding) => finding.ruleId !== undefined)
      .map(({ ruleId, severity, startLine, endLine, fixable }) => ({ ruleId, severity, startLine, endLine, fixable }));

  it('locates what each enforced rule would change and what it cannot fix, with the .editorconfig severity', () => {
    expect(editorConfigFindings()).toEqual([
      { ruleId: 'IDE0011', severity: 'warning', startLine: 10, endLine: 11, fixable: true },
      { ruleId: 'IDE0011', severity: 'warning', startLine: 13, endLine: 14, fixable: true },
      { ruleId: 'IDE1006', severity: 'error', startLine: 4, endLine: 4, fixable: true },
      { ruleId: 'IDE1006', severity: 'warning', startLine: 6, endLine: 6, fixable: false },
    ]);
  });

  it('points a fixable naming violation at the declared name', () => {
    const naming = analyzeCleanup(SOURCE, filePath, createDefaultSettings()).findings.find(
      (finding) => finding.ruleId === 'IDE1006' && finding.fixable
    );

    expect(naming).toMatchObject({ startCharacter: 16, endCharacter: 21 });
    expect(naming?.message).toContain("'count' should be named '_count'");
  });

  it('applies one rule to the whole file and nothing else', () => {
    const output = applyRuleOnly(SOURCE, filePath, createDefaultSettings(), 'IDE0011');

    expect(output).toContain('        if (value > 0)\n        {\n            count += value;\n        }\n');
    expect(output).toContain('        if (value < 0)\n        {\n            total -= value;\n        }\n');
    expect(output).toContain('private int count;');
  });

  it('fixes one occurrence without touching the other ones', () => {
    const settings = createDefaultSettings();
    const findings = analyzeCleanup(SOURCE, filePath, settings).findings;
    const firstBraces = findings.find((finding) => finding.ruleId === 'IDE0011')!;
    const rename = findings.find((finding) => finding.ruleId === 'IDE1006' && finding.fixable)!;

    const braced = fixFindingOccurrence(SOURCE, filePath, settings, firstBraces);
    const renamed = fixFindingOccurrence(SOURCE, filePath, settings, rename);

    expect(braced).toContain('        if (value > 0)\n        {\n            count += value;\n        }\n');
    expect(braced).toContain('        if (value < 0)\n            total -= value;\n');
    expect(renamed).toContain('private int _count;');
    expect(renamed).toContain('_count += value;');
    expect(renamed).toContain('        if (value > 0)\n            _count += value;\n');
  });

  it('offers no occurrence fix when fixing the occurrence alone would break the code', () => {
    const settings = createDefaultSettings();
    const finding = analyzeCleanup(SOURCE, filePath, settings).findings.find((candidate) => candidate.ruleId === 'IDE0011')!;

    // An occurrence covering only the line of the `if` would add `{` without its `}`.
    expect(fixFindingOccurrence(SOURCE, filePath, settings, { ...finding, startLine: 10, endLine: 10 })).toBeUndefined();
  });

  it('locates an unfixed violation reported without an option qualifier at its line, with its severity', () => {
    fs.writeFileSync(path.join(root, '.editorconfig'), ['root = true', '', '[*.cs]', 'dotnet_diagnostic.IDE0052.severity = warning', ''].join('\n'));
    const source = [
      'namespace Demo;',
      '',
      'internal class A',
      '{',
      '    private int _count;',
      '',
      '    public void Set(int value)',
      '    {',
      '        _count = value;',
      '    }',
      '}',
      '',
    ].join('\n');

    const unused = analyzeCleanup(source, filePath, createDefaultSettings()).findings.filter((finding) => finding.rule.startsWith('IDE0052'));

    expect(unused).toEqual([
      expect.objectContaining({
        ruleId: 'IDE0052',
        rule: 'IDE0052',
        severity: 'warning',
        startLine: 4,
        endLine: 4,
        message: "'_count' is private and assigned but never read.",
        fixable: false,
      }),
    ]);
    expect(unused[0].fileLevel).toBeUndefined();
  });
});
