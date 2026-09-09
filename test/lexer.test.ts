import { describe, expect, it } from 'vitest';
import { lex } from '../src/cleanup/syntax/lexer';

describe('lex', () => {
  it('tokenizes a simple class', () => {
    const { tokens, trivia } = lex('class C { }');

    expect(tokens.map((t) => t.type)).toEqual(['class', 'identifier', '{', '}', 'end']);
    expect(trivia).toEqual([]);
  });

  it('skips whitespace', () => {
    const { tokens } = lex('  class  C  {  }  ');

    expect(tokens.map((t) => t.type)).toEqual(['class', 'identifier', '{', '}', 'end']);
  });

  it('collects line comments as trivia', () => {
    const { tokens, trivia } = lex('class C {} // comment');

    expect(tokens.map((t) => t.type)).toEqual(['class', 'identifier', '{', '}', 'end']);
    expect(trivia).toHaveLength(1);
    expect(trivia[0].type).toBe('comment');
  });

  it('collects block comments as trivia', () => {
    const { trivia } = lex('/* comment */ class C {}');

    expect(trivia).toHaveLength(1);
    expect(trivia[0].type).toBe('comment');
  });

  it('collects preprocessor directives as trivia', () => {
    const { trivia } = lex('#region Foo\nclass C {}\n#endregion');

    expect(trivia).toHaveLength(2);
    expect(trivia[0].type).toBe('preproc_region');
    expect(trivia[1].type).toBe('preproc_endregion');
  });

  it('collects unknown preprocessor as generic directive', () => {
    const { trivia } = lex('#custom directive');

    expect(trivia).toHaveLength(1);
    expect(trivia[0].type).toBe('preproc_directive');
  });

  it('tokenizes string literals', () => {
    const { tokens } = lex('string s = "hello";');

    expect(tokens.map((t) => t.type)).toEqual([
      'predefined_type', 'identifier', '=', 'string_literal', ';', 'end',
    ]);
  });

  it('tokenizes interpolated strings', () => {
    const { tokens } = lex('string s = $"{x}";');

    expect(tokens.map((t) => t.type)).toEqual([
      'predefined_type', 'identifier', '=', 'interpolated_string_expression', ';', 'end',
    ]);
  });

  it('tokenizes verbatim strings', () => {
    const { tokens } = lex('string s = @"path";');

    expect(tokens.map((t) => t.type)).toEqual([
      'predefined_type', 'identifier', '=', 'verbatim_string_literal', ';', 'end',
    ]);
  });

  it('tokenizes raw strings', () => {
    const { tokens } = lex('string s = """raw""";');

    expect(tokens.map((t) => t.type)).toEqual([
      'predefined_type', 'identifier', '=', 'raw_string_literal', ';', 'end',
    ]);
  });

  it('tokenizes char literals', () => {
    const { tokens } = lex("char c = 'a';");

    expect(tokens.map((t) => t.type)).toEqual([
      'predefined_type', 'identifier', '=', 'character_literal', ';', 'end',
    ]);
  });

  it('tokenizes integer literals', () => {
    const { tokens } = lex('int x = 42;');

    expect(tokens.map((t) => t.type)).toEqual([
      'predefined_type', 'identifier', '=', 'integer_literal', ';', 'end',
    ]);
  });

  it('tokenizes real literals', () => {
    const { tokens } = lex('double d = 3.14;');

    expect(tokens.map((t) => t.type)).toEqual([
      'predefined_type', 'identifier', '=', 'real_literal', ';', 'end',
    ]);
  });

  it('tokenizes hex literals', () => {
    const { tokens } = lex('int x = 0xFF;');

    expect(tokens.map((t) => t.type)).toEqual([
      'predefined_type', 'identifier', '=', 'integer_literal', ';', 'end',
    ]);
  });

  it('tokenizes binary literals', () => {
    const { tokens } = lex('int x = 0b1010;');

    expect(tokens.map((t) => t.type)).toEqual([
      'predefined_type', 'identifier', '=', 'integer_literal', ';', 'end',
    ]);
  });

  it('tokenizes numbers with suffixes', () => {
    const { tokens } = lex('long x = 42L;');

    expect(tokens.map((t) => t.type)).toEqual([
      'predefined_type', 'identifier', '=', 'integer_literal', ';', 'end',
    ]);
  });

  it('tokenizes float suffix', () => {
    const { tokens } = lex('float f = 1.5f;');

    expect(tokens.map((t) => t.type)).toEqual([
      'predefined_type', 'identifier', '=', 'real_literal', ';', 'end',
    ]);
  });

  it('tokenizes exponent notation', () => {
    const { tokens } = lex('double d = 1e10;');

    expect(tokens.map((t) => t.type)).toEqual([
      'predefined_type', 'identifier', '=', 'real_literal', ';', 'end',
    ]);
  });

  it('tokenizes keywords', () => {
    const { tokens } = lex('public static void Main() { }');

    expect(tokens.map((t) => t.type)).toEqual([
      'public', 'static', 'predefined_type', 'identifier', '(', ')', '{', '}', 'end',
    ]);
  });

  it('tokenizes null as null_literal', () => {
    const { tokens } = lex('object x = null;');

    expect(tokens.map((t) => t.type)).toEqual([
      'predefined_type', 'identifier', '=', 'null_literal', ';', 'end',
    ]);
  });

  it('tokenizes true/false as boolean_literal', () => {
    const { tokens } = lex('bool a = true; bool b = false;');

    expect(tokens.map((t) => t.type)).toEqual([
      'predefined_type', 'identifier', '=', 'boolean_literal', ';',
      'predefined_type', 'identifier', '=', 'boolean_literal', ';', 'end',
    ]);
  });

  it('tokenizes predefined types', () => {
    const { tokens } = lex('int i; string s; bool b; object o;');

    expect(tokens.filter((t) => t.type === 'predefined_type')).toHaveLength(4);
  });

  it('tokenizes @escaped identifiers', () => {
    const { tokens } = lex('@class');

    expect(tokens[0].type).toBe('identifier');
    expect(tokens[0].start).toBe(0);
    expect(tokens[0].end).toBe(6);
  });

  it('tokenizes operators', () => {
    const { tokens } = lex('a += b; c == d; e != f; g => h;');

    const ops = tokens.filter((t) => ['+=', '==', '!=', '=>'].includes(t.type));

    expect(ops).toHaveLength(4);
  });

  it('tokenizes compound assignment operators', () => {
    const { tokens } = lex('a <<= 2; b ??= c;');

    expect(tokens.filter((t) => t.type === '<<=')).toHaveLength(1);
    expect(tokens.filter((t) => t.type === '??=')).toHaveLength(1);
  });

  it('tokenizes ?. and ?? operators', () => {
    const { tokens } = lex('a?.b ?? c');

    expect(tokens.filter((t) => t.type === '?.')).toHaveLength(1);
    expect(tokens.filter((t) => t.type === '??')).toHaveLength(1);
  });

  it('tokenizes :: operator', () => {
    const { tokens } = lex('global::System');

    expect(tokens.filter((t) => t.type === '::')).toHaveLength(1);
  });

  it('tokenizes .. operator', () => {
    const { tokens } = lex('a[1..5]');

    expect(tokens.filter((t) => t.type === '..')).toHaveLength(1);
  });

  it('tokenizes ++ and -- operators', () => {
    const { tokens } = lex('i++; j--;');

    expect(tokens.filter((t) => t.type === '++')).toHaveLength(1);
    expect(tokens.filter((t) => t.type === '--')).toHaveLength(1);
  });

  it('tokenizes -> operator', () => {
    const { tokens } = lex('ptr->member');

    expect(tokens.filter((t) => t.type === '->')).toHaveLength(1);
  });

  it('handles unknown characters gracefully', () => {
    const { tokens } = lex('a \\ b');

    expect(tokens).toContainEqual(expect.objectContaining({ type: '\\' }));
  });

  it('handles empty source', () => {
    const { tokens, trivia } = lex('');

    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('end');
    expect(trivia).toEqual([]);
  });

  it('handles only whitespace', () => {
    const { tokens, trivia } = lex('   \n\t  ');

    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('end');
    expect(trivia).toEqual([]);
  });

  it('handles unclosed string', () => {
    const { tokens } = lex('string s = "unclosed');

    expect(tokens.filter((t) => t.type === 'string_literal')).toHaveLength(1);
  });

  it('handles unclosed char literal', () => {
    const { tokens } = lex("char c = 'unclosed");

    expect(tokens.filter((t) => t.type === 'character_literal')).toHaveLength(1);
  });

  it('handles unclosed block comment', () => {
    const { trivia } = lex('/* unclosed');

    expect(trivia).toHaveLength(1);
    expect(trivia[0].type).toBe('comment');
  });

  it('handles preprocessor not at line start', () => {
    // A # in the middle of a line is not a preprocessor directive
    const { tokens, trivia } = lex('a # b');

    expect(trivia).toEqual([]);
  });

  it('handles $ without quote as punctuator', () => {
    const { tokens } = lex('$variable');

    expect(tokens.some((t) => t.type === '$')).toBe(true);
  });

  it('handles @ without quote as identifier start', () => {
    const { tokens } = lex('@class');

    expect(tokens[0].type).toBe('identifier');
  });

  it('tokenizes range expressions without splitting ..', () => {
    const { tokens } = lex('a[1..2]');

    const dots = tokens.filter((t) => t.type === '..');

    expect(dots).toHaveLength(1);
  });

  it('does not split >> in generics', () => {
    const { tokens } = lex('List<List<int>>');

    // The lexer intentionally keeps >> as two separate > tokens
    const greaters = tokens.filter((t) => t.type === '>');

    expect(greaters).toHaveLength(2);
  });

  it('tokenizes method call with member access', () => {
    const { tokens } = lex('Console.WriteLine("hi");');

    expect(tokens.map((t) => t.type)).toEqual([
      'identifier', '.', 'identifier', '(', 'string_literal', ')', ';', 'end',
    ]);
  });

  it('tokenizes using directive', () => {
    const { tokens } = lex('using System;');

    expect(tokens.map((t) => t.type)).toEqual(['using', 'identifier', ';', 'end']);
  });

  it('tokenizes global using', () => {
    const { tokens } = lex('global using System;');

    expect(tokens.map((t) => t.type)).toEqual(['identifier', 'using', 'identifier', ';', 'end']);
  });

  it('tokenizes static using', () => {
    const { tokens } = lex('using static System.Math;');

    expect(tokens.map((t) => t.type)).toEqual(['using', 'static', 'identifier', '.', 'identifier', ';', 'end']);
  });

  it('tokenizes namespace declaration', () => {
    const { tokens } = lex('namespace Foo.Bar { }');

    expect(tokens.map((t) => t.type)).toEqual(['namespace', 'identifier', '.', 'identifier', '{', '}', 'end']);
  });

  it('tokenizes file-scoped namespace', () => {
    const { tokens } = lex('namespace Foo;');

    expect(tokens.map((t) => t.type)).toEqual(['namespace', 'identifier', ';', 'end']);
  });

  it('tokenizes attributes', () => {
    const { tokens } = lex('[Obsolete] class C {}');

    expect(tokens.map((t) => t.type)).toEqual(['[', 'identifier', ']', 'class', 'identifier', '{', '}', 'end']);
  });

  it('tokenizes assembly attribute', () => {
    const { tokens } = lex('[assembly: CLSCompliant(true)]');

    expect(tokens.map((t) => t.type)).toEqual(['[', 'identifier', ':', 'identifier', '(', 'boolean_literal', ')', ']', 'end']);
  });

  it('tokenizes generic type parameter list', () => {
    const { tokens } = lex('class C<T> { }');

    expect(tokens.map((t) => t.type)).toEqual(['class', 'identifier', '<', 'identifier', '>', '{', '}', 'end']);
  });

  it('tokenizes multiple type parameters', () => {
    const { tokens } = lex('class C<TKey, TValue> { }');

    expect(tokens.filter((t) => t.type === 'identifier')).toHaveLength(3);
  });

  it('tokenizes constraints (where is contextual)', () => {
    const { tokens } = lex('class C<T> where T : class { }');

    // 'where' is a contextual keyword, lexed as identifier; so is the type parameter T
    expect(tokens.filter((t) => t.type === 'identifier')).toHaveLength(4);
    expect(tokens.filter((t) => t.type === 'class')).toHaveLength(2);
  });

  it('tokenizes lambda expression', () => {
    const { tokens } = lex('Func<int> f = () => 42;');

    expect(tokens.filter((t) => t.type === '=>')).toHaveLength(1);
  });

  it('tokenizes expression-bodied member', () => {
    const { tokens } = lex('int Get() => 42;');

    expect(tokens.filter((t) => t.type === '=>')).toHaveLength(1);
  });

  it('tokenizes property with get/set', () => {
    const { tokens } = lex('int P { get; set; }');

    expect(tokens.filter((t) => t.type === 'identifier')).toHaveLength(3);
  });

  it('tokenizes string with escaped quotes', () => {
    const { tokens } = lex('string s = "say \\"hi\\"";');

    expect(tokens.filter((t) => t.type === 'string_literal')).toHaveLength(1);
  });

  it('tokenizes string with newline escape', () => {
    const { tokens } = lex('string s = "line\\nnext";');

    expect(tokens.filter((t) => t.type === 'string_literal')).toHaveLength(1);
  });

  it('tokenizes char with escape', () => {
    const { tokens } = lex("char c = '\\n';");

    expect(tokens.filter((t) => t.type === 'character_literal')).toHaveLength(1);
  });

  it('tokenizes empty char literal as invalid', () => {
    const { tokens } = lex("char c = '';");

    // Should still tokenize something
    expect(tokens.length).toBeGreaterThan(1);
  });

  it('tokenizes interpolated string with format specifier', () => {
    const { tokens } = lex('string s = $"{x:0.00}";');

    expect(tokens.filter((t) => t.type === 'interpolated_string_expression')).toHaveLength(1);
  });

  it('tokenizes raw string with extra quotes', () => {
    const { tokens } = lex('string s = """"four"""";');

    expect(tokens.filter((t) => t.type === 'raw_string_literal')).toHaveLength(1);
  });

  it('tokenizes verbatim interpolated string', () => {
    const { tokens } = lex('string s = $@"path {x}";');

    expect(tokens.filter((t) => t.type === 'interpolated_string_expression')).toHaveLength(1);
  });

  it('handles multiple preprocessor directives', () => {
    const { trivia } = lex('#if DEBUG\nclass C {}\n#endif\n#pragma warning disable');

    expect(trivia).toHaveLength(3);
    expect(trivia[0].type).toBe('preproc_if');
    expect(trivia[1].type).toBe('preproc_endif');
    expect(trivia[2].type).toBe('preproc_pragma');
  });

  it('handles #region with name', () => {
    const { trivia } = lex('#region My Region\nclass C {}\n#endregion My Region');

    expect(trivia[0].type).toBe('preproc_region');
    expect(trivia[1].type).toBe('preproc_endregion');
  });

  it('handles #nullable directive', () => {
    const { trivia } = lex('#nullable enable');

    expect(trivia[0].type).toBe('preproc_nullable');
  });

  it('handles #define directive', () => {
    const { trivia } = lex('#define DEBUG');

    expect(trivia[0].type).toBe('preproc_define');
  });

  it('handles #error directive', () => {
    const { trivia } = lex('#error Something went wrong');

    expect(trivia[0].type).toBe('preproc_error');
  });

  it('handles #warning directive', () => {
    const { trivia } = lex('#warning Deprecated');

    expect(trivia[0].type).toBe('preproc_warning');
  });

  it('handles #line directive', () => {
    const { trivia } = lex('#line 100 "file.cs"');

    expect(trivia[0].type).toBe('preproc_line');
  });

  it('handles #elif directive', () => {
    const { trivia } = lex('#if A\n#elif B\n#endif');

    expect(trivia[0].type).toBe('preproc_if');
    expect(trivia[1].type).toBe('preproc_elif');
  });

  it('handles #else directive', () => {
    const { trivia } = lex('#if A\n#else\n#endif');

    expect(trivia[0].type).toBe('preproc_if');
    expect(trivia[1].type).toBe('preproc_else');
  });

  it('handles #undef directive', () => {
    const { trivia } = lex('#undef DEBUG');

    expect(trivia[0].type).toBe('preproc_undef');
  });

  it('handles number with underscore separator', () => {
    const { tokens } = lex('int x = 1_000_000;');

    expect(tokens.filter((t) => t.type === 'integer_literal')).toHaveLength(1);
  });

  it('handles hex with underscore', () => {
    const { tokens } = lex('int x = 0xFF_FF;');

    expect(tokens.filter((t) => t.type === 'integer_literal')).toHaveLength(1);
  });

  it('handles negative exponent', () => {
    const { tokens } = lex('double d = 1e-10;');

    expect(tokens.filter((t) => t.type === 'real_literal')).toHaveLength(1);
  });

  it('handles positive exponent with sign', () => {
    const { tokens } = lex('double d = 1e+10;');

    expect(tokens.filter((t) => t.type === 'real_literal')).toHaveLength(1);
  });

  it('handles decimal suffix', () => {
    const { tokens } = lex('decimal d = 1.5m;');

    expect(tokens.filter((t) => t.type === 'real_literal')).toHaveLength(1);
  });

  it('handles double suffix', () => {
    const { tokens } = lex('double d = 1.5d;');

    expect(tokens.filter((t) => t.type === 'real_literal')).toHaveLength(1);
  });

  it('handles long suffix', () => {
    const { tokens } = lex('long l = 42l;');

    expect(tokens.filter((t) => t.type === 'integer_literal')).toHaveLength(1);
  });

  it('handles ulong suffix', () => {
    const { tokens } = lex('ulong ul = 42UL;');

    expect(tokens.filter((t) => t.type === 'integer_literal')).toHaveLength(1);
  });

  it('handles uint suffix', () => {
    const { tokens } = lex('uint u = 42u;');

    expect(tokens.filter((t) => t.type === 'integer_literal')).toHaveLength(1);
  });

  it('handles unicode identifiers', () => {
    const { tokens } = lex('int ütf8;');

    expect(tokens[1].type).toBe('identifier');
  });

  it('handles form feed and vertical tab as whitespace', () => {
    const { tokens } = lex('class\fC\v{\n}');

    expect(tokens.map((t) => t.type)).toEqual(['class', 'identifier', '{', '}', 'end']);
  });

  it('handles \r\n line endings', () => {
    const { tokens } = lex('class C\r\n{\r\n}');

    expect(tokens.map((t) => t.type)).toEqual(['class', 'identifier', '{', '}', 'end']);
  });

  it('handles \r line endings', () => {
    const { tokens } = lex('class C\r{\r}');

    expect(tokens.map((t) => t.type)).toEqual(['class', 'identifier', '{', '}', 'end']);
  });
});
