import { Token } from '../syntax/lexer';
import { DeclarationIndex } from './declarations';
import { Layout, UsingItem } from './layout';

/** Names the compiler looks up for constructs that do not spell them (`foreach` calls `GetEnumerator`, `await` calls `GetAwaiter`, ...). */
const IMPLICIT_EXTENSION_NAMES = [
  'GetEnumerator',
  'GetAsyncEnumerator',
  'GetAwaiter',
  'GetPinnableReference',
  'Deconstruct',
  'Add',
  'Dispose',
  'DisposeAsync',
  'Count',
  'Length',
  'Slice',
  'Select',
  'SelectMany',
  'Where',
  'OrderBy',
  'OrderByDescending',
  'ThenBy',
  'ThenByDescending',
  'GroupBy',
  'GroupJoin',
  'Join',
  'Cast',
  'OfType',
];

const WORD = /@?[A-Za-z_][A-Za-z0-9_]*/g;

export interface UsedNames {
  /** Every name the code outside the using directives can refer to, with the `Attribute` suffix variants. */
  readonly names: ReadonlySet<string>;
  /** `names` plus the members the compiler calls without spelling them. */
  readonly extensionNames: ReadonlySet<string>;
}

/**
 * The simple names the file uses outside its using directives. A name is taken whenever it appears as an
 * identifier, in an interpolated string or in a `cref`, whatever it means there: the placement only needs
 * to know which names a moved directive could newly capture, so extra names only make it more careful.
 */
export function usedNames(source: string, layout: Layout): UsedNames {
  const names = new Set<string>();
  const directiveRanges: { start: number; end: number }[] = [...layout.usings, ...layout.namespaces.flatMap((ns) => ns.usings)];
  const insideDirective = (token: Token): boolean => directiveRanges.some((range) => token.start >= range.start && token.end <= range.end);
  const add = (name: string): void => {
    const plain = name.replace(/^@/, '');
    names.add(plain);
    names.add(`${plain}Attribute`);
  };

  for (const token of layout.tokens) {
    if (insideDirective(token)) {
      continue;
    }

    if (token.type === 'identifier') {
      add(source.slice(token.start, token.end));
    } else if (token.type.startsWith('interpolated')) {
      for (const word of source.slice(token.start, token.end).matchAll(WORD)) {
        add(word[0]);
      }
    }
  }

  for (const comment of layout.comments) {
    const text = source.slice(comment.start, comment.end);
    for (const cref of text.matchAll(/\bcref\s*=\s*"([^"]*)"/g)) {
      for (const word of cref[1].matchAll(WORD)) {
        add(word[0]);
      }
    }
  }

  return { names, extensionNames: new Set([...names, ...IMPLICIT_EXTENSION_NAMES]) };
}

/** What a using directive makes visible, as far as the declaration index can tell. */
export interface ImportedNames {
  readonly kind: 'namespace' | 'static' | 'alias';
  readonly alias?: string;
  /** The namespace or type imported, fully qualified from the global namespace, when it is a plain dotted name. */
  readonly target?: string;
  /** The type names it imports; `null` when they cannot be listed (a package's namespace, `using static`). */
  readonly types: ReadonlySet<string> | null;
  /** The extension methods it imports; `null` when they cannot be listed. */
  readonly extensions: ReadonlySet<string> | null;
}

/** The dotted name written by the tokens `[from, to)`, without `global::`; `undefined` when they hold anything but a plain qualified name. */
export function dottedName(source: string, tokens: readonly Token[], from: number, to: number): string | undefined {
  const parts: string[] = [];
  let expectName = true;
  for (let i = from; i < to; i++) {
    const token = tokens[i];
    const text = source.slice(token.start, token.end);
    if (expectName) {
      if (token.type !== 'identifier') {
        return undefined;
      }

      if (text === 'global' && tokens[i + 1]?.type === '::' && parts.length === 0) {
        i++;
        continue;
      }

      parts.push(text.replace(/^@/, ''));
      expectName = false;
    } else if (token.type === '.') {
      expectName = true;
    } else {
      return undefined;
    }
  }

  return expectName || parts.length === 0 ? undefined : parts.join('.');
}

/** Describes `item` as it reads with `target` as the fully qualified name it imports (`undefined` when it is not a plain name). */
export function describeImport(item: UsingItem, target: string | undefined, index: DeclarationIndex): ImportedNames {
  if (item.alias !== undefined) {
    return { kind: 'alias', alias: item.alias, target, types: new Set(), extensions: new Set() };
  }

  if (item.isStatic || target === undefined) {
    return { kind: item.isStatic ? 'static' : 'namespace', target, types: null, extensions: null };
  }

  if (index.hasNamespace(target)) {
    return { kind: 'namespace', target, types: index.typesOf(target), extensions: index.extensionMethodsOf(target) ?? null };
  }

  return { kind: 'namespace', target, types: null, extensions: null };
}
