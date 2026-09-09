import { describe, expect, it } from 'vitest';
import {
  HeaderPosition,
  HeaderUpdateMode,
} from '../src/cleanup/types';
import {
  applyConfiguredCSharpFileHeader,
  getTopLevelUsingInsertionIndex,
  removeBlankLinesAfterAttributes,
  removeBlankLinesAfterOpeningBrace,
  removeBlankLinesAtBottom,
  removeBlankLinesAtTop,
  removeBlankLinesBeforeClosingBrace,
  removeBlankLinesBetweenChainedStatements,
} from '../src/cleanup/transformations/fileHeaderAndBlankLines';

// ---------------------------------------------------------------- blank-line helpers

describe('removeBlankLinesAtTop', () => {
  it('removes leading blank lines', () => {
    expect(removeBlankLinesAtTop('\n\ninternal class C {}\n')).toBe('internal class C {}\n');
  });

  it('handles CRLF line endings', () => {
    expect(removeBlankLinesAtTop('\r\n\r\nclass C {}\r\n')).toBe('class C {}\r\n');
  });

  it('does nothing when no blank lines at top', () => {
    expect(removeBlankLinesAtTop('class C {}\n')).toBe('class C {}\n');
  });

  it('handles empty string', () => {
    expect(removeBlankLinesAtTop('')).toBe('');
  });
});

describe('removeBlankLinesAtBottom', () => {
  it('removes trailing blank lines', () => {
    expect(removeBlankLinesAtBottom('class C {}\n\n\n')).toBe('class C {}');
  });

  it('handles CRLF', () => {
    expect(removeBlankLinesAtBottom('class C {}\r\n\r\n')).toBe('class C {}');
  });

  it('removes a single trailing newline (treated as blank)', () => {
    expect(removeBlankLinesAtBottom('class C {}\n')).toBe('class C {}');
  });
});

describe('removeBlankLinesAfterAttributes', () => {
  it('collapses blank line after an attribute line', () => {
    const input = '[Obsolete]\n\nvoid M() {}\n';
    const expected = '[Obsolete]\nvoid M() {}\n';

    expect(removeBlankLinesAfterAttributes(input)).toBe(expected);
  });

  it('collapses blank line after attribute when next line is not a comment', () => {
    const input = '[Obsolete] // note\n\nvoid M() {}\n';
    const expected = '[Obsolete] // note\nvoid M() {}\n';

    expect(removeBlankLinesAfterAttributes(input)).toBe(expected);
  });

  it('handles CRLF', () => {
    const input = '[Obsolete]\r\n\r\nvoid M() {}\r\n';

    expect(removeBlankLinesAfterAttributes(input)).toBe('[Obsolete]\r\nvoid M() {}\r\n');
  });
});

describe('removeBlankLinesAfterOpeningBrace', () => {
  it('collapses blank lines after an opening brace', () => {
    const input = 'class C {\n\n\nvoid M() {}\n}\n';
    const expected = 'class C {\nvoid M() {}\n}\n';

    expect(removeBlankLinesAfterOpeningBrace(input)).toBe(expected);
  });

  it('handles CRLF', () => {
    expect(removeBlankLinesAfterOpeningBrace('class C {\r\n\r\nvoid M() {}\r\n}\r\n')).toBe(
      'class C {\r\nvoid M() {}\r\n}\r\n'
    );
  });

  it('does nothing with no blank line after brace', () => {
    const input = 'class C {\nvoid M() {}\n}\n';

    expect(removeBlankLinesAfterOpeningBrace(input)).toBe(input);
  });
});

describe('removeBlankLinesBeforeClosingBrace', () => {
  it('collapses blank lines before a closing brace', () => {
    const input = 'class C {\nvoid M() {}\n\n\n}\n';
    const expected = 'class C {\nvoid M() {}\n}\n';

    expect(removeBlankLinesBeforeClosingBrace(input)).toBe(expected);
  });

  it('handles CRLF', () => {
    expect(removeBlankLinesBeforeClosingBrace('class C {\r\nvoid M() {}\r\n\r\n}\r\n')).toBe(
      'class C {\r\nvoid M() {}\r\n}\r\n'
    );
  });
});

describe('removeBlankLinesBetweenChainedStatements', () => {
  it('collapses blank lines before else', () => {
    const input = 'if (a) {\n}\n\nelse {\n}\n';
    const expected = 'if (a) {\n}\nelse {\n}\n';

    expect(removeBlankLinesBetweenChainedStatements(input)).toBe(expected);
  });

  it('collapses blank lines before catch', () => {
    const input = 'try {\n}\n\ncatch {\n}\n';

    expect(removeBlankLinesBetweenChainedStatements(input)).toBe('try {\n}\ncatch {\n}\n');
  });

  it('collapses blank lines before finally', () => {
    const input = 'try {\n}\n\nfinally {\n}\n';

    expect(removeBlankLinesBetweenChainedStatements(input)).toBe('try {\n}\nfinally {\n}\n');
  });

  it('handles CRLF', () => {
    const input = 'if (a) {\r\n}\r\n\r\nelse {\r\n}\r\n';

    expect(removeBlankLinesBetweenChainedStatements(input)).toBe('if (a) {\r\n}\r\nelse {\r\n}\r\n');
  });
});

// ---------------------------------------------------------------- file header

