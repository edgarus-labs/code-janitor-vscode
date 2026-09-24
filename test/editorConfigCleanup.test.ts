import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCleanup } from '../src/cleanup/runCleanup';
import { CleanupSettings, createDefaultSettings } from '../src/cleanup/types';

const EDITORCONFIG = [
  'root = true',
  '',
  '[*.cs]',
  'indent_style = tab',
  'end_of_line = crlf',
  'csharp_style_namespace_declarations = file_scoped:warning',
  'csharp_prefer_braces = true:warning',
  'csharp_style_var_elsewhere = true:suggestion',
  'dotnet_diagnostic.IDE0055.severity = warning',
  'csharp_new_line_before_open_brace = none',
].join('\n');

const SOURCE = [
  'namespace Demo',
  '{',
  '    public class Sample',
  '    {',
  '        public void Run(int x)',
  '        {',
  '            Widget widget = Create();',
  '            if (x > 0) return;',
  '        }',
  '    }',
  '}',
  '',
].join('\n');

describe('.editorconfig categories in the cleanup pipeline', () => {
  let root: string;
  let filePath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-janitor-editorconfig-'));
    fs.writeFileSync(path.join(root, '.editorconfig'), EDITORCONFIG);
    fs.mkdirSync(path.join(root, 'src'));
    filePath = path.join(root, 'src', 'Sample.cs');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function clean(source: string, overrides: Partial<CleanupSettings>): { output: string; issues: string[] } {
    const issues: string[] = [];
    const output = runCleanup(source, filePath, { ...createDefaultSettings(), ...overrides }, undefined, (issue) =>
      issues.push(issue)
    );

    return { output, issues };
  }

  it('leaves .editorconfig rules alone while both categories are off', () => {
    const { output, issues } = clean(SOURCE, {});

    expect(output).toBe(SOURCE);
    expect(issues).toEqual([]);
  });

  it('applies code style and then formatting after the other cleanup steps', () => {
    const { output } = clean(SOURCE, { applyEditorConfigCodeStyle: true, applyEditorConfigFormatting: true });

    expect(output).toBe(
      [
        'namespace Demo;',
        '',
        'public class Sample {',
        '\tpublic void Run(int x) {',
        '\t\tWidget widget = Create();',
        '\t\tif (x > 0) {',
        '\t\t\treturn;',
        '\t\t}',
        '\t}',
        '}',
        '',
      ].join('\r\n')
    );
  });

  it('applies only the enabled category', () => {
    const { output } = clean(SOURCE, { applyEditorConfigFormatting: true });

    expect(output).toBe(
      ['namespace Demo {', '\tpublic class Sample {', '\t\tpublic void Run(int x) {', '\t\t\tWidget widget = Create();', '\t\t\tif (x > 0) return;', '\t\t}', '\t}', '}', ''].join('\r\n')
    );
  });

  it('reports violations it cannot fix, prefixed with the file path', () => {
    const { issues } = clean(SOURCE, { applyEditorConfigCodeStyle: true });

    expect(issues).toEqual([`${filePath}: IDE0007 (csharp_style_var_elsewhere) line 7: 'Widget widget' was not changed to 'var': the initializer's type cannot be determined syntactically.`]);
  });

  it('keeps the byte order mark when charset = utf-8-bom', () => {
    fs.writeFileSync(path.join(root, '.editorconfig'), 'root = true\n\n[*.cs]\ncharset = utf-8-bom\n');
    const source = '\uFEFFclass Sample\n{\n}\n';

    expect(clean(source, { applyEditorConfigFormatting: true }).output).toBe('\uFEFFinternal class Sample\n{\n}\n');
    expect(clean(source, {}).output).toBe('internal class Sample\n{\n}\n');
  });
});
