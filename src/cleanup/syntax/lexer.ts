/**
 * C# tokenizer. Pure TypeScript, no external runtime: it turns source text into a flat token list
 * plus the trivia (comments and preprocessor directives) that the parser re-attaches to the tree.
 *
 * Token `type` values are chosen to match the node names the transformations expect, so keywords
 * and punctuation carry their own text as their type (`class`, `{`, `==`) while literals and
 * identifiers get grammar names (`identifier`, `string_literal`, `null_literal`).
 */

export interface Token {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly isNamed: boolean;
}

export interface LexResult {
  /** Everything the parser consumes, terminated by a single `end` token. */
  readonly tokens: Token[];
  /** Comments and preprocessor directives, in source order. */
  readonly trivia: Token[];
}

export const PREDEFINED_TYPES = new Set([
  'bool',
  'byte',
  'char',
  'decimal',
  'double',
  'float',
  'int',
  'long',
  'nint',
  'nuint',
  'object',
  'sbyte',
  'short',
  'string',
  'uint',
  'ulong',
  'ushort',
  'void',
]);

const KEYWORDS = new Set([
  'abstract', 'as', 'base', 'break', 'case', 'catch', 'checked', 'class', 'const', 'continue',
  'default', 'delegate', 'do', 'else', 'enum', 'event', 'explicit', 'extern', 'finally', 'fixed',
  'for', 'foreach', 'goto', 'if', 'implicit', 'in', 'interface', 'internal', 'is', 'lock',
  'namespace', 'new', 'operator', 'out', 'override', 'params', 'private', 'protected', 'public',
  'readonly', 'ref', 'return', 'sealed', 'sizeof', 'stackalloc', 'static', 'struct', 'switch',
  'this', 'throw', 'try', 'typeof', 'unchecked', 'unsafe', 'using', 'virtual', 'volatile', 'while',
]);

// Longest first, so that `>>=` never lexes as `>` `>=`. `>` is deliberately never combined with a
// following `>`: closing nested generics (`List<List<int>>`) must stay two separate tokens.
const PUNCTUATORS = [
  '<<=',
  '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '::', '++', '--',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '->', '..',
  '+', '-', '*', '/', '%', '=', '<', '>', '!', '&', '|', '^', '~', '?', ':',
  ';', ',', '.', '(', ')', '[', ']', '{', '}',
];

const PREPROC_NAMES = new Set([
  'region', 'endregion', 'if', 'else', 'elif', 'endif', 'define', 'undef', 'pragma', 'nullable',
  'line', 'error', 'warning',
]);

export function lex(source: string): LexResult {
  const tokens: Token[] = [];
  const trivia: Token[] = [];
  const length = source.length;
  let i = 0;

  while (i < length) {
    const c = source[i];

    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\v') {
      i++;
      continue;
    }

    if (c === '/' && source[i + 1] === '/') {
      const end = lineEnd(source, i);
      trivia.push({ type: 'comment', start: i, end, isNamed: true });
      i = end;
      continue;
    }

    if (c === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      const end = close < 0 ? length : close + 2;
      trivia.push({ type: 'comment', start: i, end, isNamed: true });
      i = end;
      continue;
    }

    if (c === '#' && isFirstOnLine(source, i)) {
      const end = lineEnd(source, i);
      trivia.push({ type: preprocType(source.slice(i, end)), start: i, end, isNamed: true });
      i = end;
      continue;
    }

    if (c === "'") {
      const end = scanCharLiteral(source, i);
      tokens.push({ type: 'character_literal', start: i, end, isNamed: true });
      i = end;
      continue;
    }

    if (c === '"' || ((c === '@' || c === '$') && isStringStart(source, i))) {
      const literal = scanStringLiteral(source, i);
      tokens.push({ type: literal.type, start: i, end: literal.end, isNamed: true });
      i = literal.end;
      continue;
    }

    if (isDigit(c) || (c === '.' && isDigit(source[i + 1]))) {
      const number = scanNumber(source, i);
      tokens.push({ type: number.type, start: i, end: number.end, isNamed: true });
      i = number.end;
      continue;
    }

    if (isIdentifierStart(c) || (c === '@' && isIdentifierStart(source[i + 1]))) {
      const start = i;
      if (c === '@') {
        i++;
      }

      while (i < length && isIdentifierPart(source[i])) {
        i++;
      }

      tokens.push(identifierToken(source, start, i));
      continue;
    }

    const punctuator = PUNCTUATORS.find((candidate) => source.startsWith(candidate, i));
    if (punctuator) {
      tokens.push({ type: punctuator, start: i, end: i + punctuator.length, isNamed: false });
      i += punctuator.length;
      continue;
    }

    // Unknown character: emit it so the parser can skip it instead of looping forever.
    tokens.push({ type: source[i], start: i, end: i + 1, isNamed: false });
    i++;
  }

  tokens.push({ type: 'end', start: length, end: length, isNamed: false });

  return { tokens, trivia };
}

function identifierToken(source: string, start: number, end: number): Token {
  const text = source.slice(start, end);

  if (text.startsWith('@')) {
    return { type: 'identifier', start, end, isNamed: true };
  }

  if (text === 'null') {
    return { type: 'null_literal', start, end, isNamed: true };
  }

  if (text === 'true' || text === 'false') {
    return { type: 'boolean_literal', start, end, isNamed: true };
  }

  if (PREDEFINED_TYPES.has(text)) {
    return { type: 'predefined_type', start, end, isNamed: true };
  }

  if (KEYWORDS.has(text)) {
    return { type: text, start, end, isNamed: false };
  }

  return { type: 'identifier', start, end, isNamed: true };
}

