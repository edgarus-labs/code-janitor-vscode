import { memoizeBySource } from '../sourceCache';
import { Token, lex } from '../syntax/lexer';
import { BCL_EXTENSION_METHODS, BCL_TYPES } from './bclIndex.generated';

/**
 * What the using-directive placement knows about the names a C# file can refer to: the namespaces,
 * types and extension methods declared by the files of a project (and the projects it references),
 * plus the public surface of the .NET reference assemblies. There is no semantic model in
 * JavaScript, so this index stands in for the parts of it the placement needs.
 *
 * Every declaration is found by scanning tokens, so a declaration in an `#if` branch counts whether
 * or not the branch is active: the index errs towards knowing more names, which only makes the
 * placement more conservative.
 */

/** The declarations of one file, as keys (`N:` namespace, `T:` type, `E:ns:name` extension method, `X:` unknown extension members, `G:` global using). */
export interface FileSummary {
  readonly keys: ReadonlySet<string>;
}

const TYPE_KEYWORDS = new Set(['class', 'struct', 'interface', 'enum']);

interface Scope {
  readonly kind: 'namespace' | 'type';
  readonly name: string;
  /** Brace depth of the scope's body; `-1` for a file-scoped namespace, which lasts to the end of the file. */
  readonly depth: number;
}

export const summarizeDeclarations: (source: string) => FileSummary = memoizeBySource(scanDeclarations, 4);

function scanDeclarations(file: string): FileSummary {
  // Visual Studio saves C# files with a byte order mark, which the lexer would read as part of the first word.
  const source = file.replace(/^\uFEFF/, '');
  const tokens = lex(source).tokens;
  const keys = new Set<string>();
  const scopes: Scope[] = [];
  let depth = 0;

  const text = (token: Token): string => source.slice(token.start, token.end).replace(/^@/, '');
  const current = (): Scope | undefined => scopes[scopes.length - 1];
  const enclosingNamespace = (): string => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      if (scopes[i].kind === 'namespace') {
        return scopes[i].name;
      }
    }

    return '';
  };
  const qualify = (name: string): string => {
    const scope = current();

    return scope && scope.name ? `${scope.name}.${name}` : name;
  };
  const atMemberLevel = (): boolean => {
    const scope = current();

    return scope === undefined ? depth === 0 : scope.depth === -1 ? depth === 0 : depth === scope.depth;
  };
  const declareNamespace = (full: string): void => {
    const segments = full.split('.');
    for (let i = 1; i <= segments.length; i++) {
      keys.add(`N:${segments.slice(0, i).join('.')}`);
    }
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token.type === '{') {
      depth++;
      continue;
    }

    if (token.type === '}') {
      depth--;
      const scope = current();
      if (scope && scope.depth === depth + 1) {
        scopes.pop();
      }

      continue;
    }

    if (token.type === 'namespace' && atMemberLevel()) {
      const nameParts: string[] = [];
      let j = i + 1;
      while (j < tokens.length && tokens[j].type !== '{' && tokens[j].type !== ';' && tokens[j].type !== 'end') {
        if (tokens[j].type === 'identifier') {
          nameParts.push(text(tokens[j]));
        }

        j++;
      }

      const full = qualify(nameParts.join('.'));
      declareNamespace(full);
      if (tokens[j]?.type === '{') {
        scopes.push({ kind: 'namespace', name: full, depth: depth + 1 });
        depth++;
      } else {
        scopes.push({ kind: 'namespace', name: full, depth: -1 });
      }

      i = j;
      continue;
    }

    if (token.type === 'identifier' && text(token) === 'global' && tokens[i + 1]?.type === 'using') {
      let j = i + 2;
      const parts: string[] = [];
      while (j < tokens.length && tokens[j].type !== ';' && tokens[j].type !== 'end') {
        parts.push(text(tokens[j]));
        j++;
      }

      keys.add(`G:${parts.join(' ')}`);
      i = j;
      continue;
    }

    if (!atMemberLevel()) {
      continue;
    }

    const declared = declarationAt(tokens, i, text);
    if (declared) {
      const full = qualify(declared.name);
      keys.add(`T:${full}`);
      if (declared.bodyAt !== undefined) {
        scopes.push({ kind: 'type', name: full, depth: depth + 1 });
        depth++;
        i = declared.bodyAt;
      } else {
        i = declared.endAt;
      }

      continue;
    }

    // Extension methods: `Name(this T receiver, ...)` and C# 14 `extension(T receiver) { ... }`.
    const scope = current();
    if (scope?.kind === 'type' && token.type === 'identifier' && tokens[i + 1]?.type === '(') {
      if (text(token) === 'extension' && tokens[i - 1]?.type !== '.') {
        keys.add(`X:${enclosingNamespace()}`);
      } else if (receiverIsThis(tokens, i + 1, text)) {
        keys.add(`E:${enclosingNamespace()}:${text(token)}`);
      }
    } else if (scope?.kind === 'type' && token.type === '>' && tokens[i + 1]?.type === '(' && receiverIsThis(tokens, i + 1, text)) {
      const name = genericMethodName(tokens, i, text);
      if (name) {
        keys.add(`E:${enclosingNamespace()}:${name}`);
      }
    }
  }

  return { keys };
}

