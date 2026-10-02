/**
 * The cleanup parser reads an interpolated string as one literal, so what is inside its `{...}`
 * holes (`$"{_n++}"`, `$"{Interlocked.Increment(ref _n)}"`) is invisible to the rules that look
 * for writes, reads or calls. These helpers read the holes out of the literal text.
 */

interface LiteralEnd {
  readonly end: number;
  readonly holes: string[];
}

/** The expressions of every interpolation hole of an interpolated string literal, nested ones included. */
export function interpolationHoles(literal: string): string[] {
  const start = literal.search(/[$@]/);
  if (start < 0) {
    return [];
  }

  return readLiteral(literal, start)?.holes ?? [];
}

/** True when a hole of the interpolated string `literal` writes `name` (assigns, steps or passes it by `ref`/`out`, or takes its address). */
export function interpolationWritesName(literal: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const id = `(?:(?<![\\w@.])|(?<=\\bthis\\.))${escaped}(?!\\w)`;
  const writes = [
    new RegExp(`\\b(?:ref|out)\\s+(?:this\\.)?${escaped}(?!\\w)`),
    new RegExp(`(?:\\+\\+|--)\\s*${id}`),
    new RegExp(`${id}\\s*(?:\\+\\+|--)`),
    new RegExp(`${id}\\s*(?:[-+*/%&|^]|<<|>>>?|\\?\\?)?=(?![=>])`),
    new RegExp(`&\\s*${id}`),
  ];

  return interpolationHoles(literal).some((hole) => {
    const code = withoutStringContents(hole);

    return writes.some((pattern) => pattern.test(code));
  });
}

/** True when a hole of the interpolated string `literal` accesses a member or element of `name` (`name.M()`, `this.name[0]`, `name?.M`, `(name).M()`). */
export function interpolationAccessesMember(literal: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Opening parentheses that are not a call's, the receiver, then closing parentheses and the access.
  const access = new RegExp(
    `(?<![\\w@.]\\s*)((?:\\(\\s*)*)(?:this\\s*\\.\\s*)?@?${escaped}(?!\\w)((?:\\s*\\))*)\\s*!?\\s*\\??\\s*[.[]`,
    'g',
  );

  // Each group holds only its parentheses and whitespace: more closing than opening ones close a call's.
  return interpolationHoles(literal).some((hole) =>
    [...withoutStringContents(hole).matchAll(access)].some((match) => match[2].replace(/\s/g, '').length <= match[1].replace(/\s/g, '').length),
  );
}

/** Replaces the content of the string and character literals of `code` so that text in them is never read as code. */
function withoutStringContents(code: string): string {
  let result = '';
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '$' || c === '@' || c === '"') {
      const literal = readLiteral(code, i);
      if (literal) {
        result += '""';
        i = literal.end - 1;
        continue;
      }
    }

    if (c === "'") {
      const close = code.indexOf("'", code[i + 1] === '\\' ? i + 3 : i + 2);
      result += "''";
      i = close < 0 ? code.length : close;
      continue;
    }

    result += c;
  }

  return result;
}

/** Reads the (possibly interpolated) string literal that starts at `start` (its first `$` or `@` or `"`). */
function readLiteral(text: string, start: number): LiteralEnd | undefined {
  let i = start;
  let dollars = 0;
  let verbatim = false;
  while (text[i] === '$' || text[i] === '@') {
    if (text[i] === '$') {
      dollars++;
    } else {
      verbatim = true;
    }

    i++;
  }

  if (text[i] !== '"') {
    return undefined;
  }

  let quotes = 0;
  while (text[i + quotes] === '"') {
    quotes++;
  }

  const raw = quotes >= 3;
  if (!raw && quotes === 2) {
    // An empty string: `""`.
    return { end: i + 2, holes: [] };
  }

  i += raw ? quotes : 1;
  const holes: string[] = [];
  while (i < text.length) {
    const c = text[i];
    if (raw) {
      if (c === '"') {
        let run = 0;
        while (text[i + run] === '"') {
          run++;
        }

        if (run >= quotes) {
          return { end: i + run, holes };
        }

        i += run;
        continue;
      }
    } else if (verbatim) {
      if (c === '"' && text[i + 1] === '"') {
        i += 2;
        continue;
      }

      if (c === '"') {
        return { end: i + 1, holes };
      }
    } else if (c === '\\') {
      i += 2;
      continue;
    } else if (c === '"') {
      return { end: i + 1, holes };
    } else if (c === '\n') {
      return { end: i, holes };
    }

    if (dollars > 0 && c === '{') {
      let run = 0;
      while (text[i + run] === '{') {
        run++;
      }

      const opening = Math.max(dollars, 1);
      if (run < opening || (dollars === 1 && run % 2 === 0)) {
        i += run;
        continue;
      }

      // The first `run - opening` braces are literal text; the last `opening` open the hole.
      const holeStart = i + run;
      const hole = readHole(text, holeStart, opening);
      holes.push(hole.text, ...hole.nested);
      i = hole.end;
      continue;
    }

    i++;
  }

  return { end: text.length, holes };
}

