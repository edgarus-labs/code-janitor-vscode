import { describe, expect, it } from 'vitest';
import { resolveEditorConfigProperties } from '../src/cleanup/editorconfig';
import { createEditorConfigFormattingConverter } from '../src/cleanup/transformations/editorConfigFormatting';

/** Formats `body` placed in a method, with IDE0055 enforced and the given options. */
function format(source: string, rules: string, ide0055 = 'warning'): string {
  const props = resolveEditorConfigProperties(
    [{ directory: '/repo', text: `root = true\n\n[*.cs]\ndotnet_diagnostic.IDE0055.severity = ${ide0055}\n${rules}\n` }],
    '/repo/Sample.cs'
  );

  return createEditorConfigFormattingConverter(props, () => undefined).apply(source);
}

function inMethod(...statements: string[]): string {
  return `class C\n{\n    void M()\n    {\n${statements.map((line) => `        ${line}\n`).join('')}    }\n}\n`;
}

describe('editorconfig formatting: csharp_space_*', () => {
  it('is gated on IDE0055', () => {
    const source = inMethod('F(a ,b);');

    expect(format(source, 'csharp_space_after_comma = true\ncsharp_space_before_comma = false', 'silent')).toBe(source);
  });

  it('spaces commas, but not inside empty rank specifiers or unbound generics, nor inside strings', () => {
    const source = inMethod('F(a ,b,c);', 'var t = typeof(Dictionary<,>);', 'int[,] grid = new int[2,3];', 'var s = "a,b";');

    expect(format(source, 'csharp_space_after_comma = true\ncsharp_space_before_comma = false')).toBe(
      inMethod('F(a, b, c);', 'var t = typeof(Dictionary<,>);', 'int[,] grid = new int[2, 3];', 'var s = "a,b";')
    );
    expect(format(inMethod('F(a, b);'), 'csharp_space_after_comma = false\ncsharp_space_before_comma = true')).toBe(inMethod('F(a ,b);'));
  });

  it('spaces dots without joining wrapped member chains', () => {
    const source = inMethod('var n = a . b .c;', 'var q = items', '    .Where(x => x)', '    .ToList();');

    expect(format(source, 'csharp_space_after_dot = false\ncsharp_space_before_dot = false')).toBe(
      inMethod('var n = a.b.c;', 'var q = items', '    .Where(x => x)', '    .ToList();')
    );
  });

  it('spaces symbolic binary operators and assignments, but not unary operators, keywords or declarator =', () => {
    const source = inMethod('var x = a+b*-c;', 'var y = p??q;', 'bool z = o is string;', 'x+=1;', 'int w  =  1;');

    expect(format(source, 'csharp_space_around_binary_operators = before_and_after')).toBe(
      inMethod('var x = a + b * -c;', 'var y = p ?? q;', 'bool z = o is string;', 'x += 1;', 'int w  =  1;')
    );
    expect(format(inMethod('var x = a + b;'), 'csharp_space_around_binary_operators = none')).toBe(inMethod('var x = a+b;'));
    expect(format(inMethod('var x = a  +b;'), 'csharp_space_around_binary_operators = ignore')).toBe(inMethod('var x = a  +b;'));
  });

  it('keeps one space where removing it would fuse the operator with the operand into another token', () => {
    const source = inMethod('x = a - --b;', 'x = a + ++b;', 'x = a - -b;', 'x = a / *p;', 'x = a & &b;', 'x = a * -b;');

    expect(format(source, 'csharp_space_around_binary_operators = none')).toBe(
      inMethod('x=a- --b;', 'x=a+ ++b;', 'x=a- -b;', 'x=a/ *p;', 'x=a& &b;', 'x=a*-b;')
    );
  });

  it('never splits a shift or shift assignment the lexer reads as two tokens', () => {
    const source = inMethod('x >>= 2;', 'x>>=2;', 'x = y >>= 2;', 'x = y>>>2;', 'x >>>= 2;', 'x = a<b>>c;');

    expect(format(source, 'csharp_space_around_binary_operators = before_and_after')).toBe(source);
  });

  it('still spaces around closing nested generics', () => {
    expect(format(inMethod('F<List<int>>();'), 'csharp_space_between_method_call_name_and_opening_parenthesis = true')).toBe(
      inMethod('F<List<int>> ();')
    );
  });

  it('spaces the colon of base lists, constraints and constructor initializers', () => {
    const source = 'class C:B where T:class\n{\n    C():base()\n    {\n    }\n}\n';

    expect(
      format(source, 'csharp_space_before_colon_in_inheritance_clause = true\ncsharp_space_after_colon_in_inheritance_clause = true')
    ).toBe('class C : B where T : class\n{\n    C() : base()\n    {\n    }\n}\n');
  });

  it('spaces for-statement semicolons, empty parts included as in Roslyn', () => {
    const source = inMethod('for (int i = 0;i < n ;i++) { }', 'for (;;) { }');

    expect(
      format(source, 'csharp_space_after_semicolon_in_for_statement = true\ncsharp_space_before_semicolon_in_for_statement = false')
    ).toBe(inMethod('for (int i = 0; i < n; i++) { }', 'for (; ; ) { }'));
  });

  it('spaces square brackets of element access and array ranks, not attributes', () => {
    const source = '[Obsolete]\nclass C\n{\n    int[ ] a = new int [ 2 ];\n    int[] b = new [ ] { 1 };\n    int M() => a [ 0 ];\n}\n';

    expect(
      format(
        source,
        'csharp_space_before_open_square_brackets = false\ncsharp_space_between_empty_square_brackets = false\ncsharp_space_between_square_brackets = false'
      )
    ).toBe('[Obsolete]\nclass C\n{\n    int[] a = new int[2];\n    int[] b = new[] { 1 };\n    int M() => a[0];\n}\n');
  });

  it('spaces method call (including object creation and attribute) and declaration parentheses', () => {
    const source = 'class C\n{\n    [Obsolete ( "x" )]\n    void M ( int a )\n    {\n        N ();\n        M ( new C ( 1 ) );\n    }\n\n    void N( ) { }\n}\n';
    const rules = [
      'csharp_space_between_method_call_name_and_opening_parenthesis = false',
      'csharp_space_between_method_call_parameter_list_parentheses = false',
      'csharp_space_between_method_call_empty_parameter_list_parentheses = false',
      'csharp_space_between_method_declaration_name_and_open_parenthesis = false',
      'csharp_space_between_method_declaration_parameter_list_parentheses = false',
      'csharp_space_between_method_declaration_empty_parameter_list_parentheses = false',
    ].join('\n');

    expect(format(source, rules)).toBe('class C\n{\n    [Obsolete("x")]\n    void M(int a)\n    {\n        N();\n        M(new C(1));\n    }\n\n    void N() { }\n}\n');
  });

  it('spaces inside control-flow, expression and cast parentheses per csharp_space_between_parentheses', () => {
    const source = inMethod('if (x) { }', 'var y = (a + b) * (int)c;', 'try { } catch (E e) when (e.X) { }');

    expect(format(source, 'csharp_space_between_parentheses = control_flow_statements,type_casts')).toBe(
      inMethod('if ( x ) { }', 'var y = (a + b) * ( int )c;', 'try { } catch ( E e ) when ( e.X ) { }')
    );
    expect(format(inMethod('if ( x ) { }', 'var y = ( a );'), 'csharp_space_between_parentheses = false')).toBe(
      inMethod('if (x) { }', 'var y = (a);')
    );
  });

  it('collapses extra spaces in declarations when csharp_space_around_declaration_statements is false', () => {
    const source = 'class C\n{\n    private  int   _count =  1;\n}\n';

    expect(format(source, 'csharp_space_around_declaration_statements = false')).toBe('class C\n{\n    private int _count = 1;\n}\n');
    expect(format(source, 'csharp_space_around_declaration_statements = ignore')).toBe(source);
  });

  it('leaves deconstructions, generic types in patterns and tuple type arguments alone', () => {
    const source = inMethod(
      'var (a, b) = T();',
      'if (o is Dictionary<string, object> d && a>b) { }',
      'var l = new List<(string Id, int Count)>();',
      'var t = x as int? ?? 0;'
    );
    const rules = [
      'csharp_space_between_method_call_name_and_opening_parenthesis = false',
      'csharp_space_around_binary_operators = before_and_after',
      'csharp_space_before_comma = true',
      'csharp_space_around_declaration_statements = false',
    ];

    expect(format(source, rules.join('\n'))).toBe(source);
  });

  it('spaces collection expressions like square brackets, leaving multi-line ones alone', () => {
    const source = inMethod('int[] a = [ ];', 'int[] b = [1, 2];', 'F([1], []);', 'int[] c =', '[', '    1,2', '];');

    expect(format(source, 'csharp_space_between_square_brackets = true\ncsharp_space_between_empty_square_brackets = false')).toBe(
      inMethod('int[] a = [];', 'int[] b = [ 1, 2 ];', 'F([ 1 ], []);', 'int[] c =', '[', '    1,2', '];')
    );
  });

  it('never changes a gap holding a comment or a line break', () => {
    const source = inMethod('F(a /* x */ ,b);', 'F(a,', '  b);');

    expect(format(source, 'csharp_space_after_comma = true\ncsharp_space_before_comma = false')).toBe(
      inMethod('F(a /* x */ , b);', 'F(a,', '  b);')
    );
  });
});
