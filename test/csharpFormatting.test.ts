import { describe, expect, it } from 'vitest';
import { resolveEditorConfigProperties } from '../src/cleanup/editorconfig';
import { formatCSharp } from '../src/razor/csharp/formatting';

function lines(...text: string[]): string {
  return `${text.join('\n')}\n`;
}

function format(source: string, rules: string): string {
  return formatCSharp(source, resolveEditorConfigProperties([{ directory: '/repo', text: `root = true\n\n[*.cs]\n${rules}\n` }], '/repo/Sample.cs'));
}

const ALL_KINDS =
  'csharp_new_line_before_open_brace = accessors, anonymous_methods, anonymous_types, control_blocks, events, indexers, lambdas, local_functions, methods, object_collection_array_initializers, properties, types';

describe('C# formatting: indent_style', () => {
  it('converts indentation to tabs without touching strings or comments', () => {
    const source = lines(
      'class Sample',
      '{',
      '    string Text = @"a',
      '        b";',
      '    /* comment',
      '        continued */',
      '    int x = 1;    // aligned',
      '}'
    );

    expect(format(source, 'indent_style = tab\nindent_size = 4')).toBe(
      lines('class Sample', '{', '\tstring Text = @"a', '        b";', '\t/* comment', '        continued */', '\tint x = 1;    // aligned', '}')
    );
  });

  it('converts tab indentation to spaces using tab_width', () => {
    const source = lines('class Sample', '{', '\tvoid M()', '\t{', '\t\tvar s = "\t";', '\t}', '}');

    expect(format(source, 'indent_style = space\nindent_size = tab\ntab_width = 2')).toBe(
      lines('class Sample', '{', '  void M()', '  {', '    var s = "\t";', '  }', '}')
    );
  });

  it('keeps indentation inside a $@ string whose interpolation hole holds a string literal', () => {
    const source = lines('class Sample', '{', '  string M(bool c) => $@"{(c ? "a" : "b")}', '  keep two spaces', '  ";', '}');

    expect(format(source, 'indent_style = tab\nindent_size = tab\ntab_width = 2')).toBe(
      lines('class Sample', '{', '\tstring M(bool c) => $@"{(c ? "a" : "b")}', '  keep two spaces', '  ";', '}')
    );
  });
});

