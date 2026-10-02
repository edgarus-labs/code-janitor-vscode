/**
 * Low-level scanning of Razor text. Every function returns `-1` when the text is not well formed
 * (an unterminated string, tag, element or block): callers then leave that part of the document
 * exactly as authored.
 */

const IDENTIFIER_START = /[\p{L}_]/u;
const IDENTIFIER_PART = /[\p{L}\p{Nd}_]/u;

export function isIdentifierStart(c: string | undefined): boolean {
  return c !== undefined && IDENTIFIER_START.test(c);
}

export function isIdentifierPart(c: string | undefined): boolean {
  return c !== undefined && IDENTIFIER_PART.test(c);
}

function isWhitespace(c: string | undefined): boolean {
  return c !== undefined && /\s/.test(c);
}

/** HTML elements without an end tag. Components (`<Input>`) are never void: they are written `<Input />`. */
const VOID_ELEMENTS: Record<string, true> = {
  area: true,
  base: true,
  br: true,
  col: true,
  embed: true,
  hr: true,
  img: true,
  input: true,
  link: true,
  meta: true,
  param: true,
  source: true,
  track: true,
  wbr: true,
};

/** Elements whose content is not markup, or whose whitespace is significant. */
export function isVerbatimElement(name: string): boolean {
  return /^(?:script|style|pre|textarea)$/i.test(name);
}

const TAG_NAME = /<([A-Za-z][\w:.-]*)/y;
const CLOSE_TAG = /<\/([A-Za-z][\w:.-]*)\s*>/y;

/** Index of the first non-whitespace character at or after `index` (the text length when none). */
export function skipWhitespace(text: string, index: number): number {
  let i = index;
  while (i < text.length && isWhitespace(text[i])) {
    i++;
  }

  return i;
}

/** The index after the string literal starting at `index` (a `"`), or -1. */
export function skipString(text: string, index: number): number {
  let quotes = 0;
  while (text[index + quotes] === '"') {
    quotes++;
  }

  if (quotes >= 3) {
    const end = text.indexOf('"'.repeat(quotes), index + quotes);

    return end < 0 ? -1 : end + quotes;
  }

  const prefix = text.slice(Math.max(0, index - 2), index);
  const verbatim = prefix.endsWith('@') || prefix === '$@' || prefix === '@$';
  const interpolated = prefix.endsWith('$') || prefix === '$@' || prefix === '@$';
  for (let i = index + 1; i < text.length; i++) {
    const c = text[i];
    if (verbatim) {
      if (c === '"' && text[i + 1] === '"') {
        i++;
      } else if (c === '"') {
        return i + 1;
      } else if (interpolated && c === '{' && text[i + 1] !== '{') {
        i = skipInterpolationHole(text, i);
        if (i < 0) {
          return -1;
        }
      } else if (interpolated && (c === '{' || c === '}') && text[i + 1] === c) {
        i++;
      }

      continue;
    }

    if (c === '\\') {
      i++;
    } else if (c === '\n') {
      return -1;
    } else if (c === '"') {
      return i + 1;
    } else if (interpolated && c === '{' && text[i + 1] === '{') {
      i++;
    } else if (interpolated && c === '{') {
      i = skipInterpolationHole(text, i);
      if (i < 0) {
        return -1;
      }
    }
  }

  return -1;
}

/** Index of the `}` closing the interpolation hole that opens at `index`, or -1. */
function skipInterpolationHole(text: string, index: number): number {
  let depth = 0;
  for (let i = index; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      i = skipString(text, i) - 1;
      if (i < 0) {
        return -1;
      }
    } else if (c === '{') {
      depth++;
    } else if (c === '}' && --depth === 0) {
      return i;
    }
  }

  return -1;
}

/** The index after the character literal starting at `index` (a `'`), or -1. */
function skipCharLiteral(text: string, index: number): number {
  for (let i = index + 1; i < Math.min(text.length, index + 12); i++) {
    if (text[i] === '\\') {
      i++;
    } else if (text[i] === '\n') {
      return -1;
    } else if (text[i] === "'") {
      return i + 1;
    }
  }

  return -1;
}

