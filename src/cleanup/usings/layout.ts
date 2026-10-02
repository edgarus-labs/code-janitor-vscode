import { Token, lex } from '../syntax/lexer';

/**
 * The shape of a C# file that the using-directive placement needs: its extern alias and using
 * directives, its namespace declarations (block-scoped, file-scoped, nested) and whether anything
 * else sits at the top level. Read from tokens, so it does not depend on the tree of the parser,
 * which reads a few directives (extern aliases, `global using`) as other constructs.
 */

export interface UsingItem {
  /** Offset of the first token (`global` or `using`). */
  readonly start: number;
  /** Offset after the `;`. */
  readonly end: number;
  readonly isGlobal: boolean;
  readonly isStatic: boolean;
  /** The alias name (`Str` in `using Str = System.String;`). */
  readonly alias?: string;
  /** The tokens of the directive, `global`/`using` through `;`. */
  readonly tokens: readonly Token[];
  /** The tokens naming the imported namespace/type or the alias target: indexes `[targetFrom, targetTo)` of `tokens`. */
  readonly targetFrom: number;
  readonly targetTo: number;
}

export interface ExternItem {
  readonly start: number;
  readonly end: number;
  readonly name: string;
}

export interface NamespaceItem {
  readonly kind: 'block' | 'file';
  /** Offset of the `namespace` keyword. */
  readonly keywordStart: number;
  /** The name as declared (`Company.App`). */
  readonly declaredName: string;
  /** Offsets of the first and the end of the last token of the name. */
  readonly nameStart: number;
  readonly nameEnd: number;
  /** The name with the enclosing block-scoped namespaces (`Outer.Company.App`). */
  readonly fullName: string;
  readonly parent?: NamespaceItem;
  /** The `{` of a block-scoped namespace or the `;` of a file-scoped one. */
  readonly open: Token;
  /** The `}` of a block-scoped namespace. */
  readonly close?: Token;
  readonly externs: ExternItem[];
  readonly usings: UsingItem[];
  /** Offset of the first token after the extern aliases and usings (the closing brace or the end of the file when there is none). */
  membersStart: number;
  /** True when the namespace has members after its directives (types or nested namespaces). */
  hasMembers: boolean;
  readonly nested: NamespaceItem[];
}

export interface Layout {
  /** False when the tokens do not form balanced declarations; nothing should be moved then. */
  readonly ok: boolean;
  readonly externs: ExternItem[];
  /** The using directives at file level, `global using` included. */
  readonly usings: UsingItem[];
  /** Every namespace declaration, enclosing before nested. */
  readonly namespaces: NamespaceItem[];
  /** The namespaces declared directly in the file. */
  readonly topLevel: NamespaceItem[];
  /** True when the file has a type, delegate, top-level statement or attribute outside the namespaces. */
  readonly otherTopLevel: boolean;
  /** True when a top-level member is a global attribute such as `[assembly: ...]`. */
  readonly hasGlobalAttributes: boolean;
  /** Offset of the first token of the file; `-1` when there is none. */
  readonly firstTokenStart: number;
  readonly firstTokenType: string;
  /** Preprocessor directives (`#if`, `#region`, ...), in source order. */
  readonly directives: readonly Token[];
  readonly comments: readonly Token[];
  readonly tokens: readonly Token[];
}

