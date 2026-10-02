import { describe, expect, it } from 'vitest';
import { resolveEditorConfigProperties } from '../src/cleanup/editorconfig';
import { createEditorConfigFormattingConverter } from '../src/cleanup/transformations/editorConfigFormatting';

function lines(...text: string[]): string {
  return `${text.join('\n')}\n`;
}

function format(source: string, rules: string): { output: string; issues: string[] } {
  const props = resolveEditorConfigProperties([{ directory: '/repo', text: `root = true\n\n[*.cs]\n${rules}\n` }], '/repo/Sample.cs');
  const issues: string[] = [];
  const output = createEditorConfigFormattingConverter(props, (issue) => issues.push(issue)).apply(source);

  return { output, issues };
}

const IDE0055 = 'dotnet_diagnostic.IDE0055.severity = warning';

describe('editorconfig formatting: core properties', () => {
  it('converts indentation to tabs without touching strings, comments or alignment', () => {
    const source = lines(
      'class Sample',
      '{',
      '    string Text = @"a',
      '        b";',
      '    /* comment',
      '        continued */',
      '      int x = 1;    // aligned',
      '}'
    );

    expect(format(source, 'indent_style = tab\nindent_size = 4').output).toBe(
      lines('class Sample', '{', '\tstring Text = @"a', '        b";', '\t/* comment', '        continued */', '\t  int x = 1;    // aligned', '}')
    );
  });

  it('converts tab indentation to spaces using tab_width', () => {
    const source = lines('class Sample', '{', '\tvoid M()', '\t{', '\t\tvar s = "\t";', '\t}', '}');

    expect(format(source, 'indent_style = space\ntab_width = 2').output).toBe(
      lines('class Sample', '{', '  void M()', '  {', '    var s = "\t";', '  }', '}')
    );
  });

  it('keeps indentation inside a $@ string whose interpolation hole holds a string literal', () => {
    const source = lines('class Sample', '{', '  string M(bool c) => $@"{(c ? "a" : "b")}', '  keep two spaces', '  ";', '}');

    expect(format(source, 'indent_style = tab\ntab_width = 2').output).toBe(
      lines('class Sample', '{', '\tstring M(bool c) => $@"{(c ? "a" : "b")}', '  keep two spaces', '  ";', '}')
    );
  });

  it('normalizes line endings outside string literals and reports those kept inside', () => {
    const source = 'class Sample\n{\r\n    string Text = @"a\nb";\n}\n';
    const { output, issues } = format(source, 'end_of_line = crlf');

    expect(output).toBe('class Sample\r\n{\r\n    string Text = @"a\nb";\r\n}\r\n');
    expect(issues).toEqual([expect.stringMatching(/line 3: line breaks inside a multi-line string literal were kept/)]);
  });

  it('keeps the line breaks inside a $@ string whose interpolation hole holds a string literal', () => {
    const source = 'class Sample\n{\n    string M(bool c) => $@"{(c ? "a" : "b")}\n      line2";\n}\n';
    const { output, issues } = format(source, 'end_of_line = crlf');

    expect(output).toBe('class Sample\r\n{\r\n    string M(bool c) => $@"{(c ? "a" : "b")}\n      line2";\r\n}\r\n');
    expect(issues).toEqual([expect.stringMatching(/line 3: line breaks inside a multi-line string literal were kept/)]);
  });

  it('adds or removes the final newline', () => {
    expect(format('class Sample { }', 'insert_final_newline = true\nend_of_line = crlf').output).toBe('class Sample { }\r\n');
    expect(format('class Sample { }\n\n', 'insert_final_newline = false').output).toBe('class Sample { }');
  });

  it('trims trailing whitespace outside literals', () => {
    const source = 'class Sample   \n{\n    string Text = @"a   \nb";\n}\n';

    expect(format(source, 'trim_trailing_whitespace = true').output).toBe('class Sample\n{\n    string Text = @"a   \nb";\n}\n');
  });

  it('removes the byte order mark for charset = utf-8', () => {
    expect(format('\uFEFFclass Sample { }\n', 'charset = utf-8').output).toBe('class Sample { }\n');
    expect(format('\uFEFFclass Sample { }\n', 'charset = utf-8-bom').output).toBe('\uFEFFclass Sample { }\n');
  });

  it('applies core properties without IDE0055 but C# options only with it', () => {
    const source = 'class Sample {\n\tvoid M() {\n\t}\n}';
    const rules = 'indent_style = space\nindent_size = 4\ninsert_final_newline = true\ncsharp_new_line_before_open_brace = all';

    expect(format(source, rules).output).toBe('class Sample {\n    void M() {\n    }\n}\n');
    expect(format(source, `${rules}\ndotnet_diagnostic.IDE0055.severity = silent`).output).toBe(
      'class Sample {\n    void M() {\n    }\n}\n'
    );
    expect(format(source, `${rules}\n${IDE0055}`).output).toBe('class Sample\n{\n    void M()\n    {\n    }\n}\n');
  });
});