function preprocType(text: string): string {
  const match = /^#\s*([A-Za-z]+)/.exec(text);
  const name = match?.[1];

  return name && PREPROC_NAMES.has(name) ? `preproc_${name}` : 'preproc_directive';
}

function isFirstOnLine(source: string, index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const c = source[i];
    if (c === '\n') {
      return true;
    }

    if (c !== ' ' && c !== '\t' && c !== '\r') {
      return false;
    }
  }

  return true;
}

function lineEnd(source: string, from: number): number {
  const index = source.indexOf('\n', from);

  return index < 0 ? source.length : index;
}

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= '0' && c <= '9';
}

function isIdentifierStart(c: string | undefined): boolean {
  return c !== undefined && (/[A-Za-z_]/.test(c) || c.charCodeAt(0) > 127);
}

function isIdentifierPart(c: string | undefined): boolean {
  return c !== undefined && (/[A-Za-z0-9_]/.test(c) || c.charCodeAt(0) > 127);
}

function scanNumber(source: string, start: number): { type: string; end: number } {
  const length = source.length;
  let i = start;
  let isReal = false;

  if (source[i] === '0' && (source[i + 1] === 'x' || source[i + 1] === 'X' || source[i + 1] === 'b' || source[i + 1] === 'B')) {
    i += 2;
    while (i < length && /[0-9a-fA-F_]/.test(source[i])) {
      i++;
    }
  } else {
    while (i < length && /[0-9_]/.test(source[i])) {
      i++;
    }

    // `1..2` is a range over two integers, and `1.ToString()` is a member access, so a `.` only
    // starts a fractional part when a digit follows it.
    if (source[i] === '.' && isDigit(source[i + 1])) {
      isReal = true;
      i++;
      while (i < length && /[0-9_]/.test(source[i])) {
        i++;
      }
    }

    if (source[i] === 'e' || source[i] === 'E') {
      const next = source[i + 1] === '+' || source[i + 1] === '-' ? i + 2 : i + 1;
      if (isDigit(source[next])) {
        isReal = true;
        i = next;
        while (i < length && isDigit(source[i])) {
          i++;
        }
      }
    }
  }

  while (i < length && /[uUlLfFdDmM]/.test(source[i])) {
    if (/[fFdDmM]/.test(source[i])) {
      isReal = true;
    }

    i++;
  }

  return { type: isReal ? 'real_literal' : 'integer_literal', end: i };
}

function scanCharLiteral(source: string, start: number): number {
  const length = source.length;
  let i = start + 1;

  while (i < length) {
    const c = source[i];
    if (c === '\\') {
      i += 2;
      continue;
    }

    if (c === "'") {
      return i + 1;
    }

    if (c === '\n') {
      return i;
    }

    i++;
  }

  return length;
}

/** `@` and `$` only start a literal when a quote (possibly after further prefixes) follows. */
function isStringStart(source: string, index: number): boolean {
  let i = index;
  while (source[i] === '@' || source[i] === '$') {
    i++;
  }

  return source[i] === '"';
}

function scanStringLiteral(source: string, start: number): { type: string; end: number } {
  const length = source.length;
  let i = start;
  let interpolated = false;
  let verbatim = false;

  while (i < length && (source[i] === '$' || source[i] === '@')) {
    if (source[i] === '$') {
      interpolated = true;
    } else {
      verbatim = true;
    }

    i++;
  }

  let quotes = 0;
  while (source[i + quotes] === '"') {
    quotes++;
  }

  if (quotes >= 3) {
    return {
      type: interpolated ? 'interpolated_string_expression' : 'raw_string_literal',
      end: scanRawString(source, i, quotes),
    };
  }

  if (quotes === 2 && !verbatim) {
    return { type: literalType(interpolated, verbatim), end: i + 2 };
  }

  const end = verbatim ? scanVerbatimString(source, i) : scanRegularString(source, i, interpolated);

  return { type: literalType(interpolated, verbatim), end };
}

function literalType(interpolated: boolean, verbatim: boolean): string {
  if (interpolated) {
    return 'interpolated_string_expression';
  }

  return verbatim ? 'verbatim_string_literal' : 'string_literal';
}

function scanRegularString(source: string, quoteIndex: number, interpolated: boolean): number {
  const length = source.length;
  let i = quoteIndex + 1;
  let braceDepth = 0;

  while (i < length) {
    const c = source[i];

    if (c === '\\') {
      i += 2;
      continue;
    }

    if (interpolated) {
      if ((c === '{' && source[i + 1] === '{') || (c === '}' && source[i + 1] === '}')) {
        i += 2;
        continue;
      }

      if (c === '{') {
        braceDepth++;
        i++;
        continue;
      }

      if (c === '}' && braceDepth > 0) {
        braceDepth--;
        i++;
        continue;
      }
    }

    if (c === '"' && braceDepth === 0) {
      return i + 1;
    }

    if (c === '\n') {
      return i;
    }

    i++;
  }

  return length;
}

function scanVerbatimString(source: string, quoteIndex: number): number {
  const length = source.length;
  let i = quoteIndex + 1;

  while (i < length) {
    if (source[i] === '"') {
      if (source[i + 1] === '"') {
        i += 2;
        continue;
      }

      return i + 1;
    }

    i++;
  }

  return length;
}

function scanRawString(source: string, quoteIndex: number, quotes: number): number {
  const length = source.length;
  const terminator = '"'.repeat(quotes);
  let i = quoteIndex + quotes;

  while (i < length) {
    const next = source.indexOf(terminator, i);
    if (next < 0) {
      return length;
    }

    let run = 0;
    while (source[next + run] === '"') {
      run++;
    }

    if (run >= quotes) {
      return next + run;
    }

    i = next + run;
  }

  return length;
}