/** The index after the comment starting at `index` (`//` or `/*`), or -1; `index` when there is no comment. */
function skipCSharpComment(text: string, index: number): number {
  if (text[index] !== '/') {
    return index;
  }

  if (text[index + 1] === '/') {
    const end = text.indexOf('\n', index);

    return end < 0 ? text.length : end;
  }

  if (text[index + 1] === '*') {
    const end = text.indexOf('*/', index + 2);

    return end < 0 ? -1 : end + 2;
  }

  return index;
}

/** The index of the bracket closing the one at `open`, reading the text in between as C#; -1 when unbalanced. */
export function findClosingBracket(text: string, open: number): number {
  const opener = text[open];
  const closer = opener === '(' ? ')' : opener === '[' ? ']' : '}';
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      i = skipString(text, i) - 1;
    } else if (c === "'") {
      i = skipCharLiteral(text, i) - 1;
    } else if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      i = skipCSharpComment(text, i) - 1;
    } else if (c === opener) {
      depth++;
    } else if (c === closer && --depth === 0) {
      return i;
    }

    if (i < -1) {
      return -1;
    }
  }

  return -1;
}

/**
 * The index of the `>` ending the tag that starts at `start` (a `<`), or -1. Quoted attribute
 * values and Razor expressions (`@Assets["app.css"]`, `@(a > b)`) are skipped, so their quotes and
 * `>` never end the tag.
 */
export function findTagEnd(text: string, start: number): number {
  let quote = '';
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '@') {
      const after = skipExpression(text, i);
      if (after < 0) {
        return -1;
      }

      i = after - 1;
    } else if (quote) {
      if (c === quote) {
        quote = '';
      }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i;
    }
  }

  return -1;
}

/**
 * The index after the implicit Razor expression at `index` (an `@`): `@name`, `@a.b[1](x)`,
 * `@(expression)`, `@@`. An `@` that starts no expression ends at itself; -1 when a bracket never closes.
 */
export function skipExpression(text: string, index: number): number {
  let i = index + 1;
  if (i >= text.length || text[i] === '@') {
    return Math.min(i + 1, text.length);
  }

  if (text[i] === '(') {
    const close = findClosingBracket(text, i);
    if (close < 0) {
      return -1;
    }

    i = close + 1;
  } else if (isIdentifierStart(text[i])) {
    while (isIdentifierPart(text[i])) {
      i++;
    }
  } else {
    return i;
  }

  while (i < text.length) {
    if (text[i] === '[' || text[i] === '(') {
      const close = findClosingBracket(text, i);
      if (close < 0) {
        return -1;
      }

      i = close + 1;
    } else if (text[i] === '.' && isIdentifierStart(text[i + 1])) {
      i += 2;
      while (isIdentifierPart(text[i])) {
        i++;
      }
    } else {
      break;
    }
  }

  return i;
}

/** True when `text` has the word `word` at `index` and no identifier character continues it. */
export function hasWordAt(text: string, index: number, word: string): boolean {
  return text.startsWith(word, index) && !isIdentifierPart(text[index + word.length]) && !isIdentifierPart(text[index - 1]);
}

