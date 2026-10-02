/** Lexical classification of every character of a C# file. */
export const CODE = 0;
export const COMMENT = 1;
export const STRING = 2;

/**
 * Classifies every character of C# source as code, comment or string/char literal.
 *
 * This is a lexer, not a parser: it exists so that whitespace-level transformations can tell
 * layout whitespace apart from whitespace that belongs to a literal or a comment (the role
 * `SyntaxKind.WhitespaceTrivia` played in the Roslyn implementation). Interpolated strings are
 * classified as string in their entirety, including the holes and any literal nested in a hole,
 * which errs on the side of never rewriting anything inside a literal.
 */
export function classifyCSharp(source: string): Uint8Array {
  const kinds = new Uint8Array(source.length);
  const n = source.length;
  let i = 0;

  while (i < n) {
    const c = source[i];

    if (c === '/' && source[i + 1] === '/') {
      const end = indexOfLineEnd(source, i);
      kinds.fill(COMMENT, i, end);
      i = end;
      continue;
    }

    if (c === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      const end = close < 0 ? n : close + 2;
      kinds.fill(COMMENT, i, end);
      i = end;
      continue;
    }

    if (c === "'") {
      const end = scanCharLiteral(source, i);
      kinds.fill(STRING, i, end);
      i = end;
      continue;
    }

    if (c === '"' || c === '@' || c === '$') {
      const end = scanStringLiteral(source, i);
      if (end > i) {
        kinds.fill(STRING, i, end);
        i = end;
        continue;
      }
    }

    kinds[i] = CODE;
    i++;
  }

  return kinds;
}

function indexOfLineEnd(source: string, from: number): number {
  const index = source.indexOf('\n', from);

  return index < 0 ? source.length : index;
}

export function scanCharLiteral(source: string, start: number): number {
  const n = source.length;
  let i = start + 1;

  while (i < n) {
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

  return n;
}

/**
 * Scans a string literal starting at `start`, covering the `@`, `$` and `$$` prefixes, raw string
 * literals and their multi-line forms, and interpolation holes (with any literal nested in them).
 * Returns the index just past the literal, or `start` when the position is not a literal at all
 * (a bare `@identifier` or an arithmetic `$`-less context).
 */
export function scanStringLiteral(source: string, start: number): number {
  const n = source.length;
  let i = start;
  let dollars = 0;
  let verbatim = false;

  while (i < n && (source[i] === '$' || source[i] === '@')) {
    if (source[i] === '$') {
      dollars++;
    } else {
      verbatim = true;
    }

    i++;
  }

  if (i >= n || source[i] !== '"') {
    return start;
  }

  let quotes = 0;
  while (i + quotes < n && source[i + quotes] === '"') {
    quotes++;
  }

  if (quotes >= 3) {
    return scanRawStringLiteral(source, i, quotes);
  }

  // An empty literal ("" outside of a verbatim string) is two quotes and nothing else.
  if (quotes === 2 && !verbatim) {
    return i + 2;
  }

  return verbatim ? scanVerbatimString(source, i, dollars > 0) : scanRegularString(source, i, dollars > 0);
}

function scanRegularString(source: string, quoteIndex: number, interpolated: boolean): number {
  const n = source.length;
  let i = quoteIndex + 1;

  while (i < n) {
    const c = source[i];

    if (c === '\\') {
      i += 2;
      continue;
    }

    if (interpolated && (c === '{' || c === '}')) {
      i = source[i + 1] === c ? i + 2 : c === '{' ? scanInterpolationHole(source, i + 1, false) : i + 1;
      continue;
    }

    if (c === '"') {
      return i + 1;
    }

    if (c === '\n') {
      return i;
    }

    i++;
  }

  return n;
}

function scanVerbatimString(source: string, quoteIndex: number, interpolated: boolean): number {
  const n = source.length;
  let i = quoteIndex + 1;

  while (i < n) {
    const c = source[i];

    if (interpolated && (c === '{' || c === '}')) {
      i = source[i + 1] === c ? i + 2 : c === '{' ? scanInterpolationHole(source, i + 1, true) : i + 1;
      continue;
    }

    if (c === '"') {
      if (source[i + 1] === '"') {
        i += 2;
        continue;
      }

      return i + 1;
    }

    i++;
  }

  return n;
}

/**
 * Scans the code of an interpolation hole starting just after its `{` and returns the index just
 * past the closing `}`. Nested brackets, comments and literals of every kind (including nested
 * interpolated strings) are skipped, so a `"` or `}` inside them does not end the hole. A `:` at
 * the hole's top level starts the format clause, which runs to the next `}`; a bare `"` there
 * ends the clause early so the enclosing string scan can end the (malformed) literal.
 */
function scanInterpolationHole(source: string, start: number, verbatim: boolean): number {
  const n = source.length;
  let i = start;
  let depth = 0;

  while (i < n) {
    const c = source[i];

    if (c === '/' && source[i + 1] === '/') {
      i = indexOfLineEnd(source, i);
      continue;
    }

    if (c === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      i = close < 0 ? n : close + 2;
      continue;
    }

    if (c === "'") {
      i = scanCharLiteral(source, i);
      continue;
    }

    if (c === '"' || c === '@' || c === '$') {
      const end = scanStringLiteral(source, i);
      if (end > i) {
        i = end;
        continue;
      }
    }

    if (c === ':' && source[i + 1] === ':') {
      i += 2;
      continue;
    }

    if (c === ':' && depth === 0) {
      return scanFormatClause(source, i + 1, verbatim);
    }

    if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']') {
      depth = Math.max(0, depth - 1);
    } else if (c === '}') {
      if (depth === 0) {
        return i + 1;
      }

      depth--;
    }

    i++;
  }

  return n;
}

function scanFormatClause(source: string, start: number, verbatim: boolean): number {
  const n = source.length;
  let i = start;

  while (i < n) {
    const c = source[i];

    if (c === '}') {
      return i + 1;
    }

    if (verbatim ? c === '"' && source[i + 1] === '"' : c === '\\') {
      i += 2;
      continue;
    }

    if (c === '"' || (!verbatim && c === '\n')) {
      return i;
    }

    i++;
  }

  return n;
}

function scanRawStringLiteral(source: string, quoteIndex: number, openingQuotes: number): number {
  const n = source.length;
  let i = quoteIndex + openingQuotes;

  while (i < n) {
    if (source[i] !== '"') {
      i++;
      continue;
    }

    let closing = 0;
    while (i + closing < n && source[i + closing] === '"') {
      closing++;
    }

    if (closing >= openingQuotes) {
      return i + closing;
    }

    i += closing;
  }

  return n;
}