const PARAMETER_MODIFIERS = new Set(['ref', 'in', 'readonly']);

/** Whether the parameter list opened at `tokens[open]` starts with `this`, past attributes and `ref`/`in`/`readonly`/`scoped`. */
function receiverIsThis(tokens: readonly Token[], open: number, text: (token: Token) => string): boolean {
  let j = open + 1;
  for (;;) {
    const token = tokens[j];
    if (token?.type === '[') {
      for (let brackets = 0; j < tokens.length; j++) {
        if (tokens[j].type === '[') {
          brackets++;
        } else if (tokens[j].type === ']' && --brackets === 0) {
          break;
        }
      }
    } else if (!token || !(PARAMETER_MODIFIERS.has(token.type) || (token.type === 'identifier' && text(token) === 'scoped'))) {
      return token?.type === 'this';
    }

    j++;
  }
}

interface DeclaredType {
  readonly name: string;
  /** Index of the `{` opening the body, when the declaration has one. */
  readonly bodyAt?: number;
  /** Index of the last token of a declaration without a body. */
  readonly endAt: number;
}

/** Where the name of a delegate type ends: its parameter list; anything else ends a member that is not one. */
const DELEGATE_STOPS = new Set(['(', ';', '{', '=', 'end']);

/** A type declaration starting at `tokens[i]` (`class`, `struct`, `interface`, `enum`, `record`, `delegate`), if there is one. */
function declarationAt(tokens: readonly Token[], i: number, text: (token: Token) => string): DeclaredType | undefined {
  const token = tokens[i];
  const previous = tokens[i - 1];
  if (previous && (previous.type === ':' || previous.type === ',' || previous.type === '.' || previous.type === '(' || previous.type === '<')) {
    return undefined;
  }

  let nameAt = -1;
  if (TYPE_KEYWORDS.has(token.type)) {
    nameAt = i + 1;
  } else if (token.type === 'identifier' && text(token) === 'record') {
    const next = tokens[i + 1];
    if (next?.type === 'struct' || next?.type === 'class') {
      nameAt = i + 2;
    } else if (next?.type === 'identifier') {
      nameAt = i + 1;
    }
  } else if (token.type === 'delegate') {
    // `delegate R Name(...)`; an anonymous method (`delegate { }`, `delegate (int x) { }`) or a function pointer
    // (`delegate*<void>`) declares nothing. A tuple return type is skipped over to reach the name.
    if (tokens[i + 1]?.type === '*') {
      return undefined;
    }

    let j = i + 1;
    if (tokens[j]?.type === '(') {
      let parens = 0;
      for (; j < tokens.length; j++) {
        if (tokens[j].type === '(') {
          parens++;
        } else if (tokens[j].type === ')' && --parens === 0) {
          break;
        }
      }

      if (tokens[j + 1]?.type !== 'identifier') {
        return undefined;
      }

      j++;
    }

    while (j < tokens.length && !DELEGATE_STOPS.has(tokens[j].type)) {
      j++;
    }

    if (tokens[j]?.type !== '(') {
      return undefined;
    }

    let nameToken = tokens[j - 1];
    if (nameToken?.type === '>') {
      let angle = 0;
      while (j > i) {
        j--;
        if (tokens[j].type === '>') {
          angle++;
        } else if (tokens[j].type === '<' && --angle === 0) {
          break;
        }
      }

      nameToken = tokens[j - 1];
    }

    return nameToken?.type === 'identifier' ? { name: text(nameToken), endAt: j } : undefined;
  } else {
    return undefined;
  }

  const nameToken = tokens[nameAt];
  if (nameToken?.type !== 'identifier') {
    return undefined;
  }

  // The body starts at the first `{` outside parentheses; a record without a body ends at `;`.
  let parens = 0;
  for (let j = nameAt + 1; j < tokens.length; j++) {
    const type = tokens[j].type;
    if (type === '(') {
      parens++;
    } else if (type === ')') {
      parens--;
    } else if (parens === 0 && type === '{') {
      return { name: text(nameToken), bodyAt: j, endAt: j };
    } else if (parens === 0 && (type === ';' || type === 'end')) {
      return { name: text(nameToken), endAt: j };
    }
  }

  return undefined;
}

