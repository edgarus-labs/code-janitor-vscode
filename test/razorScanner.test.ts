import { describe, expect, it } from 'vitest';
import {
  findClosingBracket,
  findCodeBlockEnd,
  findTagEnd,
  hasWordAt,
  isVerbatimElement,
  skipElement,
  skipExpression,
  skipString,
  skipTransition,
  skipWhitespace,
} from '../src/razor/razorScanner';

/** Index just after the first occurrence of `marker`, or -1 when it is absent. */
const after = (text: string, marker: string): number => {
  const at = text.indexOf(marker);

  return at < 0 ? -1 : at + marker.length;
};

describe('skipString', () => {
  it('ends a regular string at its closing quote and honors escapes', () => {
    const text = '"a\\"b" tail';

    expect(skipString(text, 0)).toBe(after(text, 'b"'));
  });

  it('does not run past a line break in a regular string', () => {
    expect(skipString('"open\nnext"', 0)).toBe(-1);
  });

  it('reads a verbatim string with doubled quotes and line breaks', () => {
    const text = '@"a "" b\nc" tail';

    expect(skipString(text, 1)).toBe(after(text, 'c"'));
  });

  it('reads a raw string literal up to the matching run of quotes', () => {
    const text = '"""\nsay "" and { \n""" tail';

    expect(skipString(text, 0)).toBe(after(text, '\n"""'));
  });

  it('reports an unterminated raw string', () => {
    expect(skipString('"""never closed', 0)).toBe(-1);
  });

  it('skips interpolation holes, including strings and braces inside them', () => {
    const text = '$"x {(a ? "}" : "{")} y {{z}}" tail';

    expect(skipString(text, 1)).toBe(after(text, '{{z}}"'));
  });

  it('reads an interpolated verbatim string in either prefix order', () => {
    const dollarFirst = '$@"a {x} "" b" tail';
    const atFirst = '@$"a {x} "" b" tail';

    expect(skipString(dollarFirst, 2)).toBe(after(dollarFirst, 'b"'));
    expect(skipString(atFirst, 2)).toBe(after(atFirst, 'b"'));
  });

  it('keeps doubled braces literal in an interpolated verbatim string', () => {
    const text = '$@"{{x}} y" tail';

    expect(skipString(text, 2)).toBe(after(text, 'y"'));
  });

  it('reports an interpolation hole that never closes', () => {
    expect(skipString('$"{open', 1)).toBe(-1);
    expect(skipString('$@"{open', 2)).toBe(-1);
    expect(skipString('$"{ "str', 1)).toBe(-1);
  });

  it('reports a string that never ends', () => {
    expect(skipString('@"open', 1)).toBe(-1);
    expect(skipString('"open', 0)).toBe(-1);
  });
});

describe('findClosingBracket', () => {
  it('matches nested brackets of the opening kind', () => {
    const text = '(a(b)c) d';

    expect(findClosingBracket(text, 0)).toBe(text.indexOf(')', 5));
  });

  it('ignores brackets in strings, char literals and comments', () => {
    const text = '{ "}" \'}\' /* } */ // }\n }';

    expect(findClosingBracket(text, 0)).toBe(text.length - 1);
  });

  it('handles square brackets', () => {
    const text = '[a[1]]';

    expect(findClosingBracket(text, 0)).toBe(5);
  });

  it('returns -1 for unbalanced text and for unterminated literals', () => {
    expect(findClosingBracket('(a', 0)).toBe(-1);
    expect(findClosingBracket('( "open', 0)).toBe(-1);
    expect(findClosingBracket("( 'o\n)", 0)).toBe(-1);
    expect(findClosingBracket('( /* never', 0)).toBe(-1);
  });
});

describe('findTagEnd', () => {
  it('finds the end of a simple tag', () => {
    const text = '<div class="a>b" id=\'c>d\'> tail';

    expect(findTagEnd(text, 0)).toBe(text.indexOf('> tail'));
  });

  it('skips Razor expressions inside the tag', () => {
    const text = '<a href="@Assets["app.css"]" title=@(a > b)> tail';

    expect(findTagEnd(text, 0)).toBe(text.indexOf('> tail'));
  });

  it('returns -1 when the tag or an expression is never closed', () => {
    expect(findTagEnd('<div class="a"', 0)).toBe(-1);
    expect(findTagEnd('<div @(a', 0)).toBe(-1);
  });
});

describe('skipExpression', () => {
  it('reads an implicit expression with member access, indexers and calls', () => {
    const text = '@a.b[1](x).c rest';

    expect(skipExpression(text, 0)).toBe(after(text, '.c'));
  });

  it('reads an explicit expression', () => {
    const text = '@(a > (b)) rest';

    expect(skipExpression(text, 0)).toBe(after(text, '(b))'));
  });

  it('treats @@ as an escape and a trailing @ as nothing', () => {
    expect(skipExpression('@@x', 0)).toBe(2);
    expect(skipExpression('@', 0)).toBe(1);
  });

  it('returns -1 for an explicit expression that never closes', () => {
    expect(skipExpression('@(a', 0)).toBe(-1);
  });

  it('ends at the @ when no expression follows', () => {
    expect(skipExpression('@ x', 0)).toBe(1);
  });
});