describe('csharp_new_line_before_open_brace', () => {
  const allOnOwnLine = lines(
    'class Sample',
    '{',
    '    public int Value',
    '    {',
    '        get',
    '        {',
    '            return 1;',
    '        }',
    '    }',
    '    public int Auto { get; set; }',
    '    void M(int x)',
    '    {',
    '        if (x > 0)',
    '        {',
    '            x--;',
    '        }',
    '        else',
    '        {',
    '            x++;',
    '        }',
    '        var list = new List<int> { 1, 2 };',
    '        Action a = () =>',
    '        {',
    '        };',
    '    }',
    '}'
  );
  const allOnSameLine = lines(
    'class Sample {',
    '    public int Value {',
    '        get {',
    '            return 1;',
    '        }',
    '    }',
    '    public int Auto { get; set; }',
    '    void M(int x) {',
    '        if (x > 0) {',
    '            x--;',
    '        }',
    '        else {',
    '            x++;',
    '        }',
    '        var list = new List<int> { 1, 2 };',
    '        Action a = () => {',
    '        };',
    '    }',
    '}'
  );

  it('puts every multi-line opening brace on the same line for none', () => {
    expect(format(allOnOwnLine, `csharp_new_line_before_open_brace = none`)).toBe(allOnSameLine);
  });

  it('puts every multi-line opening brace on its own line for every kind', () => {
    expect(format(allOnSameLine, ALL_KINDS)).toBe(allOnOwnLine);
  });

  it('only moves the listed kinds', () => {
    const output = format(allOnSameLine, `csharp_new_line_before_open_brace = methods, types`);

    expect(output).toBe(
      lines(
        'class Sample',
        '{',
        '    public int Value {',
        '        get {',
        '            return 1;',
        '        }',
        '    }',
        '    public int Auto { get; set; }',
        '    void M(int x)',
        '    {',
        '        if (x > 0) {',
        '            x--;',
        '        }',
        '        else {',
        '            x++;',
        '        }',
        '        var list = new List<int> { 1, 2 };',
        '        Action a = () => {',
        '        };',
        '    }',
        '}'
      )
    );
  });

  it('never joins a brace to a comment line', () => {
    const source = lines('class Sample // note', '{', '}');

    expect(format(source, 'csharp_new_line_before_open_brace = none')).toBe(source);
  });

  it('moves only the brace of an object initializer (creation or with) and leaves collection, nested and element initializers as Roslyn does', () => {
    type Brace = (text: string, indent?: string) => string[];
    const ownLine: Brace = (text, indent = '') => [indent + text, `${indent}{`];
    const sameLine: Brace = (text, indent = '') => [`${indent}${text} {`];
    const method = (brace: Brace, ...body: string[]): string =>
      lines(...brace('class Sample'), ...brace('object M(R r)', '    '), ...body.map((line) => `        ${line}`), '    }', '}');
    const kept = [
      'var list = new List<int>',
      '{',
      '    1',
      '};',
      'List<int> implicitList = new()',
      '{',
      '    1',
      '};',
      'var map = new Dictionary<int, int>',
      '{',
      '    { 1, 2 },',
      '    {',
      '        3, 4',
      '    },',
      '};',
    ];
    const nested = (brace: Brace): string[] => [...brace('var outer = new Sample'), '    Inner =', '    {', '        X = 1', '    },', '};'];
    const objects = (brace: Brace): string[] => [
      ...brace('var empty = new Sample'),
      '};',
      ...brace('Sample implicitObject = new()'),
      '    X = 1',
      '};',
      ...brace('var copy = r with'),
      '    X = 2',
      '};',
    ];

    const onOwnLine = method(ownLine, ...kept, ...nested(ownLine), ...objects(ownLine));
    const onSameLine = method(sameLine, ...kept, ...nested(sameLine), ...objects(sameLine));

    expect(format(onOwnLine, `csharp_new_line_before_open_brace = none`)).toBe(onSameLine);
    expect(format(onSameLine, ALL_KINDS)).toBe(onOwnLine);
  });
});

describe('csharp_new_line_before_else/catch/finally', () => {
  function method(...body: string[]): string {
    return lines('class Sample', '{', '    void M(bool x)', '    {', ...body.map((line) => `        ${line}`), '    }', '}');
  }

  const split = method('try', '{', '    if (x) { A(); } else { B(); }', '}', 'catch (Exception)', '{', '}', 'finally', '{', '}');
  const joined = method('try', '{', '    if (x) { A(); } else { B(); }', '} catch (Exception)', '{', '} finally', '{', '}');

  it('joins the keyword to the closing brace when false', () => {
    const rules = ['csharp_new_line_before_else = false', 'csharp_new_line_before_catch = false', 'csharp_new_line_before_finally = false'];

    expect(format(split, rules.join('\n'))).toBe(joined);
  });

  it('moves the keyword to its own line when true, leaving a construct written on one line alone as Roslyn does', () => {
    const rules = ['csharp_new_line_before_else = true', 'csharp_new_line_before_catch = true', 'csharp_new_line_before_finally = true'];

    expect(format(joined, rules.join('\n'))).toBe(split);
  });
});

describe('spacing options', () => {
  const source = lines(
    'class Sample',
    '{',
    '    void M(object o)',
    '    {',
    '        if(o is int) { var i = (int)o; }',
    '        while (true) { }',
    '    }',
    '}'
  );

  it('applies csharp_space_after_cast and csharp_space_after_keywords_in_control_flow_statements', () => {
    const output = format(source, `csharp_space_after_cast = true\ncsharp_space_after_keywords_in_control_flow_statements = true`);

    expect(output).toBe(
      lines('class Sample', '{', '    void M(object o)', '    {', '        if (o is int) { var i = (int) o; }', '        while (true) { }', '    }', '}')
    );
  });

  it('removes the spaces for false', () => {
    const output = format(source, `csharp_space_after_cast = false\ncsharp_space_after_keywords_in_control_flow_statements = false`);

    expect(output).toBe(
      lines('class Sample', '{', '    void M(object o)', '    {', '        if(o is int) { var i = (int)o; }', '        while(true) { }', '    }', '}')
    );
  });
});
