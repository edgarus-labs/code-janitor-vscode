import { describe, expect, it } from 'vitest';
import { resolveEditorConfigProperties } from '../src/cleanup/editorconfig';
import { unsupportedEditorConfigSettings } from '../src/cleanup/editorConfigRegistry';
import { createEditorConfigCodeStyleConverter } from '../src/cleanup/transformations/editorConfigCodeStyle';

function lines(...text: string[]): string {
  return `${text.join('\n')}\n`;
}

function codeStyle(source: string, rules: string): string {
  const props = resolveEditorConfigProperties([{ directory: '/repo', text: `root = true\n[*.cs]\n${rules}\n` }], '/repo/Sample.cs');

  return createEditorConfigCodeStyleConverter(props, () => undefined).apply(source);
}

/** Asserts `option = false` rewrites `before` to `after` while enforced, and changes nothing while silent or `true`. */
function expectRewrite(option: string, before: string, after: string): void {
  expect(codeStyle(before, `${option} = false:warning`)).toBe(after);
  expect(codeStyle(before, `${option} = false:silent`)).toBe(before);
  expect(codeStyle(before, `${option} = true:warning`)).toBe(before);
}

describe('experimental blank-line and wrapping options (IDE2000 - IDE2006)', () => {
  it('are supported, so they are not listed as unsupported', () => {
    const props = resolveEditorConfigProperties(
      [
        {
          directory: '/repo',
          text: 'root = true\n[*.cs]\ndotnet_style_allow_multiple_blank_lines_experimental = false:warning\ncsharp_style_allow_blank_line_after_token_in_arrow_expression_clause_experimental = false:warning\n',
        },
      ],
      '/repo/Sample.cs'
    );

    expect(unsupportedEditorConfigSettings(props)).toEqual([]);
  });

  it('IDE2000 keeps one blank line of several, but never inside a string', () => {
    expectRewrite(
      'dotnet_style_allow_multiple_blank_lines_experimental',
      lines('class C', '{', '    int a;', '', '', '', '    string s = @"x', '', '', 'y";', '}'),
      lines('class C', '{', '    int a;', '', '    string s = @"x', '', '', 'y";', '}')
    );
  });

  it('IDE2001 moves embedded statements to their own line', () => {
    expectRewrite(
      'csharp_style_allow_embedded_statements_on_same_line_experimental',
      lines('class C', '{', '    void M(bool b)', '    {', '        if (b) return;', '        else if (!b) M(b);', '        else return;', '        while (b) b = false;', '        if (b) M(', '            b);', '    }', '}'),
      lines(
        'class C',
        '{',
        '    void M(bool b)',
        '    {',
        '        if (b)',
        '            return;',
        '        else if (!b)',
        '            M(b);',
        '        else',
        '            return;',
        '        while (b)',
        '            b = false;',
        '        if (b) M(',
        '            b);',
        '    }',
        '}'
      )
    );
  });

  it('IDE2002 removes blank lines between consecutive closing braces', () => {
    expectRewrite(
      'csharp_style_allow_blank_lines_between_consecutive_braces_experimental',
      lines('class C', '{', '    void M()', '    {', '    }', '', '}'),
      lines('class C', '{', '    void M()', '    {', '    }', '}')
    );
  });

  it('IDE2003 adds a blank line between a block and the next statement', () => {
    expectRewrite(
      'dotnet_style_allow_statement_immediately_after_block_experimental',
      lines('class C', '{', '    void M(bool b)', '    {', '        if (b)', '        {', '            M(b);', '        }', '        M(b);', '    }', '}'),
      lines('class C', '{', '    void M(bool b)', '    {', '        if (b)', '        {', '            M(b);', '        }', '', '        M(b);', '    }', '}')
    );
  });

  it('IDE2004 - IDE2006 remove blank lines after a constructor initializer colon, a conditional token and an arrow', () => {
    expectRewrite(
      'csharp_style_allow_blank_line_after_colon_in_constructor_initializer_experimental',
      lines('class C : B', '{', '    C() :', '', '        base(1)', '    {', '    }', '}'),
      lines('class C : B', '{', '    C() :', '        base(1)', '    {', '    }', '}')
    );
    expectRewrite(
      'csharp_style_allow_blank_line_after_token_in_conditional_expression_experimental',
      lines('class C', '{', '    int M(bool b) => b ?', '', '        1 :', '', '        2;', '}'),
      lines('class C', '{', '    int M(bool b) => b ?', '        1 :', '        2;', '}')
    );
    expectRewrite(
      'csharp_style_allow_blank_line_after_token_in_arrow_expression_clause_experimental',
      lines('class C', '{', '    int M() =>', '', '        1;', '}'),
      lines('class C', '{', '    int M() =>', '        1;', '}')
    );
  });
});

describe('IDE2000 and multi-line string literals', () => {
  it.each([
    ['verbatim', lines('class C', '{', '    string S = @"a', '', '', '', 'b";', '}')],
    ['raw', lines('class C', '{', '    string S = """', '        a', '', '', '        b', '        """;', '}')],
    ['interpolated verbatim', lines('class C', '{', '    string S(int n) => $@"a', '', '', '{n}', '', '', 'b";', '}')],
  ])('keeps the blank lines of a %s string', (_name, source) => {
    expect(codeStyle(source, 'dotnet_style_allow_multiple_blank_lines_experimental = false:warning')).toBe(source);
  });

  it('still collapses blank lines in code next to a literal', () => {
    expectRewrite(
      'dotnet_style_allow_multiple_blank_lines_experimental',
      lines('class C', '{', '    string S = @"a', '', '', 'b";', '', '', '', '    int N;', '}'),
      lines('class C', '{', '    string S = @"a', '', '', 'b";', '', '    int N;', '}')
    );
  });
});