describe('small helpers', () => {
  it('finds whole words only', () => {
    expect(hasWordAt('else if', 0, 'else')).toBe(true);
    expect(hasWordAt('elsewhere', 0, 'else')).toBe(false);
    expect(hasWordAt('xelse', 1, 'else')).toBe(false);
  });

  it('skips whitespace including line breaks', () => {
    expect(skipWhitespace('  \r\n\t x', 0)).toBe(6);
  });

  it('knows the elements whose content is never formatted', () => {
    expect(isVerbatimElement('pre')).toBe(true);
    expect(isVerbatimElement('SCRIPT')).toBe(true);
    expect(isVerbatimElement('div')).toBe(false);
  });
});

describe('skipElement', () => {
  it('skips nested elements as a whole', () => {
    const text = '<div><p>a</p><span>b</span></div> tail';

    expect(skipElement(text, 0)).toBe(after(text, '</div>'));
  });

  it('skips self-closing and void elements without content', () => {
    expect(skipElement('<br> tail', 0)).toBe(4);
    expect(skipElement('<Comp a="1" /> tail', 0)).toBe(after('<Comp a="1" /> tail', '/>'));
  });

  it('skips HTML comments and CDATA inside an element', () => {
    const text = '<div><!-- </div> --><![CDATA[ </div> ]]></div> tail';

    expect(skipElement(text, 0)).toBe(after(text, ']]></div>'));
  });

  it('skips a standalone comment', () => {
    const text = '<!-- a --> tail';

    expect(skipElement(text, 0)).toBe(after(text, '-->'));
    expect(skipElement('<!-- never', 0)).toBe(-1);
  });

  it('skips script and style content without reading it', () => {
    const text = '<script>if (a < b) { x = "</p>"; }</script> tail';

    expect(skipElement(text, 0)).toBe(after(text, '</script>'));
    expect(skipElement('<style>.a > .b {}</style> tail', 0)).toBe(after('<style>.a > .b {}</style> tail', '</style>'));
  });

  it('reports a script that is never closed', () => {
    expect(skipElement('<script>var a;', 0)).toBe(-1);
  });

  it('reads Razor transitions inside an element', () => {
    const text = '<div>@if (a) { <b>x</b> } @(1) </div> tail';

    expect(skipElement(text, 0)).toBe(after(text, '</div>'));
  });

  it('closes unclosed inner elements when an outer closing tag arrives', () => {
    const text = '<ul><li>a<li>b</ul> tail';

    expect(skipElement(text, 0)).toBe(after(text, '</ul>'));
  });

  it('returns -1 for a closing tag that matches nothing open', () => {
    expect(skipElement('<div></span>', 0)).toBe(-1);
  });

  it('ignores a stray closing marker that is not a tag', () => {
    expect(skipElement('<div></ x></div>', 0)).toBe('<div></ x></div>'.length);
  });

  it('returns -1 for text that is not an element, an unclosed tag or an unclosed element', () => {
    expect(skipElement('< x>', 0)).toBe(-1);
    expect(skipElement('<div class="a', 0)).toBe(-1);
    expect(skipElement('<div><p>a</p>', 0)).toBe(-1);
    expect(skipElement('<div><p class="a</div>', 0)).toBe(-1);
    expect(skipElement('<div><!-- open</div>', 0)).toBe(-1);
    expect(skipElement('<div>@(a</div>', 0)).toBe(-1);
  });

  it('returns -1 when a nested script is never closed', () => {
    expect(skipElement('<div><script>x</div>', 0)).toBe(-1);
  });

  it('treats a bare < in text as plain text', () => {
    expect(skipElement('<div>a < b</div> tail', 0)).toBe(after('<div>a < b</div> tail', '</div>'));
  });
});

