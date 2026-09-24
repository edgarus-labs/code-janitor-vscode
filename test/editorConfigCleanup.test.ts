import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EditorConfigIssue, runCleanup } from '../src/cleanup/runCleanup';
import { createDefaultSettings } from '../src/cleanup/types';

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

  function clean(source: string): { output: string; issues: EditorConfigIssue[] } {
    const issues: EditorConfigIssue[] = [];
    const output = runCleanup(source, filePath, createDefaultSettings(), undefined, (issue) => issues.push(issue));

    return { output, issues };
  }

  it('applies code style and then formatting after the other cleanup steps', () => {
    expect(clean(SOURCE).output).toBe(
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

  it('reports violations it cannot fix, prefixed with the file path', () => {
    expect(clean(SOURCE).issues).toEqual([
      {
        kind: 'unresolved',
        message: `${filePath}: IDE0007 (csharp_style_var_elsewhere) line 7: 'Widget widget' was not changed to 'var': the initializer's type cannot be determined syntactically.`,
      },
    ]);
  });

  it('keeps the byte order mark for charset = utf-8-bom', () => {
    fs.writeFileSync(path.join(root, '.editorconfig'), 'root = true\n\n[*.cs]\ncharset = utf-8-bom\n');

    expect(clean('\uFEFFclass Sample\n{\n}\n').output).toBe('\uFEFFinternal class Sample\n{\n}\n');
  });
});

describe('.editorconfig naming rules and code-style rewrites together', () => {
  it('names the local functions code style creates, so a second cleanup changes nothing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-janitor-naming-order-'));
    try {
      fs.writeFileSync(
        path.join(root, '.editorconfig'),
        [
          'root = true',
          '[*.cs]',
          'csharp_style_prefer_local_over_anonymous_function = true:warning',
          'dotnet_naming_rule.local_functions.severity = warning',
          'dotnet_naming_rule.local_functions.symbols = local_functions',
          'dotnet_naming_rule.local_functions.style = pascal',
          'dotnet_naming_symbols.local_functions.applicable_kinds = local_function',
          'dotnet_naming_style.pascal.capitalization = pascal_case',
        ].join('\n')
      );
      const filePath = path.join(root, 'Sample.cs');
      const source = ['public class C', '{', '    public int M()', '    {', '        Func<int, int> twice = x => x * 2;', '        return twice(2);', '    }', '}', ''].join('\n');

      const once = runCleanup(source, filePath, createDefaultSettings());

      expect(once).toContain('Twice(2)');
      expect(once).not.toMatch(/\btwice\b/);
      expect(runCleanup(once, filePath, createDefaultSettings())).toBe(once);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
