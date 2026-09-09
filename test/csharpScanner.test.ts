import { describe, expect, it } from 'vitest';
import { CODE, COMMENT, STRING, classifyCSharp } from '../src/cleanup/csharpScanner';

describe('classifyCSharp', () => {
  it('classifies plain code as CODE', () => {
    const kinds = classifyCSharp('class C {}');

    for (let i = 0; i < 'class C {}'.length; i++) {
      expect(kinds[i]).toBe(CODE);
    }
  });

  it('classifies line comments', () => {
    const kinds = classifyCSharp('int x; // comment\nint y;');

    // 'int x; ' is CODE
    expect(kinds[0]).toBe(CODE);
    // '// comment' is COMMENT
    expect(kinds[8]).toBe(COMMENT);
    // '\nint y;' - after the comment
    expect(kinds['int x; // comment'.length]).toBe(CODE);
  });

  it('classifies block comments', () => {
    const kinds = classifyCSharp('int x; /* comment */ int y;');

    expect(kinds[8]).toBe(COMMENT);
    expect(kinds[20]).toBe(CODE); // after */
  });

  it('handles unclosed block comment', () => {
    const kinds = classifyCSharp('int x; /* unclosed');

    expect(kinds[8]).toBe(COMMENT);
  });

  it('classifies char literals', () => {
    const kinds = classifyCSharp("char c = 'a';");

    expect(kinds[10]).toBe(STRING);
  });

  it('handles escaped char', () => {
    const kinds = classifyCSharp("char c = '\\'';");

    expect(kinds[10]).toBe(STRING);
  });

  it('handles unclosed char literal at end', () => {
    const kinds = classifyCSharp("char c = 'a");

    expect(kinds[10]).toBe(STRING);
  });

  it('handles char literal with newline', () => {
    const kinds = classifyCSharp("char c = 'a\nint y;");

    // The 'a\n part is STRING, then int y; is CODE
    expect(kinds[10]).toBe(STRING);
  });

  it('classifies string literals', () => {
    const kinds = classifyCSharp('string s = "hello";');

    expect(kinds[12]).toBe(STRING);
  });

  it('handles escaped quotes in strings', () => {
    const kinds = classifyCSharp('string s = "say \\"hi\\"";');

    expect(kinds[12]).toBe(STRING);
  });

  it('handles empty string', () => {
    const kinds = classifyCSharp('string s = "";');

    expect(kinds[12]).toBe(STRING);
  });

  it('classifies interpolated strings', () => {
    const kinds = classifyCSharp('string s = $"value: {x}";');

    expect(kinds[12]).toBe(STRING);
  });

  it('handles interpolated string with nested braces', () => {
    const kinds = classifyCSharp('string s = $"{{x}}";');

    expect(kinds[12]).toBe(STRING);
  });

  it('handles interpolated string with single braces', () => {
    const kinds = classifyCSharp('string s = $"{x}";');

    expect(kinds[12]).toBe(STRING);
  });

  it('handles interpolated string ending at brace', () => {
    const kinds = classifyCSharp('string s = $"{x}";');

    // Everything up to closing quote is STRING
    expect(kinds[12]).toBe(STRING);
  });

  it('handles verbatim strings', () => {
    const kinds = classifyCSharp('string s = @"hello";');

    expect(kinds[12]).toBe(STRING);
  });

  it('handles verbatim strings with doubled quotes', () => {
    const kinds = classifyCSharp('string s = @"say ""hi""";');

    expect(kinds[12]).toBe(STRING);
  });

  it('handles unclosed verbatim string', () => {
    const kinds = classifyCSharp('string s = @"unclosed');

    expect(kinds[12]).toBe(STRING);
  });

  it('handles raw string literals', () => {
    const kinds = classifyCSharp('string s = """raw""";');

    expect(kinds[12]).toBe(STRING);
  });

  it('handles raw string with more quotes', () => {
    const kinds = classifyCSharp('string s = """"extra"""";');

    expect(kinds[12]).toBe(STRING);
  });

  it('handles unclosed raw string', () => {
    const kinds = classifyCSharp('string s = """unclosed');

    expect(kinds[12]).toBe(STRING);
  });

  it('handles interpolated verbatim strings', () => {
    const kinds = classifyCSharp('string s = $@"path {x}";');

    expect(kinds[12]).toBe(STRING);
  });

  it('handles multiple dollar signs', () => {
    const kinds = classifyCSharp('string s = $$"{{x}}";');

    expect(kinds[12]).toBe(STRING);
  });

  it('returns CODE for bare @ without quote', () => {
    const kinds = classifyCSharp('@identifier');

    expect(kinds[0]).toBe(CODE);
  });

  it('returns CODE for $ without quote', () => {
    const kinds = classifyCSharp('$variable');

    expect(kinds[0]).toBe(CODE);
  });

  it('handles string ending with newline', () => {
    const kinds = classifyCSharp('string s = "line\nnext";');

    // The "line\n part is STRING, then next" is CODE
    expect(kinds[12]).toBe(STRING);
  });

  it('handles comment at end of file', () => {
    const kinds = classifyCSharp('int x; //');

    expect(kinds[7]).toBe(COMMENT);
  });

  it('handles comment without newline', () => {
    const kinds = classifyCSharp('//');

    expect(kinds[0]).toBe(COMMENT);
  });

  it('handles block comment at end', () => {
    const kinds = classifyCSharp('/**/');

    expect(kinds[0]).toBe(COMMENT);
  });

  it('handles single char literal', () => {
    const kinds = classifyCSharp("'x'");

    expect(kinds[0]).toBe(STRING);
  });

  it('handles empty source', () => {
    expect(classifyCSharp('')).toEqual(new Uint8Array(0));
  });

  it('handles single character', () => {
    const kinds = classifyCSharp('a');

    expect(kinds[0]).toBe(CODE);
  });

  it('classifies mixed content correctly', () => {
    const source = 'int x; // comment\nstring s = "lit";';
    const kinds = classifyCSharp(source);

    expect(kinds[0]).toBe(CODE); // 'int x;'
    expect(kinds[8]).toBe(COMMENT); // '// comment'
    expect(kinds[20]).toBe(CODE); // 'string s = '
    expect(kinds[29]).toBe(STRING); // '"lit"'
  });
});