describe('skipTransition', () => {
  it('skips @@, Razor comments, @: lines and templates', () => {
    expect(skipTransition('@@ rest', 0)).toBe(2);
    expect(skipTransition('@* c } *@ rest', 0)).toBe(after('@* c } *@ rest', '*@'));
    expect(skipTransition('@: text } \nnext', 0)).toBe('@: text } '.length);
    expect(skipTransition('@: last line', 0)).toBe('@: last line'.length);
    expect(skipTransition('@<p>x</p> rest', 0)).toBe(after('@<p>x</p> rest', '</p>'));
  });

  it('reports an unterminated Razor comment, code block or template', () => {
    expect(skipTransition('@* open', 0)).toBe(-1);
    expect(skipTransition('@{ open', 0)).toBe(-1);
    expect(skipTransition('@<p>open', 0)).toBe(-1);
  });

  it('skips a code block with its markup, strings and comments', () => {
    const text = '@{ var s = "}"; // }\n <p>} {</p> } tail';

    expect(skipTransition(text, 0)).toBe(after(text, '</p> }'));
  });

  it('follows if / else if / else chains, with or without @ on the continuation', () => {
    const text = '@if (a) { x } else if (b) { y } @else { z } tail';

    expect(skipTransition(text, 0)).toBe(after(text, '{ z }'));
  });

  it('follows try / catch / finally chains and catch filters', () => {
    const text = '@try { a } catch (E e) when (e.X > 0) { b } catch { c } finally { d } tail';

    expect(skipTransition(text, 0)).toBe(after(text, '{ d }'));
  });

  it('follows do / while and lock / using / switch / for / foreach / while', () => {
    const doWhile = '@do { a } while (b); tail';

    expect(skipTransition(doWhile, 0)).toBe(after(doWhile, ');'));
    expect(skipTransition('@do { a } while (b) tail', 0)).toBe('@do { a } while (b)'.length);
    for (const keyword of ['lock', 'using', 'switch', 'for', 'foreach', 'while', 'if']) {
      const text = `@${keyword} (x) { y } tail`;

      expect(skipTransition(text, 0), keyword).toBe(after(text, '{ y }'));
    }
  });

  it('reads @code, @functions and @section blocks', () => {
    for (const text of ['@code { int a; } tail', '@functions { int a; } tail', '@section Scripts { <p/> } tail']) {
      expect(skipTransition(text, 0), text).toBe(text.lastIndexOf('}') + 1);
    }
  });

  it('treats a keyword without a block as an implicit expression', () => {
    expect(skipTransition('@if rest', 0)).toBe('@if'.length);
    expect(skipTransition('@code rest', 0)).toBe('@code'.length);
    expect(skipTransition('@name.Value rest', 0)).toBe('@name.Value'.length);
  });

  it('reports broken control headers and chains', () => {
    expect(skipTransition('@if (a { x }', 0)).toBe(-1);
    expect(skipTransition('@if (a) { open', 0)).toBe(-1);
    expect(skipTransition('@if (a) { x } else { open', 0)).toBe(-1);
    expect(skipTransition('@try { a } catch (E e) when e { b }', 0)).toBe(-1);
    expect(skipTransition('@try { a } catch (E e) when (e { b }', 0)).toBe(-1);
    expect(skipTransition('@try { a } catch (E e { b }', 0)).toBe(-1);
    expect(skipTransition('@do { a } while b;', 0)).toBe(-1);
  });

  it('ends a chain at a keyword that opens no block', () => {
    expect(skipTransition('@if (a) { x } else rest', 0)).toBe('@if (a) { x }'.length);
  });
});

describe('findCodeBlockEnd', () => {
  it('finds the closing brace of nested blocks', () => {
    const text = '{ if (a) { b(); } else { c(); } } tail';

    expect(findCodeBlockEnd(text, 0)).toBe(text.indexOf('} tail'));
  });

  it('ignores braces in strings, char literals and comments', () => {
    const text = '{ var a = "}"; var b = \'}\'; /* } */ // }\n }';

    expect(findCodeBlockEnd(text, 0)).toBe(text.length - 1);
  });

  it('skips an element at the start of a statement as a whole', () => {
    const text = '{ <p>} " {</p> var x = 1; }';

    expect(findCodeBlockEnd(text, 0)).toBe(text.length - 1);
  });

  it('does not take a generic or comparison < for markup', () => {
    const text = '{ var a = b < c; var d = List<int>.Empty; }';

    expect(findCodeBlockEnd(text, 0)).toBe(text.length - 1);
  });

  it('reads @: lines, @* *@ comments and templates inside a block', () => {
    const text = '{ @: text } here\n @* } *@ var t = @<b>}</b>; }';

    expect(findCodeBlockEnd(text, 0)).toBe(text.length - 1);
  });

  it('starts a statement after ; and : and braces, and skips HTML comments there', () => {
    const text = '{ a(); <!-- } --> case 1: <p>}</p> }';

    expect(findCodeBlockEnd(text, 0)).toBe(text.length - 1);
  });

  it('returns -1 for unbalanced blocks and unterminated literals', () => {
    expect(findCodeBlockEnd('{ a', 0)).toBe(-1);
    expect(findCodeBlockEnd('{ "open', 0)).toBe(-1);
    expect(findCodeBlockEnd("{ 'o\n }", 0)).toBe(-1);
    expect(findCodeBlockEnd('{ /* open', 0)).toBe(-1);
    expect(findCodeBlockEnd('{ @* open', 0)).toBe(-1);
    expect(findCodeBlockEnd('{ <p>open', 0)).toBe(-1);
  });
});
