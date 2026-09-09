import { describe, expect, it } from 'vitest';
import { applyText, loadCSharpOptions } from '../src/cleanup/editorconfig';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('applyText', () => {
  it('does nothing for empty or whitespace text', () => {
    const options = {};
    applyText('', '/a.cs', options);
    applyText('  \n  ', '/a.cs', options);

    expect(options).toEqual({});
  });

  it('does nothing for empty filePath', () => {
    const options = {};
    applyText('indent_style = space', '', options);

    expect(options).toEqual({});
  });

  it('applies trim_trailing_whitespace = true', () => {
    const options = {};
    applyText('trim_trailing_whitespace = true', '/a.cs', options);

    expect(options).toEqual({ trimTrailingWhitespace: true });
  });

  it('applies trim_trailing_whitespace = false', () => {
    const options = {};
    applyText('trim_trailing_whitespace = false', '/a.cs', options);

    expect(options).toEqual({ trimTrailingWhitespace: false });
  });

  it('applies insert_final_newline', () => {
    const options = {};
    applyText('insert_final_newline = true', '/a.cs', options);

    expect(options).toEqual({ insertFinalNewline: true });
  });

  it('applies dotnet_sort_system_directives_first', () => {
    const options = {};
    applyText('dotnet_sort_system_directives_first = true', '/a.cs', options);

    expect(options).toEqual({ sortSystemDirectivesFirst: true });
  });

  it('applies dotnet_separate_import_directive_groups', () => {
    const options = {};
    applyText('dotnet_separate_import_directive_groups = true', '/a.cs', options);

    expect(options).toEqual({ separateImportDirectiveGroups: true });
  });

  it('applies indent_style', () => {
    const options = {};
    applyText('indent_style = space', '/a.cs', options);

    expect(options).toEqual({ indentStyle: 'space' });
  });

  it('applies indent_size as number', () => {
    const options = {};
    applyText('indent_size = 4', '/a.cs', options);

    expect(options).toEqual({ indentSize: 4 });
  });

  it('applies tab_width as number', () => {
    const options = {};
    applyText('tab_width = 8', '/a.cs', options);

    expect(options).toEqual({ tabWidth: 8 });
  });

  it('ignores invalid indent_size', () => {
    const options = {};
    applyText('indent_size = notanumber', '/a.cs', options);

    expect(options).toEqual({});
  });

  it('ignores invalid booleans', () => {
    const options = {};
    applyText('trim_trailing_whitespace = maybe', '/a.cs', options);

    expect(options).toEqual({});
  });

  it('skips comment lines', () => {
    const options = {};
    applyText('; comment\n# also comment\ntrim_trailing_whitespace = true', '/a.cs', options);

    expect(options).toEqual({ trimTrailingWhitespace: true });
  });

  it('skips lines without =', () => {
    const options = {};
    applyText('noequalsign\ntrim_trailing_whitespace = true', '/a.cs', options);

    expect(options).toEqual({ trimTrailingWhitespace: true });
  });

  it('skips lines with empty key', () => {
    const options = {};
    applyText('= novalue', '/a.cs', options);

    expect(options).toEqual({});
  });

  it('applies only C# sections', () => {
    const options = {};
    applyText('[*.md]\nindent_style = tab\n[*.cs]\nindent_style = space', '/a.cs', options);

    expect(options.indentStyle).toBe('space');
  });

  it('matches the universal section [*]', () => {
    const options = {};
    applyText('[*]\nindent_style = tab', '/a.cs', options);

    expect(options.indentStyle).toBe('tab');
  });

  it('skips sections that do not mention cs', () => {
    const options = {};
    applyText('[*.py]\nindent_style = tab\n[*.cs]\nindent_style = space', '/a.cs', options);

    expect(options.indentStyle).toBe('space');
  });

  it('skips sections when file is not .cs', () => {
    const options = {};
    applyText('[*.cs]\nindent_style = space', '/a.py', options);

    expect(options).toEqual({});
  });

  it('handles multiple key=value pairs', () => {
    const options = {};
    applyText('indent_style = space\nindent_size = 2\ntrim_trailing_whitespace = true', '/a.cs', options);

    expect(options.indentStyle).toBe('space');
    expect(options.indentSize).toBe(2);
    expect(options.trimTrailingWhitespace).toBe(true);
  });

  it('later sections override earlier ones', () => {
    const options = {};
    applyText('[*]\nindent_style = tab\n[*.cs]\nindent_style = space', '/a.cs', options);

    expect(options.indentStyle).toBe('space');
  });

  it('handles whitespace around keys and values', () => {
    const options = {};
    applyText('  indent_style   =   space  ', '/a.cs', options);

    expect(options.indentStyle).toBe('space');
  });

  it('handles unknown keys gracefully', () => {
    const options = {};
    applyText('unknown_key = somevalue\nindent_style = space', '/a.cs', options);

    expect(options.indentStyle).toBe('space');
    expect(Object.keys(options)).toHaveLength(1);
  });

  it('handles sections with spaces in them', () => {
    const options = {};
    applyText('[* .cs]\nindent_style = space', '/a.cs', options);

    expect(options.indentStyle).toBe('space');
  });
});

describe('loadCSharpOptions', () => {
  it('returns empty for empty path', () => {
    expect(loadCSharpOptions('')).toEqual({});
    expect(loadCSharpOptions('  ')).toEqual({});
  });

  it('reads a real .editorconfig file from a temp directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-editorconfig-'));
    try {
      const csFile = path.join(root, 'Test.cs');
      fs.writeFileSync(path.join(root, '.editorconfig'), 'root = true\n\n[*]\nindent_style = space\n');
      fs.writeFileSync(csFile, 'class C {}\n');

      const options = loadCSharpOptions(csFile);

      expect(options.indentStyle).toBe('space');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('stops walking up at root = true', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-root-'));
    try {
      const sub = path.join(root, 'Sub');
      fs.mkdirSync(sub, { recursive: true });
      const csFile = path.join(sub, 'Test.cs');

      fs.writeFileSync(path.join(root, '.editorconfig'), 'root = true\nindent_style = tab\n');
      fs.writeFileSync(path.join(sub, '.editorconfig'), 'indent_style = space\n');
      fs.writeFileSync(csFile, 'class C {}\n');

      const options = loadCSharpOptions(csFile);

      // Closer file wins (Sub wins over root).
      expect(options.indentStyle).toBe('space');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns empty when no .editorconfig exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-none-'));
    try {
      const csFile = path.join(root, 'Test.cs');
      fs.writeFileSync(csFile, 'class C {}\n');

      expect(loadCSharpOptions(csFile)).toEqual({});
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('handles unreadable .editorconfig gracefully', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-unreadable-'));
    try {
      const csFile = path.join(root, 'Test.cs');
      fs.writeFileSync(path.join(root, '.editorconfig'), '');
      fs.writeFileSync(csFile, 'class C {}\n');

      // Should not throw.
      const options = loadCSharpOptions(csFile);

      expect(options).toEqual({});
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