/** The index after the element starting at `start` (a `<`), or -1 when it is not closed. */
export function skipElement(text: string, start: number): number {
  if (text.startsWith('<!--', start)) {
    const end = text.indexOf('-->', start + 4);

    return end < 0 ? -1 : end + 3;
  }

  TAG_NAME.lastIndex = start;
  const match = TAG_NAME.exec(text);
  if (!match) {
    return -1;
  }

  const tagEnd = findTagEnd(text, start);
  if (tagEnd < 0) {
    return -1;
  }

  const afterTag = skipOpenTag(text, match[1], tagEnd);
  if (afterTag.closed) {
    return afterTag.next;
  }

  const stack = [match[1].toLowerCase()];
  let i = afterTag.next;
  while (i < text.length) {
    const next = nextMarker(text, i);
    if (next < 0) {
      return -1;
    }

    i = next;
    if (text[i] === '@') {
      i = skipTransition(text, i);
      if (i < 0) {
        return -1;
      }

      continue;
    }

    if (text.startsWith('<!--', i) || text.startsWith('<![CDATA[', i)) {
      const terminator = text.startsWith('<!--', i) ? '-->' : ']]>';
      const end = text.indexOf(terminator, i + 4);
      if (end < 0) {
        return -1;
      }

      i = end + terminator.length;
    } else if (text[i + 1] === '/') {
      CLOSE_TAG.lastIndex = i;
      const close = CLOSE_TAG.exec(text);
      if (!close) {
        i++;
        continue;
      }

      const at = stack.lastIndexOf(close[1].toLowerCase());
      if (at < 0) {
        return -1;
      }

      stack.length = at;
      i += close[0].length;
      if (stack.length === 0) {
        return i;
      }
    } else {
      TAG_NAME.lastIndex = i;
      const open = TAG_NAME.exec(text);
      if (!open) {
        i++;
        continue;
      }

      const end = findTagEnd(text, i);
      if (end < 0) {
        return -1;
      }

      const opened = skipOpenTag(text, open[1], end);
      if (!opened.closed) {
        stack.push(open[1].toLowerCase());
      } else if (opened.next < 0) {
        return -1;
      }

      i = opened.next;
    }
  }

  return -1;
}

/** The next `<` or `@` at or after `index`, or -1. */
function nextMarker(text: string, index: number): number {
  for (let i = index; i < text.length; i++) {
    if (text[i] === '<' || text[i] === '@') {
      return i;
    }
  }

  return -1;
}

/**
 * What follows an opening tag ending at `tagEnd`: `closed` when the tag has no content to read
 * (self-closing, void, or a script/style element whose content was skipped); `next` is -1 when such a
 * verbatim element is never closed.
 */
function skipOpenTag(text: string, name: string, tagEnd: number): { closed: boolean; next: number } {
  if (text[tagEnd - 1] === '/' || (name === name.toLowerCase() && VOID_ELEMENTS[name] === true)) {
    return { closed: true, next: tagEnd + 1 };
  }

  if (/^(?:script|style)$/i.test(name)) {
    const close = new RegExp(`</${name}\\s*>`, 'i').exec(text.slice(tagEnd + 1));

    return { closed: true, next: close ? tagEnd + 1 + close.index + close[0].length : -1 };
  }

  return { closed: false, next: tagEnd + 1 };
}

/** Keywords after `@` that open a block with a parenthesized header. */
const PARENTHESIZED = ['if', 'for', 'foreach', 'while', 'switch', 'lock', 'using'];

/**
 * The index after the Razor construct starting at `index` (an `@`): escape, comment, code block,
 * `@:` line, `@<` template, control structure with its `else`/`catch`/`finally` chain, or an
 * implicit expression. -1 when it is not well formed.
 */
export function skipTransition(text: string, index: number): number {
  const next = text[index + 1];
  if (next === '@') {
    return index + 2;
  }

  if (next === '*') {
    const end = text.indexOf('*@', index + 2);

    return end < 0 ? -1 : end + 2;
  }

  if (next === '{') {
    const close = findCodeBlockEnd(text, index + 1);

    return close < 0 ? -1 : close + 1;
  }

  if (next === ':') {
    const end = text.indexOf('\n', index);

    return end < 0 ? text.length : end;
  }

  if (next === '<') {
    return skipElement(text, index + 1);
  }

  if (isIdentifierStart(next)) {
    let end = index + 1;
    while (isIdentifierPart(text[end])) {
      end++;
    }

    const control = skipControl(text, end, text.slice(index + 1, end));
    if (control !== undefined) {
      return control;
    }
  }

  return skipExpression(text, index);
}