describe('applyConfiguredCSharpFileHeader', () => {
  it('returns source unchanged when header is empty', () => {
    expect(
      applyConfiguredCSharpFileHeader('class C {}\n', {
        header: '',
        position: HeaderPosition.DocumentStart,
        updateMode: HeaderUpdateMode.Insert,
      })
    ).toBe('class C {}\n');
  });

  it('returns source unchanged when header is whitespace only', () => {
    expect(
      applyConfiguredCSharpFileHeader('class C {}\n', {
        header: '   \n  ',
        position: HeaderPosition.DocumentStart,
        updateMode: HeaderUpdateMode.Insert,
      })
    ).toBe('class C {}\n');
  });

  it('inserts at document start', () => {
    const result = applyConfiguredCSharpFileHeader('class C {}\n', {
      header: '// My Header',
      position: HeaderPosition.DocumentStart,
      updateMode: HeaderUpdateMode.Insert,
    });

    expect(result).toBe('// My Header\nclass C {}\n');
  });

  it('does not duplicate an already matching header at document start', () => {
    const source = '// My Header\nclass C {}\n';
    const result = applyConfiguredCSharpFileHeader(source, {
      header: '// My Header',
      position: HeaderPosition.DocumentStart,
      updateMode: HeaderUpdateMode.Insert,
    });

    expect(result).toBe(source);
  });

  it('replaces a non-matching header at document start', () => {
    const source = '// Old Header\nclass C {}\n';
    const result = applyConfiguredCSharpFileHeader(source, {
      header: '// New Header',
      position: HeaderPosition.DocumentStart,
      updateMode: HeaderUpdateMode.Replace,
    });

    expect(result).toBe('// New Header\nclass C {}\n');
  });

  it('keeps a matching header in replace mode', () => {
    const source = '// My Header\nclass C {}\n';
    const result = applyConfiguredCSharpFileHeader(source, {
      header: '// My Header',
      position: HeaderPosition.DocumentStart,
      updateMode: HeaderUpdateMode.Replace,
    });

    expect(result).toBe(source);
  });

  it('inserts after usings', () => {
    const source = 'using System;\n\nclass C {}\n';
    const result = applyConfiguredCSharpFileHeader(source, {
      header: '// My Header',
      position: HeaderPosition.AfterUsings,
      updateMode: HeaderUpdateMode.Insert,
    });

    expect(result).toContain('using System;\n\n// My Header');
    expect(result).toContain('class C');
  });

  it('does not duplicate an existing header after usings in insert mode', () => {
    const source = 'using System;\n\n// My Header\nclass C {}\n';
    const result = applyConfiguredCSharpFileHeader(source, {
      header: '// My Header',
      position: HeaderPosition.AfterUsings,
      updateMode: HeaderUpdateMode.Insert,
    });

    expect(result).toBe(source);
  });

  it('replaces a non-matching header after usings in replace mode', () => {
    const source = 'using System;\n\n// Old\nclass C {}\n';
    const result = applyConfiguredCSharpFileHeader(source, {
      header: '// New',
      position: HeaderPosition.AfterUsings,
      updateMode: HeaderUpdateMode.Replace,
    });

    expect(result).toContain('// New');
    expect(result).not.toContain('// Old');
  });

  it('keeps a matching header in replace mode after usings', () => {
    const source = 'using System;\n\n// My Header\nclass C {}\n';
    const result = applyConfiguredCSharpFileHeader(source, {
      header: '// My Header',
      position: HeaderPosition.AfterUsings,
      updateMode: HeaderUpdateMode.Replace,
    });

    expect(result).toBe(source);
  });

  it('handles CRLF line endings in the header', () => {
    const result = applyConfiguredCSharpFileHeader('class C {}\r\n', {
      header: '// Header\r\n',
      position: HeaderPosition.DocumentStart,
      updateMode: HeaderUpdateMode.Insert,
    });

    expect(result).toContain('\r\n');
  });

  it('appends a newline to a header missing one', () => {
    const result = applyConfiguredCSharpFileHeader('class C {}\n', {
      header: '// Header',
      position: HeaderPosition.DocumentStart,
      updateMode: HeaderUpdateMode.Insert,
    });

    expect(result).toBe('// Header\nclass C {}\n');
  });
});

describe('getTopLevelUsingInsertionIndex', () => {
  it('returns 0 for a file with no usings', () => {
    expect(getTopLevelUsingInsertionIndex('class C {}\n')).toBe(0);
  });

  it('returns the offset past the last using directive', () => {
    const source = 'using System;\nusing System.Text;\n\nclass C {}\n';
    const idx = getTopLevelUsingInsertionIndex(source);

    expect(source.slice(idx)).toBe('using System.Text;\n\nclass C {}\n');
  });

  it('stops at a using that is not top-level (inside a namespace)', () => {
    const source = 'namespace N {\nusing System;\n}\n';
    const idx = getTopLevelUsingInsertionIndex(source);

    expect(idx).toBe(0);
  });

  it('skips usings in comments', () => {
    const source = '// using System;\nclass C {}\n';
    const idx = getTopLevelUsingInsertionIndex(source);

    expect(idx).toBe(0);
  });

  it('skips usings in strings', () => {
    const source = 'var s = "using System;";\nclass C {}\n';
    const idx = getTopLevelUsingInsertionIndex(source);

    expect(idx).toBe(0);
  });
});