/** The name of a generic method whose `>` closes its type parameter list at `tokens[closeAt]`. */
function genericMethodName(tokens: readonly Token[], closeAt: number, text: (token: Token) => string): string | undefined {
  let angle = 0;
  for (let j = closeAt; j > 0; j--) {
    if (tokens[j].type === '>') {
      angle++;
    } else if (tokens[j].type === '<' && --angle === 0) {
      return tokens[j - 1].type === 'identifier' ? text(tokens[j - 1]) : undefined;
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------------------------
// The .NET reference assemblies
// ---------------------------------------------------------------------------------------------

interface BclData {
  readonly namespaces: ReadonlySet<string>;
  readonly types: Map<string, ReadonlySet<string>>;
  readonly extensions: Map<string, ReadonlySet<string>>;
  readonly children: Map<string, ReadonlySet<string>>;
}

let bclData: BclData | undefined;

function bcl(): BclData {
  if (bclData) {
    return bclData;
  }

  const namespaces = new Set<string>();
  const children = new Map<string, Set<string>>();
  const types = new Map<string, ReadonlySet<string>>();
  const extensions = new Map<string, ReadonlySet<string>>();
  for (const [namespace, names] of Object.entries(BCL_TYPES)) {
    types.set(namespace, new Set(names.split(' ')));
    const segments = namespace.split('.');
    for (let i = 1; i <= segments.length; i++) {
      const full = segments.slice(0, i).join('.');
      namespaces.add(full);
      const parent = segments.slice(0, i - 1).join('.');
      if (!children.has(parent)) {
        children.set(parent, new Set());
      }

      (children.get(parent) as Set<string>).add(segments[i - 1]);
    }
  }

  for (const [namespace, names] of Object.entries(BCL_EXTENSION_METHODS)) {
    extensions.set(namespace, new Set(names.split(' ')));
  }

  bclData = { namespaces, types, extensions, children };

  return bclData;
}

// ---------------------------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------------------------

export type MemberKind = 'namespace' | 'type';

/** The per-scope lookup tables derived from declaration keys. */
interface Tables {
  /** Scope -> names of the namespaces and types declared directly in it. */
  readonly children: Map<string, Set<string>>;
  /** Namespace -> names of its extension methods. */
  readonly extensions: Map<string, Set<string>>;
  readonly globalUsings: Set<string>;
}

function emptyTables(): Tables {
  return { children: new Map(), extensions: new Map(), globalUsings: new Set() };
}

function addToTables(tables: Tables, keys: Iterable<string>): void {
  const push = (map: Map<string, Set<string>>, scope: string, name: string): void => {
    let names = map.get(scope);
    if (!names) {
      map.set(scope, (names = new Set()));
    }

    names.add(name);
  };

  for (const key of keys) {
    const tag = key.slice(0, 2);
    if (tag === 'N:' || tag === 'T:') {
      const full = key.slice(2);
      const dot = full.lastIndexOf('.');
      push(tables.children, dot < 0 ? '' : full.slice(0, dot), full.slice(dot + 1));
    } else if (tag === 'E:') {
      const colon = key.indexOf(':', 2);
      push(tables.extensions, key.slice(2, colon), key.slice(colon + 1));
    } else if (tag === 'G:') {
      tables.globalUsings.add(key.slice(2));
    }
  }
}

/** Read-only view of the declarations of a project: the other files as they are on disk, the file being cleaned as it is now. */
export class DeclarationIndex {
  private readonly addedTables: Tables;
  private readonly membersCache = new Map<string, ReadonlyMap<string, MemberKind | 'both'>>();

  constructor(
    private readonly counts: ReadonlyMap<string, number>,
    private readonly tables: Tables = emptyTables(),
    private readonly removed: ReadonlySet<string> = EMPTY,
    private readonly added: ReadonlySet<string> = EMPTY,
    /** The project uses a framework the index does not list (Windows Desktop), which adds to the namespaces of the listed ones. */
    private readonly frameworkNamespacesOpen = false
  ) {
    this.addedTables = emptyTables();
    addToTables(this.addedTables, added);
  }

  private has(key: string): boolean {
    return (this.counts.get(key) ?? 0) - (this.removed.has(key) ? 1 : 0) + (this.added.has(key) ? 1 : 0) > 0;
  }

  hasNamespace(full: string): boolean {
    return full === '' || this.has(`N:${full}`) || bcl().namespaces.has(full);
  }

  hasType(full: string): boolean {
    if (this.has(`T:${full}`)) {
      return true;
    }

    const dot = full.lastIndexOf('.');

    return bcl().types.get(dot < 0 ? '' : full.slice(0, dot))?.has(full.slice(dot + 1)) === true;
  }

  /** True when a file of the project declares the type `full`: its nested types are then known too, unlike those of the framework. */
  declaresType(full: string): boolean {
    return this.has(`T:${full}`);
  }

  /** True when the framework or a file of the project declares the namespace or type `full`. */
  knows(full: string): boolean {
    return this.hasNamespace(full) || this.hasType(full);
  }

  /** What the member `name` of `scope` is (`''` is the global namespace); `undefined` when `scope` has no such member. */
  memberKind(scope: string, name: string): MemberKind | 'both' | undefined {
    const full = scope ? `${scope}.${name}` : name;
    const namespace = this.hasNamespace(full);
    const type = this.hasType(full);

    return namespace && type ? 'both' : namespace ? 'namespace' : type ? 'type' : undefined;
  }

  /** The namespaces and types declared directly in `scope`. */
  membersOf(scope: string): ReadonlyMap<string, MemberKind | 'both'> {
    const cached = this.membersCache.get(scope);
    if (cached) {
      return cached;
    }

    const candidates = new Set<string>([
      ...(bcl().children.get(scope) ?? []),
      ...(bcl().types.get(scope) ?? []),
      ...(this.tables.children.get(scope) ?? []),
      ...(this.addedTables.children.get(scope) ?? []),
    ]);
    const result = new Map<string, MemberKind | 'both'>();
    for (const name of candidates) {
      const kind = this.memberKind(scope, name);
      if (kind) {
        result.set(name, kind);
      }
    }

    this.membersCache.set(scope, result);

    return result;
  }

  /** The type names declared directly in the namespace `full`; `null` when a framework the index does not list may add more to it. */
  typesOf(full: string): Set<string> | null {
    if (this.frameworkNamespacesOpen && bcl().namespaces.has(full)) {
      return null;
    }

    const result = new Set<string>();
    for (const [name, kind] of this.membersOf(full)) {
      if (kind !== 'namespace') {
        result.add(name);
      }
    }

    return result;
  }

  /** The names of the extension methods declared in the namespace `full`, or `undefined` when C# 14 extension blocks or a framework the index does not list may add unknown ones. */
  extensionMethodsOf(full: string): Set<string> | undefined {
    if (this.has(`X:${full}`) || (this.frameworkNamespacesOpen && bcl().namespaces.has(full))) {
      return undefined;
    }

    const names = new Set<string>(bcl().extensions.get(full) ?? []);
    for (const name of this.tables.extensions.get(full) ?? []) {
      if (this.has(`E:${full}:${name}`)) {
        names.add(name);
      }
    }

    for (const name of this.addedTables.extensions.get(full) ?? []) {
      names.add(name);
    }

    return names;
  }

  /** The `global using` directives of the project: the words after `global using`, separated by one space. */
  globalUsings(): string[] {
    return [...new Set([...this.tables.globalUsings, ...this.addedTables.globalUsings])].filter((text) => this.has(`G:${text}`));
  }
}

const EMPTY: ReadonlySet<string> = new Set();

/** Counts the declarations of many files, so a view can leave one file out and substitute its current text. */
export class DeclarationAggregate {
  private readonly counts = new Map<string, number>();
  private readonly tables = emptyTables();

  add(summary: FileSummary): void {
    for (const key of summary.keys) {
      this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    }

    addToTables(this.tables, summary.keys);
  }

  view(removed?: FileSummary, added?: FileSummary, frameworkNamespacesOpen = false): DeclarationIndex {
    return new DeclarationIndex(this.counts, this.tables, removed?.keys, added?.keys, frameworkNamespacesOpen);
  }
}

/** An index of exactly the given sources (for tests and for a file outside any project). */
export function createIndex(sources: readonly string[]): DeclarationIndex {
  const aggregate = new DeclarationAggregate();
  for (const source of sources) {
    aggregate.add(summarizeDeclarations(source));
  }

  return aggregate.view();
}
