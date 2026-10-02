import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveEditorConfigProperties } from '../src/cleanup/editorconfig';
import { diagnosticSeverity, effectiveEditorConfigValue } from '../src/cleanup/editorConfigRegistry';
import { runCleanup } from '../src/cleanup/runCleanup';
import { CleanupSettings, createDefaultSettings } from '../src/cleanup/types';

/**
 * The key table of the Visual Studio "Settings precedence" documentation, checked through the cleanup
 * pipeline: where `.editorconfig` decides a setting, the pipeline follows it in both directions; where it
 * does not enforce the key, the setting applies.
 */

function lines(...text: string[]): string {
  return `${text.join('\n')}\n`;
}

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-janitor-audit-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function clean(source: string, editorConfig: string, settings: Partial<CleanupSettings> = {}): string {
  fs.writeFileSync(path.join(root, '.editorconfig'), `root = true\n\n[*.cs]\n${editorConfig}\n`);

  return runCleanup(source, path.join(root, 'Sample.cs'), { ...createDefaultSettings(), ...settings });
}

const BLANK_LINES = lines('internal class Sample', '{', '    private int a;', '', '', '    private int b;', '}');
const BRACE_BLANK_LINES = lines('internal class Sample', '{', '', '    private int a;', '', '}');

describe('blank lines: the experimental keys allow what the cleanup steps remove', () => {
  it.each([
    ['dotnet_style_allow_multiple_blank_lines_experimental = false:warning', false],
    ['dotnet_style_allow_multiple_blank_lines_experimental = true:warning', true],
    ['dotnet_diagnostic.IDE2000.severity = warning', true],
    ['dotnet_style_allow_multiple_blank_lines_experimental = false:silent', false],
  ])('%s keeps the extra blank line: %s', (option, kept) => {
    const output = clean(BLANK_LINES, option);

    expect(output.includes('private int a;\n\n\n    private int b;')).toBe(kept);
  });

  it.each([
    ['csharp_style_allow_blank_lines_between_consecutive_braces_experimental = false:warning', false],
    ['csharp_style_allow_blank_lines_between_consecutive_braces_experimental = true:warning', true],
    ['dotnet_diagnostic.IDE2002.severity = warning', true],
  ])('%s keeps the blank lines inside the braces: %s', (option, kept) => {
    const output = clean(BRACE_BLANK_LINES, option);

    expect(output.includes('{\n\n    private int a;')).toBe(kept);
    expect(output.includes('private int a;\n\n}')).toBe(kept);
  });
});

describe('the keys of other steps', () => {
  it('simplifies lambdas for when_on_single_line, as true, and leaves them for false', () => {
    const source = lines(
      'using System;',
      '',
      'internal class Sample',
      '{',
      '    private readonly Func<int, int> f = x =>',
      '    {',
      '        return x + 1;',
      '    };',
      '}'
    );

    expect(clean(source, 'csharp_style_expression_bodied_lambdas = when_on_single_line:warning')).not.toContain('return x + 1;');
    expect(clean(source, 'csharp_style_expression_bodied_lambdas = true:warning')).not.toContain('return x + 1;');
    expect(clean(source, 'csharp_style_expression_bodied_lambdas = false:warning')).toContain('return x + 1;');
  });

  it('turns the null check conversion off when an enforced key prefers something else', () => {
    const source = lines('internal class Sample', '{', '    internal bool M(object o)', '    {', '        return o == null;', '    }', '}');

    expect(clean(source, 'dotnet_style_prefer_is_null_check_over_reference_equality_method = true:warning')).toContain('o is null');
    expect(clean(source, 'csharp_style_prefer_null_check_over_type_check = false:warning', { convertToPatternMatchingNullChecks: true })).toContain(
      'return o == null;'
    );
  });

  it('lets a category or global severity enable CA1852, which is bulk-configurable, so the rule decides over the setting', () => {
    const source = lines('internal class Sample', '{', '}');
    fs.writeFileSync(path.join(root, 'Sample.csproj'), '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n');
    fs.writeFileSync(path.join(root, 'Sample.cs'), source);

    expect(clean(source, 'dotnet_analyzer_diagnostic.severity = warning', { sealClassesWhenSafe: false })).toContain('internal sealed class Sample');
    expect(clean(source, 'dotnet_analyzer_diagnostic.category-Performance.severity = warning', { sealClassesWhenSafe: false })).toContain('internal sealed class Sample');
    // Its own severity beats the bulk one: not enforced, so the setting decides.
    expect(clean(source, 'dotnet_analyzer_diagnostic.severity = warning\ndotnet_diagnostic.CA1852.severity = none', { sealClassesWhenSafe: false })).not.toContain('sealed');
  });

  it('does not organize usings when the groups are separated', () => {
    const source = lines('using Zeta;', '', 'using Alpha;', 'using System;', '', 'internal class Sample', '{', '}');

    // Separated groups contradict the organizer (System first, no separation), so the order is left alone.
    expect(clean(source, 'dotnet_separate_import_directive_groups = true:warning', { organizeUsings: true }).startsWith('using Zeta;\n\nusing Alpha;')).toBe(true);
    // A key with the none suffix is ignored, so the setting organizes.
    expect(clean(source, 'dotnet_separate_import_directive_groups = true:none', { organizeUsings: true }).startsWith('using System;')).toBe(true);
  });
});