/** After the keyword `word` (ending at `end`): the end of its block chain, -1 when broken, `undefined` when `word` opens none. */
function skipControl(text: string, end: number, word: string): number | undefined {
  let i = skipWhitespace(text, end);
  if (PARENTHESIZED.includes(word) || (word === 'else' && hasWordAt(text, i, 'if')) || word === 'catch') {
    if (word === 'else') {
      i = skipWhitespace(text, i + 2);
    }

    if (text[i] === '(') {
      const close = findClosingBracket(text, i);
      if (close < 0) {
        return -1;
      }

      i = skipWhitespace(text, close + 1);
      if (word === 'catch' && hasWordAt(text, i, 'when')) {
        i = skipWhitespace(text, i + 4);
        const filterEnd = text[i] === '(' ? findClosingBracket(text, i) : -1;
        if (filterEnd < 0) {
          return -1;
        }

        i = skipWhitespace(text, filterEnd + 1);
      }
    } else if (word !== 'catch') {
      return undefined;
    }
  } else if (!['code', 'functions', 'try', 'finally', 'else', 'do', 'section'].includes(word)) {
    return undefined;
  } else if (word === 'section') {
    while (isIdentifierPart(text[i])) {
      i++;
    }

    i = skipWhitespace(text, i);
  }

  const afterBlock = skipBlockAt(text, i);
  if (afterBlock <= 0) {
    return text[i] === '{' ? -1 : undefined;
  }

  return skipChain(text, afterBlock, word);
}

/** The index after the block opening at `index` (a `{`), or -1; `undefined`-like 0 when there is no block. */
function skipBlockAt(text: string, index: number): number {
  if (text[index] !== '{') {
    return 0;
  }

  const close = findCodeBlockEnd(text, index);

  return close < 0 ? -1 : close + 1;
}

/** Follows `else` / `else if` / `catch` / `finally` (with or without `@`) and `do ... while (...)` after a block. */
function skipChain(text: string, afterBlock: number, word: string): number {
  let end = afterBlock;
  for (;;) {
    let i = skipWhitespace(text, end);
    if (text[i] === '@' && /^@(?:else|catch|finally)\b/.test(text.slice(i, i + 9))) {
      i++;
    }

    const follow = ['if', 'else'].includes(word) ? ['else'] : ['try', 'catch', 'finally'].includes(word) ? ['catch', 'finally'] : word === 'do' ? ['while'] : [];
    const keyword = follow.find((candidate) => hasWordAt(text, i, candidate));
    if (!keyword) {
      return end;
    }

    if (keyword === 'while') {
      // `do { } while (condition);` has no block after the condition.
      const open = skipWhitespace(text, i + keyword.length);
      const close = text[open] === '(' ? findClosingBracket(text, open) : -1;
      if (close < 0) {
        return -1;
      }

      const semicolon = skipWhitespace(text, close + 1);

      return text[semicolon] === ';' ? semicolon + 1 : close + 1;
    }

    const next = skipControl(text, i + keyword.length, keyword);
    if (next === undefined || next < 0) {
      return next === undefined ? end : -1;
    }

    end = next;
    word = keyword === 'else' ? 'else' : keyword;
  }
}

/**
 * The index of the `}` closing the block opening at `open` (a `{`), or -1. The content is C# with
 * markup in it: an element at the start of a statement is skipped as a whole, so braces and quotes
 * in its text never count.
 */
export function findCodeBlockEnd(text: string, open: number): number {
  let depth = 0;
  let statementStart = true;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    let next = i;
    if (c === '"') {
      next = skipString(text, i) - 1;
      statementStart = false;
    } else if (c === "'") {
      next = skipCharLiteral(text, i) - 1;
      statementStart = false;
    } else if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      next = skipCSharpComment(text, i) - 1;
    } else if (c === '@' && (text[i + 1] === '*' || text[i + 1] === ':' || text[i + 1] === '<')) {
      next = skipTransition(text, i) - 1;
      statementStart = true;
    } else if (c === '<' && statementStart && (isIdentifierStart(text[i + 1]) || text.startsWith('<!--', i))) {
      next = skipElement(text, i) - 1;
    } else if (c === '{') {
      depth++;
      statementStart = true;
    } else if (c === '}') {
      statementStart = true;
      if (--depth === 0) {
        return i;
      }
    } else if (c === ';' || c === ':') {
      statementStart = true;
    } else if (!isWhitespace(c)) {
      statementStart = false;
    }

    if (next < i - 1) {
      return -1;
    }

    i = next;
  }

  return -1;
}
