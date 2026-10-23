import { describe, expect, it } from 'vitest';
import { resolveEditorConfigProperties } from '../src/cleanup/editorconfig';
import { formatCSharp } from '../src/razor/csharp/formatting';

function lines(...text: string[]): string {
  return `${text.join('\n')}\n`;
}

const BASE_RULES = [
  'indent_size = 4',
  'csharp_new_line_before_open_brace = accessors, anonymous_methods, anonymous_types, control_blocks, events, indexers, lambdas, local_functions, methods, object_collection_array_initializers, properties, types',
  'csharp_new_line_before_catch = true',
].join('\n');

function format(source: string, rules: string): string {
  return formatCSharp(
    source,
    resolveEditorConfigProperties([{ directory: '/repo', text: `root = true\n\n[*.cs]\n${BASE_RULES}\n${rules}\n` }], '/repo/Sample.cs')
  );
}

describe('C# formatting: new lines', () => {
  it('expands single-line blocks as Roslyn does when csharp_preserve_single_line_blocks is false', () => {
    const source = lines(
      'class C',
      '{',
      '    int P { get; set; }',
      '    int Q { get; } = 4;',
      '    void E() { }',
      '    void M()',
      '    {',
      '        if (x) { A(); }',
      '        F(() => { A(); });',
      '        try { A(); } catch { }',
      '        var o = new { X = 1 };',
      '    }',
      '}'
    );

    expect(format(source, 'csharp_preserve_single_line_blocks = false')).toBe(
      lines(
        'class C',
        '{',
        '    int P',
        '    {',
        '        get; set;',
        '    }',
        '    int Q { get; } = 4;',
        '    void E()',
        '    {',
        '    }',
        '    void M()',
        '    {',
        '        if (x)',
        '        {',
        '            A();',
        '        }',
        '        F(() => { A(); });',
        '        try',
        '        {',
        '            A();',
        '        }',
        '        catch { }',
        '        var o = new',
        '        {',
        '            X = 1',
        '        };',
        '    }',
        '}'
      )
    );
    expect(format(source, 'csharp_preserve_single_line_blocks = true')).toBe(source);
  });

  it('puts statements sharing a line on their own lines when csharp_preserve_single_line_statements is false', () => {
    const source = lines(
      'class C',
      '{',
      '    void M()',
      '    {',
      '        A(); B();',
      '        if (y) A(); else B();',
      '        switch (x)',
      '        {',
      '            case 1: break;',
      '        }',
      '        do A(); while (x);',
      '    L: A();',
      '    }',
      '}'
    );

    expect(format(source, 'csharp_preserve_single_line_statements = false')).toBe(
      lines(
        'class C',
        '{',
        '    void M()',
        '    {',
        '        A();',
        '        B();',
        '        if (y)',
        '            A();',
        '        else',
        '            B();',
        '        switch (x)',
        '        {',
        '            case 1:',
        '                break;',
        '        }',
        '        do',
        '            A();',
        '        while (x);',
        '    L:',
        '        A();',
        '    }',
        '}'
      )
    );
  });

  it('leaves statements in a block that stays on one line together', () => {
    const source = lines(
      'class C',
      '{',
      '    void M() { A(); B(); }',
      '    event Action E { add { a(); b(); } remove { } }',
      '    void N()',
      '    {',
      '        F(x => { A(x); if (x) B(x); });',
      '    }',
      '}'
    );

    expect(format(source, 'csharp_preserve_single_line_statements = false')).toBe(source);
    expect(format(source, 'csharp_preserve_single_line_statements = false\ncsharp_preserve_single_line_blocks = false')).toBe(
      lines(
        'class C',
        '{',
        '    void M()',
        '    {',
        '        A();',
        '        B();',
        '    }',
        '    event Action E { add { a(); b(); } remove { } }',
        '    void N()',
        '    {',
        '        F(x => { A(x); if (x) B(x); });',
        '    }',
        '}'
      )
    );
  });

  it('puts a switch label that follows a statement on a line of its own', () => {
    const source = lines(
      'class C',
      '{',
      '    void M()',
      '    {',
      '        switch (x)',
      '        {',
      '            case 1: { A(); } break; case 2: B(); break; default: break;',
      '        }',
      '    }',
      '}'
    );

    expect(format(source, 'csharp_preserve_single_line_statements = false\ncsharp_preserve_single_line_blocks = false')).toBe(
      lines(
        'class C',
        '{',
        '    void M()',
        '    {',
        '        switch (x)',
        '        {',
        '            case 1:',
        '                {',
        '                    A();',
        '                }',
        '                break;',
        '            case 2:',
        '                B();',
        '                break;',
        '            default:',
        '                break;',
        '        }',
        '    }',
        '}'
      )
    );
  });

  it('puts the members and accessor bodies of an expanded body on their own lines', () => {
    const source = lines('class C { int a; int b; void A() { } int Q { get { return 1; } set { _q = value; } } }');

    expect(format(source, 'csharp_preserve_single_line_blocks = false')).toBe(
      lines(
        'class C',
        '{',
        '    int a;',
        '    int b;',
        '    void A()',
        '    {',
        '    }',
        '    int Q',
        '    {',
        '        get',
        '        {',
        '            return 1;',
        '        }',
        '        set',
        '        {',
        '            _q = value;',
        '        }',
        '    }',
        '}'
      )
    );
    expect(format(lines('class C', '{', '    int a; int b;', '}'), 'csharp_preserve_single_line_statements = false')).toBe(
      lines('class C', '{', '    int a;', '    int b;', '}')
    );
  });

  it('puts the members of multi-line object initializers and anonymous types on their own lines', () => {
    const source = lines(
      'class C',
      '{',
      '    void M()',
      '    {',
      '        var a = new Foo { X = 1, Y = 2 };',
      '        var b = new Foo',
      '        {',
      '            X = 1, Y = 2',
      '        };',
      '        Call(x, new { A = 1,',
      '            B = 2 });',
      '        var c = new List<int>',
      '        {',
      '            1, 2',
      '        };',
      '    }',
      '}'
    );

    expect(format(source, 'csharp_new_line_before_members_in_object_initializers = true\ncsharp_new_line_before_members_in_anonymous_types = true')).toBe(
      lines(
        'class C',
        '{',
        '    void M()',
        '    {',
        '        var a = new Foo { X = 1, Y = 2 };',
        '        var b = new Foo',
        '        {',
        '            X = 1,',
        '            Y = 2',
        '        };',
        '        Call(x, new',
        '        {',
        '            A = 1,',
        '            B = 2',
        '        });',
        '        var c = new List<int>',
        '        {',
        '            1, 2',
        '        };',
        '    }',
        '}'
      )
    );
  });

  it('puts the clauses of a multi-line query on their own lines, aligned with from', () => {
    const source = lines(
      'class C',
      '{',
      '    void M()',
      '    {',
      '        var q = from x in xs where x > 1 select x;',
      '        var r = from x in xs',
      '            where x > 1 select x;',
      '    }',
      '}'
    );

    expect(format(source, 'csharp_new_line_between_query_expression_clauses = true')).toBe(
      lines(
        'class C',
        '{',
        '    void M()',
        '    {',
        '        var q = from x in xs where x > 1 select x;',
        '        var r = from x in xs',
        '                where x > 1',
        '                select x;',
        '    }',
        '}'
      )
    );
  });

  it('keeps code joined by a comment on one line', () => {
    const source = lines('class C', '{', '    void M()', '    {', '        A(); /* keep */ B();', '    }', '}');

    expect(format(source, 'csharp_preserve_single_line_statements = false')).toBe(source);
  });

  it('moves no operator for dotnet_style_operator_placement_when_wrapping, as Roslyn', () => {
    const source = lines('class C', '{', '    bool M()', '    {', '        return a &&', '            b', '            || c;', '    }', '}');

    expect(format(source, 'dotnet_style_operator_placement_when_wrapping = beginning_of_line')).toBe(source);
    expect(format(source, 'dotnet_style_operator_placement_when_wrapping = end_of_line')).toBe(source);
  });
});
