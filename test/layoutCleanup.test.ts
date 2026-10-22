import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runLayoutCleanup } from '../src/cleanup/layoutCleanup';
import { CleanupSettings, createDefaultSettings } from '../src/cleanup/types';

const folders: string[] = [];

/** A file path in a fresh folder whose `.editorconfig` holds `properties` for every file. */
function fileWithEditorConfig(name: string, properties: string): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-layout-'));
  folders.push(folder);
  fs.writeFileSync(path.join(folder, '.editorconfig'), `root = true\n[*]\n${properties}\n`);

  return path.join(folder, name);
}

function settings(overrides: Partial<CleanupSettings> = {}): CleanupSettings {
  return { ...createDefaultSettings(), ...overrides };
}

afterEach(() => {
  folders.splice(0).forEach((folder) => fs.rmSync(folder, { recursive: true, force: true }));
});

describe('runLayoutCleanup', () => {
  it('trims trailing whitespace and normalizes blank lines in any language', () => {
    expect(runLayoutCleanup('const a = 1;   \n\n\n\nconst b = 2;\n', 'sample.ts', settings())).toBe('const a = 1;\n\nconst b = 2;\n');
  });

  it('removes a BOM and adds the final newline', () => {
    expect(runLayoutCleanup('\uFEFFbody { }', 'sample.css', settings())).toBe('body { }\n');
  });

  it('trims the trailing whitespace of a heading', () => {
    expect(runLayoutCleanup('# heading   \n', 'notes.md', settings())).toBe('# heading\n');
  });

  it('handles an empty source', () => {
    expect(runLayoutCleanup('', 'sample.ts', settings())).toBe('');
  });

  it('removes the blank lines at the top and at the bottom', () => {
    expect(runLayoutCleanup('\n\nfirst\nsecond\n\n\n', 'notes.txt', settings({ removeBlankLinesAtTop: true, removeBlankLinesAtBottom: true }))).toBe(
      'first\nsecond\n'
    );
  });

  it('reads the text as plain text: quotes and comment markers protect nothing', () => {
    expect(runLayoutCleanup('mail me@"home\n\n\n\nbye\n', 'notes.txt', settings())).toBe('mail me@"home\n\nbye\n');
    expect(runLayoutCleanup('see src/**/*.ts   \nnext   \n', 'notes.md', settings())).toBe('see src/**/*.ts\nnext\n');
  });

  it('converts the tabs of any text to spaces under indent_style = space', () => {
    const file = fileWithEditorConfig('notes.md', 'indent_style = space\nindent_size = 2');

    expect(runLayoutCleanup('Globs: src/*.ts\n\tindented\n', file, settings())).toBe('Globs: src/*.ts\n  indented\n');
  });

  it('converts only the leading indentation to spaces under indent_style = space, aligned to the tab stops', () => {
    const file = fileWithEditorConfig('data.tsv', 'indent_style = space\nindent_size = 2');

    expect(runLayoutCleanup('a\tb\tc\n\tindented\t# kept\n  \tmixed\n', file, settings())).toBe('a\tb\tc\n  indented\t# kept\n    mixed\n');
  });

  it('leaves the blank lines at the bottom while removeBlankLinesAtBottom is off, adding only a missing final newline', () => {
    const keep = settings({ removeBlankLinesAtBottom: false, removeMultipleConsecutiveBlankLines: false });

    expect(runLayoutCleanup('a\n\n\n', 'notes.txt', keep)).toBe('a\n\n\n');
    expect(runLayoutCleanup('a\r\n\r\n', 'notes.txt', keep)).toBe('a\r\n\r\n');
    expect(runLayoutCleanup('a', 'notes.txt', keep)).toBe('a\n');
    expect(runLayoutCleanup('a\n\n\n', 'notes.txt', settings({ removeBlankLinesAtBottom: true }))).toBe('a\n');
  });

  it('keeps the trailing whitespace under trim_trailing_whitespace = false', () => {
    const file = fileWithEditorConfig('notes.txt', 'trim_trailing_whitespace = false');

    expect(runLayoutCleanup('a  \nb\n', file, settings())).toBe('a  \nb\n');
  });

  it('removes the final newline under insert_final_newline = false', () => {
    const file = fileWithEditorConfig('notes.txt', 'insert_final_newline = false');

    expect(runLayoutCleanup('a\nb\n\n', file, settings({ removeBlankLinesAtBottom: true }))).toBe('a\nb');
  });

  it('follows charset over the removeByteOrderMark setting', () => {
    expect(runLayoutCleanup('\uFEFFa\n', fileWithEditorConfig('a.txt', 'charset = utf-8-bom'), settings())).toBe('\uFEFFa\n');
    expect(runLayoutCleanup('\uFEFFa\n', fileWithEditorConfig('b.txt', 'charset = utf-8'), settings({ removeByteOrderMark: false }))).toBe('a\n');
  });

  it('ignores a value it does not know', () => {
    const file = fileWithEditorConfig('notes.txt', 'trim_trailing_whitespace = maybe\nindent_style = sideways');

    expect(runLayoutCleanup('\ta  \n', file, settings())).toBe('\ta\n');
  });
});