/** The hole content that starts at `start` (just after its opening braces) and where the hole ends. */
function readHole(text: string, start: number, braces: number): { text: string; nested: string[]; end: number } {
  const nested: string[] = [];
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === '$' || c === '@' || c === '"') {
      const literal = readLiteral(text, i);
      if (literal) {
        nested.push(...literal.holes);
        i = literal.end;
        continue;
      }
    }

    if (c === "'") {
      const close = text.indexOf("'", text[i + 1] === '\\' ? i + 3 : i + 2);
      i = close < 0 ? text.length : close + 1;
      continue;
    }

    if (c === '{') {
      depth++;
    } else if (c === '}') {
      if (depth === 0) {
        // Closing braces: `braces` of them end the hole.
        let run = 0;
        while (text[i + run] === '}') {
          run++;
        }

        return { text: formatFree(text.slice(start, i)), nested, end: i + Math.min(run, braces) };
      }

      depth--;
    }

    i++;
  }

  return { text: formatFree(text.slice(start)), nested, end: text.length };
}

/** The expression of a hole without its alignment or format part (`x,10:D3` -> `x`), keeping a conditional's `:`. */
function formatFree(hole: string): string {
  let depth = 0;
  for (let i = 0; i < hole.length; i++) {
    const c = hole[i];
    const literal = c === '$' || c === '@' || c === '"' ? readLiteral(hole, i) : undefined;
    if (literal) {
      i = literal.end - 1;
    } else if (c === "'") {
      const close = hole.indexOf("'", hole[i + 1] === '\\' ? i + 3 : i + 2);
      i = close < 0 ? hole.length : close;
    } else if ('([{'.includes(c)) {
      depth++;
    } else if (')]}'.includes(c)) {
      depth--;
    } else if (c === ':' && depth === 0 && hole[i + 1] !== ':') {
      return hole.slice(0, i);
    }
  }

  return hole;
}

/** C# keywords and literals: never a name that captures anything. */
const KEYWORDS = new Set([
  'abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char', 'checked', 'class', 'const', 'continue', 'decimal', 'default',
  'delegate', 'do', 'double', 'else', 'enum', 'event', 'explicit', 'extern', 'false', 'finally', 'fixed', 'float', 'for', 'foreach', 'goto',
  'if', 'implicit', 'in', 'int', 'interface', 'internal', 'is', 'lock', 'long', 'namespace', 'new', 'null', 'object', 'operator', 'out',
  'override', 'params', 'private', 'protected', 'public', 'readonly', 'ref', 'return', 'sbyte', 'sealed', 'short', 'sizeof', 'stackalloc',
  'static', 'string', 'struct', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'uint', 'ulong', 'unchecked', 'unsafe', 'ushort', 'using',
  'virtual', 'void', 'volatile', 'while', 'and', 'or', 'not', 'when', 'var', 'await', 'nameof',
]);

export interface HoleIdentifier {
  readonly name: string;
  /** Preceded by `.`, `?.` or `->`: a member of something else, not a name in scope. */
  readonly member: boolean;
  /** Followed by `.`: it qualifies something (a type, a namespace or a value). */
  readonly qualifier: boolean;
  /** Followed by `(`: the name is invoked. */
  readonly invoked: boolean;
}

/** The identifiers used in the holes of an interpolated string literal, without keywords and literals. */
export function interpolationIdentifiers(literal: string): HoleIdentifier[] {
  const found: HoleIdentifier[] = [];
  for (const hole of interpolationHoles(literal)) {
    const code = withoutStringContents(hole);
    for (const match of code.matchAll(/(?<![\w@])@?[\p{L}_][\p{L}\p{N}_]*/gu)) {
      const name = match[0].replace(/^@/, '');
      if (KEYWORDS.has(name) && !match[0].startsWith('@')) {
        continue;
      }

      const before = code.slice(0, match.index).trimEnd();
      const after = code.slice(match.index + match[0].length).trimStart();
      found.push({ name, member: /(?:\.|\?\.|->)$/.test(before), qualifier: after.startsWith('.'), invoked: after.startsWith('(') });
    }
  }

  return found;
}