describe('the none suffix stops a rule', () => {
  const braces = lines('internal class Sample', '{', '    internal int M(bool open)', '    {', '        if (open)', '            return 1;', '        return 0;', '    }', '}');

  it.each([
    'dotnet_diagnostic.IDE0011.severity = warning',
    'dotnet_analyzer_diagnostic.category-Style.severity = warning',
    'dotnet_analyzer_diagnostic.severity = warning',
  ])('whatever severity %s configures elsewhere', (severity) => {
    expect(clean(braces, `csharp_prefer_braces = true:none\n${severity}`)).toBe(braces);
    expect(clean(braces, `csharp_prefer_braces = true:warning\n${severity}`)).toContain('if (open)\n        {');
  });

  it('is an unenforced value of the registry, and a not enforced severity of the diagnostic', () => {
    const props = resolveEditorConfigProperties(
      [{ directory: root, text: 'root = true\n[*.cs]\ncsharp_prefer_braces = true:none\ndotnet_diagnostic.IDE0011.severity = warning\n' }],
      path.join(root, 'Sample.cs')
    );

    expect(effectiveEditorConfigValue(props, 'csharp_prefer_braces')).toBeUndefined();
    expect(diagnosticSeverity(props, 'IDE0011')).toBe('none');
  });
});

describe('plain options take a severity suffix', () => {
  const read = (text: string, key: string): string | undefined =>
    effectiveEditorConfigValue(resolveEditorConfigProperties([{ directory: root, text: `root = true\n[*.cs]\n${text}\n` }], path.join(root, 'Sample.cs')), key);

  it.each([
    ['indent_style = tab:warning', 'indent_style', 'tab'],
    ['indent_style = tab:suggestion', 'indent_style', 'tab'],
    ['indent_style = tab:none', 'indent_style', undefined],
    ['indent_style = tab:silent', 'indent_style', undefined],
    ['indent_style = tab:loud', 'indent_style', undefined],
    ['trim_trailing_whitespace = false : Warning', 'trim_trailing_whitespace', 'false'],
    ['trim_trailing_whitespace = false:none', 'trim_trailing_whitespace', undefined],
    ['dotnet_sort_system_directives_first = true:none', 'dotnet_sort_system_directives_first', undefined],
    ['dotnet_sort_system_directives_first = true:error', 'dotnet_sort_system_directives_first', 'true'],
  ])('%s is read as %s', (text, key, expected) => {
    expect(read(text, key)).toBe(expected);
  });
});

describe('file_header_template', () => {
  const source = lines('internal class Sample', '{', '}');

  it('defines the header whatever the severity of IDE0073, from the template lines', () => {
    const output = clean(source, 'file_header_template = Copyright (c) Contoso\\n\\nLicensed under MIT.');

    expect(output.startsWith('// Copyright (c) Contoso\n//\n// Licensed under MIT.\n')).toBe(true);
  });

  it('replaces the user and repository header with no header for unset', () => {
    expect(clean(source, 'file_header_template = unset', { fileHeaderCSharp: '// User header' })).toBe(source);
    expect(clean(source, 'file_header_template =', { fileHeaderCSharp: '// User header' })).toBe(source);
  });

  it('keeps the user header without a template', () => {
    expect(clean(source, 'trim_trailing_whitespace = true', { fileHeaderCSharp: '// User header' }).startsWith('// User header\n')).toBe(true);
  });
});

describe('the effective severity follows Roslyn precedence (CodeStyleSeverityPrecedenceTests)', () => {
  it.each([
    ['csharp_prefer_braces = true:warning\ndotnet_diagnostic.IDE0011.severity = none', 'none', 'diagnostic none beats the suffix'],
    ['csharp_prefer_braces = true:silent\ndotnet_diagnostic.IDE0011.severity = warning', 'warning', 'diagnostic warning beats a silent suffix'],
    ['csharp_prefer_braces = true:silent\ndotnet_analyzer_diagnostic.category-Style.severity = warning', 'warning', 'category warning beats a silent suffix'],
    ['csharp_prefer_braces = true:warning\ndotnet_analyzer_diagnostic.category-Style.severity = none', 'none', 'category none beats a warning suffix'],
    ['csharp_prefer_braces = true:silent\ndotnet_analyzer_diagnostic.severity = warning', 'warning', 'global warning beats a silent suffix'],
    ['csharp_prefer_braces = true\ndotnet_analyzer_diagnostic.category-Style.severity = warning', 'warning', 'category warning applies to an option without suffix'],
    ['csharp_prefer_braces = true\ndotnet_analyzer_diagnostic.category-Style.severity = none', 'none', 'category none silences an option without suffix'],
    ['dotnet_analyzer_diagnostic.category-style.severity = warning', 'warning', 'category key is case-insensitive'],
    ['dotnet_analyzer_diagnostic.category-Style.severity = suggestion\ndotnet_analyzer_diagnostic.severity = none', 'suggestion', 'category beats the global severity'],
    ['csharp_prefer_braces = true:none\ndotnet_diagnostic.IDE0011.severity = warning', 'none', 'none suffix beats a diagnostic warning'],
    ['csharp_prefer_braces = true:none\ndotnet_analyzer_diagnostic.category-Style.severity = warning', 'none', 'none suffix beats a category warning'],
    ['csharp_prefer_braces = true:none\ndotnet_analyzer_diagnostic.severity = warning', 'none', 'none suffix beats the global warning'],
  ])('%s -> %s (%s)', (text, expected) => {
    const props = resolveEditorConfigProperties([{ directory: root, text: `root = true\n[*.cs]\n${text}\n` }], path.join(root, 'Sample.cs'));

    expect(diagnosticSeverity(props, 'IDE0011')).toBe(expected);
  });
});