describe('issue line numbers', () => {
  it('numbers an open-brace issue against the input when the using order adds a line above it', () => {
    const source = lines('using System;', 'using Zeta;', 'class C // note', '{', '}');
    const { output, issues } = format(source, `${IDE0055}\ndotnet_separate_import_directive_groups = true\ncsharp_new_line_before_open_brace = none`);

    expect(output).toBe(lines('using System;', '', 'using Zeta;', 'class C // note', '{', '}'));
    expect(issues).toEqual([expect.stringMatching(/^IDE0055 \(csharp_new_line_before_open_brace\) line 4: /)]);
  });

  it('numbers an indentation issue against the input when a moved brace removes a line above it', () => {
    const source = lines('class C', '{', '    void M(bool a)', '#if X', '    { Y(); }', '#else', '    { }', '#endif', '}');
    const { issues } = format(source, `${IDE0055}\ncsharp_new_line_before_open_brace = none`);

    expect(issues).toEqual([expect.stringMatching(/^IDE0055 \(indentation\) line 4: /)]);
  });

  it('numbers an end_of_line issue against the input when a moved brace removes a line above it', () => {
    const source = lines('class C', '{', '    string S = @"a', 'b";', '}');
    const { issues } = format(source.replace(/\n/g, '\r\n').replace('@"a\r\n', '@"a\n'), `${IDE0055}\ncsharp_new_line_before_open_brace = none\nend_of_line = crlf`);

    expect(issues).toEqual([expect.stringMatching(/line 3: line breaks inside a multi-line string literal were kept/)]);
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
    expect(format(allOnOwnLine, `csharp_new_line_before_open_brace = none\n${IDE0055}`).output).toBe(allOnSameLine);
  });

  it('puts every multi-line opening brace on its own line for all', () => {
    expect(format(allOnSameLine, `csharp_new_line_before_open_brace = all\n${IDE0055}`).output).toBe(allOnOwnLine);
  });

  it('applies no unsupported value, such as a misspelled kind', () => {
    expect(format(allOnOwnLine, `csharp_new_line_before_open_brace = method\n${IDE0055}`).output).toBe(allOnOwnLine);
    expect(format(allOnSameLine, `csharp_new_line_before_open_brace = methods,typo\n${IDE0055}`).output).toBe(allOnSameLine);
  });

  it('only moves the listed kinds', () => {
    const { output } = format(allOnSameLine, `csharp_new_line_before_open_brace = methods, types\n${IDE0055}`);

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

  it('never joins a brace to a comment line and reports it', () => {
    const source = lines('class Sample // note', '{', '}');
    const { output, issues } = format(source, `csharp_new_line_before_open_brace = none\n${IDE0055}`);

    expect(output).toBe(source);
    expect(issues).toEqual([expect.stringMatching(/^IDE0055 \(csharp_new_line_before_open_brace\) line 2/)]);
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
    const nested = (brace: Brace): string[] => [
      ...brace('var outer = new Sample'),
      '    Inner =',
      '    {',
      '        X = 1',
      '    },',
      '};',
    ];
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

    expect(format(onOwnLine, `csharp_new_line_before_open_brace = none\n${IDE0055}`).output).toBe(onSameLine);
    expect(format(onSameLine, `csharp_new_line_before_open_brace = all\n${IDE0055}`).output).toBe(onOwnLine);
  });
});

describe('csharp_new_line_before_else/catch/finally', () => {
  function method(...body: string[]): string {
    return lines('class Sample', '{', '    void M(bool x)', '    {', ...body.map((line) => `        ${line}`), '    }', '}');
  }

  const split = method(
    'try',
    '{',
    '    if (x) { A(); } else { B(); }',
    '}',
    'catch (Exception)',
    '{',
    '}',
    'finally',
    '{',
    '}'
  );
  const joined = method('try', '{', '    if (x) { A(); } else { B(); }', '} catch (Exception)', '{', '} finally', '{', '}');

  it('joins the keyword to the closing brace when false', () => {
    const rules = ['csharp_new_line_before_else = false', 'csharp_new_line_before_catch = false', 'csharp_new_line_before_finally = false', IDE0055];

    expect(format(split, rules.join('\n')).output).toBe(joined);
  });

  it('moves the keyword to its own line when true, leaving a construct written on one line alone as Roslyn does', () => {
    const rules = ['csharp_new_line_before_else = true', 'csharp_new_line_before_catch = true', 'csharp_new_line_before_finally = true', IDE0055];

    expect(format(joined, rules.join('\n')).output).toBe(split);
  });
});

describe('spacing options', () => {
  const source = lines('class Sample', '{', '    void M(object o)', '    {', '        if(o is int) { var i = (int)o; }', '        while (true) { }', '    }', '}');

  it('applies csharp_space_after_cast and csharp_space_after_keywords_in_control_flow_statements', () => {
    const { output } = format(
      source,
      `csharp_space_after_cast = true\ncsharp_space_after_keywords_in_control_flow_statements = true\n${IDE0055}`
    );

    expect(output).toBe(
      lines('class Sample', '{', '    void M(object o)', '    {', '        if (o is int) { var i = (int) o; }', '        while (true) { }', '    }', '}')
    );
  });

  it('removes the spaces for false', () => {
    const { output } = format(
      source,
      `csharp_space_after_cast = false\ncsharp_space_after_keywords_in_control_flow_statements = false\n${IDE0055}`
    );

    expect(output).toBe(
      lines('class Sample', '{', '    void M(object o)', '    {', '        if(o is int) { var i = (int)o; }', '        while(true) { }', '    }', '}')
    );
  });
});

describe('using directive options', () => {
  it('sorts System first and separates groups', () => {
    const source = lines('using Contoso.Data;', 'using System.Text;', 'using Microsoft.Extensions;', 'using System;', '', 'class Sample { }');
    const rules = `dotnet_sort_system_directives_first = true\ndotnet_separate_import_directive_groups = true\n${IDE0055}`;

    expect(format(source, rules).output).toBe(
      lines('using System;', 'using System.Text;', '', 'using Contoso.Data;', '', 'using Microsoft.Extensions;', '', 'class Sample { }')
    );
  });

  it('sorts usings whenever dotnet_sort_system_directives_first is set, without IDE0055, which does not cover using order', () => {
    const source = lines('using Contoso.Data;', 'using System;', 'using Alpha;', '', 'class Sample { }');

    expect(format(source, 'dotnet_sort_system_directives_first = true').output).toBe(
      lines('using System;', 'using Alpha;', 'using Contoso.Data;', '', 'class Sample { }')
    );
    expect(format(source, 'dotnet_sort_system_directives_first = false').output).toBe(
      lines('using Alpha;', 'using Contoso.Data;', 'using System;', '', 'class Sample { }')
    );
    expect(format(source, 'indent_size = 4').output).toBe(source);
  });

  it('removes blank lines between usings for dotnet_separate_import_directive_groups = false', () => {
    const source = lines('using System;', '', 'using Alpha;', '', '// Data access', 'using Contoso.Data;', '', 'class Sample { }');

    expect(format(source, 'dotnet_separate_import_directive_groups = false').output).toBe(
      lines('using System;', 'using Alpha;', '', '// Data access', 'using Contoso.Data;', '', 'class Sample { }')
    );
    expect(format(source, 'indent_size = 4').output).toBe(source);
  });
});
