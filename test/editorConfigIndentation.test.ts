import { describe, expect, it } from 'vitest';
import { resolveEditorConfigProperties } from '../src/cleanup/editorconfig';
import { createEditorConfigFormattingConverter } from '../src/cleanup/transformations/editorConfigFormatting';

function lines(...text: string[]): string {
  return `${text.join('\n')}\n`;
}

function format(source: string, rules = '', ide0055 = 'warning'): string {
  const props = resolveEditorConfigProperties(
    [{ directory: '/repo', text: `root = true\n\n[*.cs]\ndotnet_diagnostic.IDE0055.severity = ${ide0055}\n${rules}\n` }],
    '/repo/Sample.cs'
  );

  return createEditorConfigFormattingConverter(props, () => undefined).apply(source);
}

const messy = lines(
  'namespace Demo',
  '{',
  '  class C',
  '  {',
  '      void M(int x)',
  '      {',
  '        if (x > 0)',
  '        return;',
  '        else',
  '          {',
  '           Call(x,',
  '                x);',
  '          }',
  '      }',
  '  }',
  '}'
);

describe('editorconfig formatting: indentation', () => {
  it('re-indents from the structure, keeping wrapped lines aligned with their statement', () => {
    expect(format(messy, 'indent_size = 4')).toBe(
      lines(
        'namespace Demo',
        '{',
        '    class C',
        '    {',
        '        void M(int x)',
        '        {',
        '            if (x > 0)',
        '                return;',
        '            else',
        '            {',
        '                Call(x,',
        '                     x);',
        '            }',
        '        }',
        '    }',
        '}'
      )
    );
  });

  it('re-indents to a different indent_size and is idempotent', () => {
    const once = format(messy, 'indent_size = 2');

    expect(once).toBe(
      lines(
        'namespace Demo',
        '{',
        '  class C',
        '  {',
        '    void M(int x)',
        '    {',
        '      if (x > 0)',
        '        return;',
        '      else',
        '      {',
        '        Call(x,',
        '             x);',
        '      }',
        '    }',
        '  }',
        '}'
      )
    );
    expect(format(once, 'indent_size = 2')).toBe(once);
  });

  it('leaves indentation alone while IDE0055 is not enforced', () => {
    expect(format(messy, 'indent_size = 4', 'silent')).toBe(messy);
  });

  it('never touches string literal lines, block comment lines or #if directives', () => {
    const source = lines(
      'class C',
      '{',
      '  string s = @"',
      '  keep",',
      '    t = """',
      '      raw',
      '      """;',
      '  /* comment',
      '     keep */',
      '#if DEBUG',
      '  int x;',
      '#endif',
      '      #region Fields',
      '  // note',
      '  int y;',
      '}'
    );

    expect(format(source)).toBe(
      lines(
        'class C',
        '{',
        '    string s = @"',
        '  keep",',
        '      t = """',
        '      raw',
        '      """;',
        '    /* comment',
        '     keep */',
        '#if DEBUG',
        '    int x;',
        '#endif',
        '    #region Fields',
        '    // note',
        '    int y;',
        '}'
      )
    );
  });

  it('keeps the lines from an #if whose branches each open a brace to the end of the file, and reports them', () => {
    const source = lines(
      'class C',
      '{',
      '    void M()',
      '    {',
      '      Use(0);',
      '#if NET8_0_OR_GREATER',
      '        foreach (var item in Span())',
      '        {',
      '#else',
      '        foreach (var item in Array())',
      '        {',
      '#endif',
      '            Use(item);',
      '        }',
      '    }',
      '',
      '    void Other() { }',
      '}'
    );
    const props = resolveEditorConfigProperties([{ directory: '/repo', text: 'root = true\n\n[*.cs]\ndotnet_diagnostic.IDE0055.severity = warning\n' }], '/repo/Sample.cs');
    const issues: string[] = [];

    const output = createEditorConfigFormattingConverter(props, (issue) => issues.push(issue)).apply(source);

    expect(output).toBe(source.replace('      Use(0);', '        Use(0);'));
    expect(issues).toEqual([expect.stringMatching(/^IDE0055 \(indentation\) line 6: /)]);
  });

  it('still indents the branches of an #if whose branches are each balanced', () => {
    const source = lines('class C', '{', '    void M()', '    {', '#if DEBUG', '      if (A()) { B(); }', '#else', '          C();', '#endif', '      D();', '    }', '}');

    expect(format(source)).toBe(lines('class C', '{', '    void M()', '    {', '#if DEBUG', '        if (A()) { B(); }', '#else', '        C();', '#endif', '        D();', '    }', '}'));
  });

  it('indents switch labels, case contents and case blocks per the csharp_indent_* options', () => {
    const source = lines(
      'class C',
      '{',
      '    void M(int x)',
      '    {',
      '        switch (x)',
      '        {',
      '        case 1:',
      '        A();',
      '        break;',
      '        default:',
      '        {',
      '        B();',
      '        }',
      '        }',
      '    }',
      '}'
    );

    expect(format(source, 'csharp_indent_switch_labels = true\ncsharp_indent_case_contents = true\ncsharp_indent_case_contents_when_block = false')).toBe(
      lines(
        'class C',
        '{',
        '    void M(int x)',
        '    {',
        '        switch (x)',
        '        {',
        '            case 1:',
        '                A();',
        '                break;',
        '            default:',
        '            {',
        '                B();',
        '            }',
        '        }',
        '    }',
        '}'
      )
    );
    expect(format(source, 'csharp_indent_switch_labels = false\ncsharp_indent_case_contents = false\ncsharp_indent_case_contents_when_block = true')).toBe(
      lines(
        'class C',
        '{',
        '    void M(int x)',
        '    {',
        '        switch (x)',
        '        {',
        '        case 1:',
        '        A();',
        '        break;',
        '        default:',
        '            {',
        '                B();',
        '            }',
        '        }',
        '    }',
        '}'
      )
    );
  });

  it('indents braces and block contents per csharp_indent_braces and csharp_indent_block_contents', () => {
    const source = lines('class C', '{', 'void M()', '{', 'A();', '}', '}');

    expect(format(source, 'csharp_indent_braces = true')).toBe(
      lines('class C', '    {', '    void M()', '        {', '        A();', '        }', '    }')
    );
    // As in Roslyn, only statement blocks are affected: type bodies stay indented.
    expect(format(source, 'csharp_indent_block_contents = false')).toBe(lines('class C', '{', '    void M()', '    {', '    A();', '    }', '}'));
  });

  it('places labels per csharp_indent_labels', () => {
    const source = lines('class C', '{', '    void M()', '    {', '        A();', '    retry:', '        B();', '    }', '}');

    expect(format(source, 'csharp_indent_labels = flush_left')).toContain('\nretry:\n');
    expect(format(source, 'csharp_indent_labels = one_less_than_current')).toContain('\n    retry:\n');
    expect(format(source, 'csharp_indent_labels = no_change')).toContain('\n    retry:\n');
  });

  it('indents lambda bodies and object initializers from the line owning their brace, leaving collection initializers as Roslyn does', () => {
    const source = lines(
      'class C',
      '{',
      '    void M()',
      '    {',
      '        items.ForEach(x =>',
      '            {',
      '            Use(x);',
      '            });',
      '        var p = new Point',
      '            {',
      '          X = 1,',
      '          Y = 2,',
      '            };',
      '        var list = new List<int>',
      '            {',
      '          1,',
      '            };',
      '    }',
      '}'
    );

    expect(format(source)).toBe(
      lines(
        'class C',
        '{',
        '    void M()',
        '    {',
        '        items.ForEach(x =>',
        '        {',
        '            Use(x);',
        '        });',
        '        var p = new Point',
        '        {',
        '            X = 1,',
        '            Y = 2,',
        '        };',
        '        var list = new List<int>',
        '            {',
        '          1,',
        '            };',
        '    }',
        '}'
      )
    );
  });

  it('writes tabs when indent_style is tab', () => {
    expect(format(lines('class C', '{', '  int x;', '}'), 'indent_style = tab\nindent_size = 4\ntab_width = 4')).toBe(
      lines('class C', '{', '\tint x;', '}')
    );
  });
});
