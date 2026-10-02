import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../src/cleanup/types';
import { compilerErrors, editorConfigVariant, newCompilerErrors, settingsVariant } from '../scripts/compileOracle';

const OUTPUT = [
  '/tmp/copy/Src/A.cs(16,22): error CS0060: Inconsistent accessibility [/tmp/copy/Src/Src.csproj]',
  '/tmp/copy/Src/A.cs(16,22): error CS0060: Inconsistent accessibility [/tmp/copy/Src/Src.csproj]',
  '/tmp/copy/Src/B.cs(3,1): warning CS0168: The variable is declared but never used [/tmp/copy/Src/Src.csproj]',
  '/tmp/copy/Src/B.cs(4,9): error CS0176: Member cannot be accessed with an instance reference [/tmp/copy/Src/Src.csproj]',
  '/tmp/copy/Src/B.cs(5,9): error IDE0055: Fix formatting [/tmp/copy/Src/Src.csproj]',
  'CSC : error CS2001: Source file could not be found [/tmp/copy/Src/Src.csproj]',
].join('\n');

describe('compile oracle helpers', () => {
  it('reads each compiler error once, relative to the copy, ignoring warnings and analyzer diagnostics', () => {
    expect(compilerErrors(OUTPUT, '/tmp/copy')).toEqual([
      { code: 'CS0060', file: 'Src/A.cs', line: 16, message: 'Inconsistent accessibility' },
      { code: 'CS0176', file: 'Src/B.cs', line: 4, message: 'Member cannot be accessed with an instance reference' },
      { code: 'CS2001', file: '', line: 0, message: 'Source file could not be found' },
    ]);
  });

  it('reports only the errors the cleanup added, whatever line they moved to', () => {
    const before = [
      { code: 'CS0060', file: 'A.cs', line: 16, message: 'x' },
      { code: 'CS0103', file: 'B.cs', line: 2, message: 'y' },
    ];
    const after = [
      { code: 'CS0060', file: 'A.cs', line: 12, message: 'x' },
      { code: 'CS0103', file: 'B.cs', line: 2, message: 'y' },
      { code: 'CS0103', file: 'B.cs', line: 9, message: 'y' },
      { code: 'CS0176', file: 'C.cs', line: 1, message: 'z' },
    ];

    expect(newCompilerErrors(before, after)).toEqual([after[2], after[3]]);
  });

  it('turns off every rule of the .editorconfig except the one under test', () => {
    const text = [
      'csharp_style_var_elsewhere = false',
      'dotnet_diagnostic.IDE0008.severity = warning',
      'dotnet_diagnostic.CA1822.severity = warning',
      'dotnet_diagnostic.IDE0010.severity = suggestion',
      'dotnet_naming_rule.locals.severity = warning',
    ].join('\n');

    expect(editorConfigVariant(text, 'ca1822')).toBe(
      [
        'csharp_style_var_elsewhere = false',
        'dotnet_diagnostic.IDE0008.severity = none',
        'dotnet_diagnostic.CA1822.severity = warning',
        'dotnet_diagnostic.IDE0010.severity = none',
        'dotnet_naming_rule.locals.severity = none',
      ].join('\n')
    );
    expect(editorConfigVariant(text, 'IDE1006')).toContain('dotnet_naming_rule.locals.severity = warning');
    expect(editorConfigVariant(text, undefined)).not.toMatch(/= (warning|suggestion)/);
  });

  it('turns off every boolean cleanup setting except the one under test', () => {
    const settings = settingsVariant(createDefaultSettings(), 'sealClassesWhenSafe');

    expect(settings.sealClassesWhenSafe).toBe(true);
    expect(settings.removeRegions).toBe(false);
    expect(Object.entries(settings).filter(([key, value]) => value === true && key !== 'sealClassesWhenSafe')).toEqual([]);
  });
});