export function analyzeLayout(source: string): Layout {
  const { tokens: all, trivia } = lex(source);
  const tokens = all.slice(0, -1);
  const textOf = (token: Token): string => source.slice(token.start, token.end);

  const externs: ExternItem[] = [];
  const usings: UsingItem[] = [];
  const namespaces: NamespaceItem[] = [];
  const topLevel: NamespaceItem[] = [];
  let otherTopLevel = false;
  let hasGlobalAttributes = false;
  let ok = true;

  /** Parses extern aliases and using directives from `i`; returns the index after them. */
  const parseDirectives = (from: number, externTarget: ExternItem[], usingTarget: UsingItem[]): number => {
    let i = from;
    for (;;) {
      const token = tokens[i];
      if (!token) {
        return i;
      }

      if (token.type === 'extern' && tokens[i + 1]?.type === 'identifier' && textOf(tokens[i + 1]) === 'alias' && tokens[i + 2]?.type === 'identifier') {
        let j = i + 3;
        while (j < tokens.length && tokens[j].type !== ';') {
          j++;
        }

        if (j >= tokens.length) {
          ok = false;
          return tokens.length;
        }

        externTarget.push({ start: token.start, end: tokens[j].end, name: textOf(tokens[i + 2]) });
        i = j + 1;
        continue;
      }

      const using = parseUsing(i);
      if (!using) {
        return i;
      }

      usingTarget.push(using.item);
      i = using.next;
    }
  };

  const parseUsing = (from: number): { item: UsingItem; next: number } | undefined => {
    let i = from;
    const first = tokens[i];
    const isGlobal = first?.type === 'identifier' && textOf(first) === 'global' && tokens[i + 1]?.type === 'using';
    if (isGlobal) {
      i++;
    }

    if (tokens[i]?.type !== 'using') {
      return undefined;
    }

    let j = i + 1;
    let isStatic = false;
    while (tokens[j]?.type === 'static' || tokens[j]?.type === 'unsafe') {
      isStatic ||= tokens[j].type === 'static';
      j++;
    }

    // `using var x = ...;` and `using (...)` are statements; a directive names a namespace or type.
    const name = tokens[j];
    const after = tokens[j + 1]?.type;
    if (name?.type !== 'identifier' || !(after === '.' || after === ';' || after === '=' || after === '::' || after === '<')) {
      return undefined;
    }

    let end = j;
    while (end < tokens.length && tokens[end].type !== ';') {
      end++;
    }

    if (end >= tokens.length) {
      ok = false;
      return undefined;
    }

    const directive = tokens.slice(from, end + 1);
    const nameIndex = directive.indexOf(name);
    const aliased = after === '=';

    return {
      item: {
        start: first.start,
        end: tokens[end].end,
        isGlobal,
        isStatic,
        ...(aliased ? { alias: textOf(name).replace(/^@/, '') } : {}),
        tokens: directive,
        targetFrom: aliased ? nameIndex + 2 : nameIndex,
        targetTo: directive.length - 1,
      },
      next: end + 1,
    };
  };

  /** Skips one member (type, delegate, statement, attribute list) starting at `from`; returns the index after it. */
  const skipMember = (from: number): number => {
    let depth = 0;
    let i = from;
    for (; i < tokens.length; i++) {
      const type = tokens[i].type;
      if (type === '{' || type === '(' || type === '[') {
        depth++;
      } else if (type === '}' || type === ')' || type === ']') {
        depth--;
        if (depth === 0 && type === '}') {
          return i + 1;
        }

        if (depth < 0) {
          return i;
        }
      } else if (type === ';' && depth === 0) {
        return i + 1;
      }
    }

    return i;
  };

  /** Parses the body of `namespace` from `from`, up to (excluding) the closing brace for a block-scoped one. */
  const parseNamespaceBody = (namespace: NamespaceItem, from: number): number => {
    let i = parseDirectives(from, namespace.externs, namespace.usings);
    namespace.membersStart = tokens[i]?.start ?? source.length;
    while (i < tokens.length) {
      const token = tokens[i];
      if (token.type === '}' && namespace.kind === 'block') {
        return i;
      }

      if (token.type === 'namespace') {
        namespace.hasMembers = true;
        i = parseNamespace(i, namespace);
        continue;
      }

      namespace.hasMembers = true;
      const next = skipMember(i);
      i = next > i ? next : i + 1;
    }

    if (namespace.kind === 'block') {
      ok = false;
    }

    return i;
  };

  const parseNamespace = (from: number, parent?: NamespaceItem): number => {
    const keyword = tokens[from];
    const nameParts: string[] = [];
    const nameFrom = from + 1;
    let i = from + 1;
    while (i < tokens.length && tokens[i].type !== '{' && tokens[i].type !== ';') {
      if (tokens[i].type === 'identifier') {
        nameParts.push(textOf(tokens[i]).replace(/^@/, ''));
      }

      i++;
    }

    if (i >= tokens.length || nameParts.length === 0) {
      ok = false;
      return tokens.length;
    }

    const declaredName = nameParts.join('.');
    const namespace: NamespaceItem = {
      kind: tokens[i].type === '{' ? 'block' : 'file',
      keywordStart: keyword.start,
      declaredName,
      nameStart: tokens[nameFrom].start,
      nameEnd: tokens[i - 1].end,
      fullName: parent ? `${parent.fullName}.${declaredName}` : declaredName,
      ...(parent ? { parent } : {}),
      open: tokens[i],
      externs: [],
      usings: [],
      membersStart: tokens[i].end,
      hasMembers: false,
      nested: [],
    };
    namespaces.push(namespace);
    if (parent) {
      parent.nested.push(namespace);
    } else {
      topLevel.push(namespace);
    }

    const close = parseNamespaceBody(namespace, i + 1);
    if (namespace.kind === 'block' && close < tokens.length) {
      (namespace as { close?: Token }).close = tokens[close];

      return close + 1;
    }

    return close;
  };

  let i = parseDirectives(0, externs, usings);
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.type === 'namespace') {
      i = parseNamespace(i);
      continue;
    }

    otherTopLevel = true;
    if (token.type === '[' && tokens[i + 1]?.type === 'identifier' && ['assembly', 'module'].includes(textOf(tokens[i + 1])) && tokens[i + 2]?.type === ':') {
      hasGlobalAttributes = true;
    }

    const next = skipMember(i);
    i = next > i ? next : i + 1;
  }

  return {
    ok,
    externs,
    usings,
    namespaces,
    topLevel,
    otherTopLevel,
    hasGlobalAttributes,
    firstTokenStart: tokens[0]?.start ?? -1,
    firstTokenType: tokens[0]?.type ?? '',
    directives: trivia.filter((token) => token.type.startsWith('preproc')),
    comments: trivia
      .filter((token) => token.type === 'comment')
      .map((token) => ({ ...token, end: token.start + source.slice(token.start, token.end).replace(/[\r\n]+$/, '').length })),
    tokens,
  };
}
