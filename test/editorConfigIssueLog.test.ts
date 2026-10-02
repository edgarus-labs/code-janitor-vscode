import { describe, expect, it } from 'vitest';
import { resolveEditorConfigProperties } from '../src/cleanup/editorconfig';
import { EditorConfigIssueLog, editorConfigSignature } from '../src/cleanup/editorConfigIssueLog';

const unsupported = (filePath: string, detail: string) => ({ kind: 'unsupported' as const, filePath, detail });
const unresolved = (filePath: string, detail: string) => ({ kind: 'unresolved' as const, filePath, detail });
const note = (filePath: string, detail: string) => ({ kind: 'note' as const, filePath, detail });

describe('EditorConfigIssueLog', () => {
  it('logs violations and notes per file right away, counted apart, and each unsupported setting once, with the files it affects', () => {
    const lines: string[] = [];
    const log = new EditorConfigIssueLog((line) => lines.push(line));

    log.report(unsupported('/r/A.cs', '"max_line_length = 120" is not supported and was not applied.'));
    log.report(unresolved('/r/A.cs', 'IDE0011 line 3: braces not added.'));
    log.report(note('/r/A.cs', 'Line 1: namespace not converted to a file-scoped one.'));
    log.report(unsupported('/r/B.cs', '"max_line_length = 120" is not supported and was not applied.'));
    log.report(unsupported('/r/B.cs', '"csharp_prefer_static_anonymous_function = true" is not supported and was not applied.'));
    expect(lines).toEqual([
      '.editorconfig rule not fixed: /r/A.cs: IDE0011 line 3: braces not added.',
      'Cleanup note: /r/A.cs: Line 1: namespace not converted to a file-scoped one.',
    ]);

    expect(log.finish()).toEqual({ unresolved: 1, notes: 1, unsupported: 2 });
    expect(lines.slice(2)).toEqual([
      '.editorconfig setting not supported: "max_line_length = 120" is not supported and was not applied. (2 files)',
      '.editorconfig setting not supported: "csharp_prefer_static_anonymous_function = true" is not supported and was not applied. (1 file)',
    ]);
  });

  it('reports the unsupported settings of a configuration once per session when asked to', () => {
    const lines: string[] = [];
    const seen = new Set<string>();
    const signatureOf = (filePath: string) => (filePath.startsWith('/a/') ? 'config a' : 'config b');
    const run = (filePath: string) => {
      const log = new EditorConfigIssueLog((line) => lines.push(line), { seen, signatureOf });
      log.report(unsupported(filePath, '"max_line_length = 120" is not supported and was not applied.'));

      return log.finish();
    };

    expect(run('/a/A.cs')).toEqual({ unresolved: 0, notes: 0, unsupported: 1 });
    expect(run('/a/B.cs')).toEqual({ unresolved: 0, notes: 0, unsupported: 0 });
    expect(run('/b/C.cs')).toEqual({ unresolved: 0, notes: 0, unsupported: 1 });
    expect(lines).toHaveLength(2);
  });
});

describe('editorConfigSignature', () => {
  it('is the same for the same resolved properties, whatever the file', () => {
    const files = [{ directory: '/r', text: 'root = true\n[*.cs]\nmax_line_length = 120\nindent_size = 4\n' }];

    expect(editorConfigSignature(resolveEditorConfigProperties(files, '/r/A.cs'))).toBe(
      editorConfigSignature(resolveEditorConfigProperties(files, '/r/sub/B.cs'))
    );
    expect(editorConfigSignature(resolveEditorConfigProperties(files, '/r/A.cs'))).not.toBe(
      editorConfigSignature(resolveEditorConfigProperties([{ directory: '/r', text: 'root = true\n[*.cs]\nindent_size = 2\n' }], '/r/A.cs'))
    );
  });
});
