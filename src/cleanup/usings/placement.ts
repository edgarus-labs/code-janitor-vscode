import { Token } from '../syntax/lexer';
import { parseErrorCount } from '../transformations/editorConfigSupport';
import { applyEdits, TextEdit } from '../parser';
import { DeclarationIndex } from './declarations';
import { ExternItem, Layout, NamespaceItem, UsingItem, analyzeLayout } from './layout';
import { ImportedNames, UsedNames, describeImport, dottedName, usedNames } from './names';

/**
 * Moves the using directives of a C# file between the compilation unit and its namespace.
 *
 * Roslyn decides with the semantic model whether a directive means the same at its new place. With
 * none available, the move relies on the {@link DeclarationIndex} of the project and only happens
 * when that index proves the file binds exactly as before; otherwise the file stays as it is and the
 * reason is reported. What the index cannot see are the namespaces and types of referenced packages:
 * they are assumed not to reuse the name of a namespace or type declared in the project or the framework
 * for something the file uses (`externalReferences` says whether such packages exist). A framework the index
 * is not generated from (Windows Desktop) adds to the framework namespaces, whose types are then not all known.
 */

export type PlacementDirection = 'outside' | 'inside';

export interface PlacementEnvironment {
  readonly index: DeclarationIndex;
  readonly externalReferences: boolean;
  /** Why the index may miss declarations; the placement is skipped while it is set. */
  readonly incomplete?: string;
  /** One indentation level, for directives written into a namespace that has nothing to copy the indentation from. */
  readonly indent: string;
}

export type PlacementResult =
  | { readonly status: 'moved'; readonly text: string }
  | { readonly status: 'unchanged' }
  | { readonly status: 'skipped'; readonly reason: string; /** Offset of the first directive the reason concerns. */ readonly at?: number };

const UNCHANGED: PlacementResult = { status: 'unchanged' };

const skip = (reason: string): PlacementResult => ({ status: 'skipped', reason });

export function placeUsings(source: string, direction: PlacementDirection, env: PlacementEnvironment): PlacementResult {
  if (!source.trim()) {
    return UNCHANGED;
  }

  const layout = analyzeLayout(source);
  const result = direction === 'outside' ? moveOutside(source, layout, env) : moveInside(source, layout, env);
  const first = direction === 'outside' ? layout.namespaces.flatMap((namespace) => namespace.usings)[0] : layout.usings.find((item) => !item.isGlobal);
  const checked = result.status === 'moved' ? verifyMove(source, result.text, layout) : result;

  return checked.status === 'skipped' && first ? { ...checked, at: first.start } : checked;
}

// ---------------------------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------------------------

/** The moved text must read like the original but for the using directives. */
function verifyMove(before: string, after: string, layout: Layout): PlacementResult {
  const afterLayout = analyzeLayout(after);
  if (!afterLayout.ok || parseErrorCount(after) > parseErrorCount(before)) {
    return skip('the moved file could not be parsed as well as the original');
  }

  const withoutDirectives = (text: string, layoutOf: Layout): string[] => {
    const ranges = [...layoutOf.usings, ...layoutOf.namespaces.flatMap((ns) => ns.usings)];

    return layoutOf.tokens
      .filter((token) => !ranges.some((range) => token.start >= range.start && token.end <= range.end))
      .map((token) => `${token.type}:${text.slice(token.start, token.end)}`);
  };
  const original = withoutDirectives(before, layout);
  const moved = withoutDirectives(after, afterLayout);
  if (original.length !== moved.length || original.some((token, index) => token !== moved[index])) {
    return skip('moving the directives would have changed other code');
  }

  return { status: 'moved', text: after };
}

// ---------------------------------------------------------------------------------------------
// Text layout of a directive
// ---------------------------------------------------------------------------------------------

interface Comment {
  readonly text: string;
  /** On the same line as the directive, in front of it. */
  readonly inline: boolean;
}

interface DirectiveBlock {
  readonly item: UsingItem;
  /** The lines to remove to take the directive out, with the comments in front of it. */
  readonly removeStart: number;
  readonly removeEnd: number;
  readonly leading: readonly Comment[];
  /** What follows the `;` on its line (comments), without trailing white space. */
  readonly trailing: string;
  /** True when the directive starts the file, so the comments on the lines above it are the file header and stay. */
  readonly startsFile: boolean;
}

function lineStart(source: string, index: number): number {
  return index <= 0 ? 0 : source.lastIndexOf('\n', index - 1) + 1;
}

function lineEnd(source: string, index: number): number {
  const newline = source.indexOf('\n', index);
  if (newline < 0) {
    return source.length;
  }

  return newline > 0 && source[newline - 1] === '\r' ? newline - 1 : newline;
}

function nextLine(source: string, index: number): number {
  const newline = source.indexOf('\n', index);

  return newline < 0 ? source.length : newline + 1;
}

const isBlankText = (text: string): boolean => /^\s*$/.test(text);

/** Where the tokens of the file are, by offset. */
function tokenBefore(layout: Layout, offset: number): Token | undefined {
  let found: Token | undefined;
  for (const token of layout.tokens) {
    if (token.end > offset) {
      break;
    }

    found = token;
  }

  return found;
}

function tokenFrom(layout: Layout, offset: number): Token | undefined {
  return layout.tokens.find((token) => token.start >= offset);
}

/** The lines of a directive, or why it cannot be moved as whole lines. */
function blockOf(source: string, layout: Layout, item: UsingItem): DirectiveBlock | string {
  const describe = source.slice(item.start, item.end).replace(/\s+/g, ' ');
  const previous = tokenBefore(layout, item.start);
  const startsFile = previous === undefined;
  let regionStart = 0;
  if (previous) {
    const newline = source.indexOf('\n', previous.end);
    if (newline < 0 || newline >= item.start) {
      return `'${describe}' shares its line with other code`;
    }

    regionStart = newline + 1;
  }

  // In front of a directive that starts the file, only the comments on its own line are its; those above are the file header.
  const ownLine = lineStart(source, item.start);
  if (startsFile && layout.comments.some((comment) => comment.start < ownLine && comment.end > ownLine)) {
    return `a comment in front of '${describe}' starts on an earlier line`;
  }

  const comments = layout.comments.filter((comment) => comment.start >= (startsFile ? ownLine : regionStart) && comment.end <= item.start);
  const leading: Comment[] = comments.map((comment) => ({
    text: source.slice(comment.start, comment.end),
    inline: !source.slice(comment.end, item.start).includes('\n'),
  }));
  const first = comments.length > 0 ? comments[0].start : item.start;
  if (!isBlankText(source.slice(lineStart(source, first), first))) {
    return `'${describe}' shares its line with other code`;
  }

  const eol = lineEnd(source, item.end);
  const next = tokenFrom(layout, item.end);
  if (next && next.start < eol) {
    return `'${describe}' shares its line with other code`;
  }

  const trailingComments = layout.comments.filter((comment) => comment.start >= item.end && comment.start < eol);
  if (trailingComments.some((comment) => comment.end > eol)) {
    return `a comment after '${describe}' continues on the next line`;
  }

  return {
    item,
    removeStart: lineStart(source, first),
    removeEnd: nextLine(source, item.end),
    leading,
    trailing: source.slice(item.end, eol).trimEnd(),
    startsFile,
  };
}

// ---------------------------------------------------------------------------------------------
// Resolving and qualifying a directive
// ---------------------------------------------------------------------------------------------

/** The scopes a name in namespace `full` is looked up in: the namespace itself, its enclosing namespaces, the global namespace. */
function scopesOf(full: string): string[] {
  const segments = full.split('.');
  const scopes: string[] = [];
  for (let i = segments.length; i > 0; i--) {
    scopes.push(segments.slice(0, i).join('.'));
  }

  scopes.push('');

  return scopes;
}

interface Rewritten {
  /** The directive as it is written at its new place. */
  readonly text: string;
  /** The namespace or type imported, fully qualified from the global namespace, when the target is a plain dotted name. */
  readonly target?: string;
}

interface RewriteContext {
  readonly source: string;
  readonly index: DeclarationIndex;
  readonly externalReferences: boolean;
  /** The scopes the target is looked up in at its current place. */
  readonly currentScopes: readonly string[];
  /** Names of the extern aliases declared inside the namespace the directive leaves or the namespaces around it. */
  readonly innerExterns: ReadonlySet<string>;
  readonly direction: PlacementDirection;
}

const TYPE_END_TOKENS = new Set(['identifier', 'predefined_type', '>', ']', '?', '*']);

interface LookedUpName {
  /** Index of the token in the directive's tokens. */
  readonly at: number;
  readonly token: Token;
  readonly name: string;
  /** The name stands in front of `::`: `global`, an extern alias or a using alias of a namespace. */
  readonly qualifier: boolean;
}

/** The simple names the target of `item` is looked up by: the identifiers that start a name (not after `.`, `::` or the end of a type). */
function lookedUpNames(source: string, item: UsingItem): LookedUpName[] {
  const names: LookedUpName[] = [];
  const tokens = item.tokens;
  for (let i = item.targetFrom; i < item.targetTo; i++) {
    const token = tokens[i];
    const previous = i > item.targetFrom ? tokens[i - 1] : undefined;
    if (token.type === 'identifier' && !(previous && (previous.type === '.' || previous.type === '::' || TYPE_END_TOKENS.has(previous.type)))) {
      names.push({ at: i, token, name: source.slice(token.start, token.end).replace(/^@/, ''), qualifier: tokens[i + 1]?.type === '::' });
    }
  }

  return names;
}

/**
 * Writes `item` so that it means at its new place what it means now. Outwards, a name found in an
 * enclosing namespace is written with that namespace in front; inwards, a name that an inner
 * namespace would capture is written `global::`-qualified; everything else keeps its text.
 */
function rewriteDirective(ctx: RewriteContext, item: UsingItem): Rewritten | string {
  const { source, index } = ctx;
  const describe = source.slice(item.start, item.end).replace(/\s+/g, ' ');
  const insertions: { at: number; text: string }[] = [];
  let target: string | undefined = dottedName(source, item.tokens, item.targetFrom, item.targetTo);

  for (const { at, token, name, qualifier } of lookedUpNames(source, item)) {
    if (qualifier) {
      if (name !== 'global' && ctx.innerExterns.has(name)) {
        return `'${describe}' refers to the extern alias '${name}', which is declared inside the namespace and cannot be named outside it`;
      }

      continue;
    }

    const scope = ctx.currentScopes.find((candidate) => index.memberKind(candidate, name) !== undefined);
    if (scope === undefined) {
      const wholeName = at === item.targetFrom && item.alias === undefined;
      if (!(wholeName && ctx.externalReferences)) {
        return `'${describe}' cannot be resolved: '${name}' is not declared in the project or the framework`;
      }
    } else if (scope !== '') {
      if (ctx.direction === 'inside') {
        insertions.push({ at: token.start, text: 'global::' });
      } else if (item.tokens[at + 1]?.type === '<') {
        // Lookup passes over a type of another arity, which the index does not record: the name may bind further out.
        return `'${describe}' cannot be qualified: the index does not know whether ${scope}.${name} takes the type arguments of '${name}'`;
      } else {
        // `Company.App.Services` written at file level starts with the global `Company`, which must be a namespace there.
        const root = scope.split('.')[0];
        if (index.memberKind('', root) === 'both') {
          return `'${describe}' cannot be written from the global namespace: '${root}' is a namespace and a type there`;
        }

        insertions.push({ at: token.start, text: `${scope}.` });
        if (at === item.targetFrom && target !== undefined) {
          target = `${scope}.${target}`;
        }
      }
    }
  }

  if (insertions.length === 0) {
    return { text: source.slice(item.start, item.end), target };
  }

  let text = source.slice(item.start, item.end);
  for (const insertion of [...insertions].sort((a, b) => b.at - a.at)) {
    const at = insertion.at - item.start;
    text = text.slice(0, at) + insertion.text + text.slice(at);
  }

  return { text, target };
}

/** A directive's text with white space collapsed and `global::` dropped: equal keys of directives written at file level import the same thing. */
function keyOf(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/global::/g, '').trim();
}

// ---------------------------------------------------------------------------------------------
// What a move can change
// ---------------------------------------------------------------------------------------------

interface Entry {
  readonly label: string;
  readonly imported: ImportedNames;
  /** The scope the directive applies in before the move and after it. */
  readonly before: string;
  readonly after: string;
}

function globalUsingEntries(index: DeclarationIndex, level: string): Entry[] {
  return index.globalUsings().map((text) => {
    const words = text.replace(/\s*\.\s*/g, '.').replace(/\s*::\s*/g, '::');
    const label = `global using ${words};`;
    const aliased = /^(\w+)\s*=\s*(.+)$/.exec(words);
    if (aliased) {
      return { label, imported: { kind: 'alias', alias: aliased[1], types: new Set<string>(), extensions: new Set<string>() } as ImportedNames, before: level, after: level };
    }

    const isStatic = words.startsWith('static ');
    const name = (isStatic ? words.slice(7) : words).replace(/^global::/, '').trim();
    const imported: ImportedNames = isStatic
      ? { kind: 'static', target: name, types: null, extensions: null }
      : describeTarget(name, index);

    return { label, imported, before: level, after: level };
  });
}

function describeTarget(name: string, index: DeclarationIndex): ImportedNames {
  if (index.hasNamespace(name)) {
    return { kind: 'namespace', target: name, types: index.typesOf(name), extensions: index.extensionMethodsOf(name) ?? null };
  }

  return { kind: 'namespace', target: name, types: null, extensions: null };
}

/**
 * Directives of one scope do not see each other. A name of `item` that none of `scopes` declares is found through a
 * directive of an enclosing scope; once one of `providers` that may provide it shares the scope of `item`, it is not.
 */
function findHiddenBinding(source: string, item: UsingItem, scopes: readonly string[], providers: readonly Entry[], index: DeclarationIndex): string | undefined {
  // A using-namespace directive names a namespace, which only an alias stands for; the others name types too, which a
  // namespace a package declares, or a `using static` of a type whose nested types are not known, may hold.
  const namesTypes = item.isStatic || item.alias !== undefined;
  const provides = ({ imported }: Entry, name: string): boolean => {
    if (imported.kind === 'alias') {
      return imported.alias === name;
    }

    if (!namesTypes) {
      return false;
    }

    if (imported.kind === 'static') {
      return imported.target === undefined || !index.declaresType(imported.target) || index.hasType(`${imported.target}.${name}`);
    }

    return imported.types?.has(name) ?? true;
  };

  for (const { at, name, qualifier } of lookedUpNames(source, item)) {
    // In front of `::` stands `global`, an extern alias or a using alias of a namespace: only the last is a directive.
    // A generic name passes over a declaration of another arity, which the index does not record.
    const declared = item.tokens[at + 1]?.type !== '<' && scopes.some((scope) => index.memberKind(scope, name) !== undefined);
    if (qualifier ? name === 'global' : declared) {
      continue;
    }

    const provider = providers.find((entry) => (qualifier ? entry.imported.kind === 'alias' && entry.imported.alias === name : provides(entry, name)));
    if (provider) {
      return `'${source.slice(item.start, item.end).replace(/\s+/g, ' ')}' finds '${name}' through '${provider.label}', which it would no longer see once they share a scope`;
    }
  }

  return undefined;
}

/**
 * A directive moved across the members of the namespaces between its old and its new place is found
 * before (inwards) or after (outwards) names it did not meet before: a used name that such a scope
 * declares and the directive provides binds differently afterwards.
 */
function findCapturedName(entry: Entry, scopes: readonly string[], used: UsedNames, index: DeclarationIndex, direction: PlacementDirection): string | undefined {
  const { imported } = entry;
  // The namespace of a package is not listed, and a namespace often holds a type named like itself (`Mediator.Mediator`):
  // such a type would win over the namespace of the same name in front of it, where the code writes `Mediator.ICommand`.
  if (imported.kind === 'namespace' && imported.types === null) {
    const selfNamed = imported.target?.split('.').find((segment) => used.names.has(segment));
    if (selfNamed !== undefined) {
      return `moving '${entry.label}' could change what '${selfNamed}' refers to: the namespace is not known and may hold a type of that name`;
    }
  }

  for (const scope of scopes) {
    const where = scope || 'the global namespace';
    for (const [name, kind] of index.membersOf(scope)) {
      if (!used.names.has(name)) {
        continue;
      }

      const provided =
        imported.kind === 'alias'
          ? imported.alias === name
          : imported.types === null
            ? kind !== 'namespace'
            : imported.types.has(name);
      if (provided) {
        const full = scope ? `${scope}.${name}` : name;
        const source = imported.types?.has(name) && imported.target ? `${imported.target}.${name}` : undefined;

        return direction === 'outside'
          ? `moving '${entry.label}' would change what '${name}' refers to: it is searched after ${where}, which declares ${full}${source ? ` (now ${source})` : ''}`
          : `moving '${entry.label}' would change what '${name}' refers to: it would be found before ${where}, which declares ${full}`;
      }
    }

    const scopeExtensions = index.extensionMethodsOf(scope);
    const importedExtensions = imported.extensions;
    // With both sides unknown nothing can be compared; packages are assumed not to reuse these names.
    const candidates = scopeExtensions && importedExtensions ? [...scopeExtensions].filter((name) => importedExtensions.has(name)) : [...(scopeExtensions ?? importedExtensions ?? [])];
    const extension = candidates.find((name) => used.extensionNames.has(name));
    if (extension !== undefined) {
      return `moving '${entry.label}' could change which extension method '${extension}' is called: ${where} declares one too`;
    }
  }

  return undefined;
}

/** Whether an alias declared in `aliasScope` wins over a type imported in `importScope`; `undefined` when neither scope encloses the other. */
function aliasWins(aliasScope: string, importScope: string): boolean | undefined {
  // In one scope the alias wins; otherwise the directive of the inner scope does.
  if (aliasScope === importScope || importScope === '' || aliasScope.startsWith(`${importScope}.`)) {
    return true;
  }

  return aliasScope === '' || importScope.startsWith(`${aliasScope}.`) ? false : undefined;
}

/** Directives that are one scope before the move and share it after it (or the reverse) bind names differently. */
function findRebinding(entries: readonly Entry[], used: UsedNames, index: DeclarationIndex): string | undefined {
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      if (a.imported.kind === 'alias' || b.imported.kind === 'alias') {
        // A type imported in an inner scope wins over an alias of an outer one, the alias wins in the same scope.
        const [alias, other] = a.imported.kind === 'alias' ? [a, b] : [b, a];
        const name = alias.imported.alias;
        const provided = other.imported.kind === 'static' || other.imported.types === null || other.imported.types.has(name ?? '');
        if (other.imported.kind !== 'alias' && name !== undefined && used.names.has(name) && provided && aliasWins(alias.before, other.before) !== aliasWins(alias.after, other.after)) {
          return `moving '${alias.label}' and '${other.label}' would change what '${name}' refers to: the alias and the type imported with that name would win over each other differently`;
        }

        continue;
      }

      const sharedBefore = a.before === b.before;
      const sharedAfter = a.after === b.after;
      if (sharedBefore === sharedAfter) {
        continue;
      }

      // The members of a type cannot be listed, so two `using static` directives that end up together cannot be compared.
      if (a.imported.kind === 'static' && b.imported.kind === 'static' && a.imported.target !== b.imported.target) {
        return `'${a.label}' and '${b.label}' would end up side by side, and the members they import cannot be compared`;
      }

      if (sharedAfter && a.imported.types && b.imported.types && a.imported.target !== b.imported.target) {
        for (const name of a.imported.types) {
          if (used.names.has(name) && b.imported.types.has(name)) {
            return `moving '${a.label}' next to '${b.label}' would make '${name}' ambiguous (${a.imported.target}.${name} and ${b.imported.target}.${name})`;
          }
        }
      }

      // A `using static` imports the nested types of its type, which are known only when the project declares it.
      if (sharedAfter && (a.imported.kind === 'static') !== (b.imported.kind === 'static')) {
        const [type, other] = a.imported.kind === 'static' ? [a.imported, b.imported] : [b.imported, a.imported];
        const known = type.target !== undefined && index.declaresType(type.target);
        const name = [...(other.types ?? [])].find((candidate) => used.names.has(candidate) && (!known || index.hasType(`${type.target}.${candidate}`)));
        if (name !== undefined) {
          return known
            ? `moving '${a.label}' next to '${b.label}' would make '${name}' ambiguous (${type.target}.${name} and ${other.target}.${name})`
            : `moving '${a.label}' next to '${b.label}' could make '${name}' ambiguous: the nested types of ${type.target ?? 'the type'} are not known`;
        }
      }

      if (a.imported.extensions && b.imported.extensions && a.imported.target !== b.imported.target) {
        for (const name of a.imported.extensions) {
          if (used.extensionNames.has(name) && b.imported.extensions.has(name)) {
            return `'${a.label}' and '${b.label}' both import an extension method '${name}', so moving them changes which one is called`;
          }
        }
      }
    }
  }

  return undefined;
}

/** An alias is unique in its scope; two aliases of the same name that end up together must mean the same. `keys` tells what a moved or kept one means, written from the global namespace. */
function findAliasClash(entries: readonly Entry[], keys: ReadonlyMap<Entry, string>): string | undefined {
  const seen = new Map<string, Entry>();
  for (const entry of entries) {
    if (entry.imported.kind !== 'alias' || !entry.imported.alias) {
      continue;
    }

    const other = seen.get(entry.imported.alias);
    if (other && other.after === entry.after && (keys.get(other) ?? keyOf(other.label)) !== (keys.get(entry) ?? keyOf(entry.label))) {
      return `'${other.label}' and '${entry.label}' declare the alias '${entry.imported.alias}' twice`;
    }

    seen.set(entry.imported.alias, entry);
  }

  return undefined;
}

/** True when the identifier `name` appears in the file outside `namespace` (and outside using directives). */
function usesNameOutside(source: string, layout: Layout, name: string, namespace: NamespaceItem): boolean {
  const end = namespace.close?.end ?? source.length;
  const directives = [...layout.usings, ...layout.namespaces.flatMap((candidate) => candidate.usings)];

  return layout.tokens.some(
    (token) =>
      token.type === 'identifier' &&
      source.slice(token.start, token.end).replace(/^@/, '') === name &&
      (token.start < namespace.keywordStart || token.start >= end) &&
      !directives.some((directive) => token.start >= directive.start && token.end <= directive.end)
  );
}

function preprocessorBetween(layout: Layout, start: number, end: number): boolean {
  return layout.directives.some((directive) => directive.start >= start && directive.start < end);
}

const INTERLEAVED = 'the using directives are interleaved with preprocessor directives';

// ---------------------------------------------------------------------------------------------
// Outwards
// ---------------------------------------------------------------------------------------------

interface Moved {
  readonly namespace: NamespaceItem;
  readonly block: DirectiveBlock;
  readonly rewritten: Rewritten;
  readonly entry: Entry;
}

/** The extern aliases declared in `namespace` and the namespaces around it: none of them can be named at file level. */
function enclosingExterns(namespace: NamespaceItem): Set<string> {
  const names = new Set<string>();
  for (let scope: NamespaceItem | undefined = namespace; scope; scope = scope.parent) {
    for (const extern of scope.externs) {
      names.add(extern.name);
    }
  }

  return names;
}

function moveOutside(source: string, layout: Layout, env: PlacementEnvironment): PlacementResult {
  const movedItems = layout.namespaces.flatMap((namespace) => namespace.usings.map((item) => ({ namespace, item })));
  if (movedItems.length === 0) {
    return UNCHANGED;
  }

  if (!layout.ok) {
    return skip('the file could not be parsed');
  }

  if (env.incomplete) {
    return skip(`the declarations of the project are not fully known (${env.incomplete})`);
  }

  for (const namespace of layout.namespaces) {
    for (let parent = namespace.parent; parent && namespace.usings.length > 0; parent = parent.parent) {
      if (parent.usings.length > 0) {
        return skip('using directives are declared at several nesting levels of namespaces');
      }
    }
  }

  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const used = usedNames(source, layout);
  const cuEntries: Entry[] = layout.usings.map((item) => ({
    label: source.slice(item.start, item.end).replace(/\s+/g, ' '),
    imported: describeImport(item, dottedName(source, item.tokens, item.targetFrom, item.targetTo), env.index),
    before: '',
    after: '',
  }));
  const moved: Moved[] = [];

  for (const { namespace, item } of movedItems) {
    const block = blockOf(source, layout, item);
    if (typeof block === 'string') {
      return skip(block);
    }

    const rewritten = rewriteDirective(
      {
        source,
        index: env.index,
        externalReferences: env.externalReferences,
        currentScopes: scopesOf(namespace.fullName),
        innerExterns: enclosingExterns(namespace),
        direction: 'outside',
      },
      item
    );
    if (typeof rewritten === 'string') {
      return skip(rewritten);
    }

    moved.push({
      namespace,
      block,
      rewritten,
      entry: {
        label: source.slice(item.start, item.end).replace(/\s+/g, ' '),
        imported: describeImport(item, rewritten.target, env.index),
        before: namespace.fullName,
        after: '',
      },
    });
  }

  // Directives must be placeable at file level between the last file-level directive and the first member.
  const lastMoved = movedItems.reduce((last, candidate) => (candidate.item.end > last.item.end ? candidate : last));
  const insertion = outwardInsertion(source, layout);
  if (typeof insertion === 'string') {
    return skip(insertion);
  }

  const followingToken = tokenFrom(layout, lastMoved.item.end);
  if (preprocessorBetween(layout, insertion.offset, followingToken?.start ?? source.length)) {
    return skip(INTERLEAVED);
  }

  // Aliases of the file level must not be hidden by, and must not hide, the first segment of a qualified name.
  const cuAliases = new Set([...cuEntries, ...moved.map((entry) => entry.entry)].flatMap((entry) => (entry.imported.alias ? [entry.imported.alias] : [])));
  for (const entry of moved) {
    const first = entry.rewritten.target?.split('.')[0];
    if (first && cuAliases.has(first)) {
      return skip(`the name '${first}' in '${entry.entry.label}' would be shadowed by an alias at file level`);
    }
  }

  // An alias moved to file level is also visible in the rest of the file, where it wins over imported types.
  for (const entry of moved) {
    const alias = entry.entry.imported.alias;
    if (alias && usesNameOutside(source, layout, alias, entry.namespace)) {
      return skip(`the alias '${alias}' of '${entry.entry.label}' would also apply outside its namespace, where the name is used`);
    }
  }

  const globals = globalUsingEntries(env.index, '');
  const fileLevel = [...cuEntries, ...globals];
  const entries = [...cuEntries, ...moved.map((entry) => entry.entry), ...globals];
  for (const entry of moved) {
    const reason =
      findHiddenBinding(source, entry.block.item, scopesOf(entry.namespace.fullName), fileLevel, env.index) ??
      findCapturedName(entry.entry, scopesOf(entry.namespace.fullName).slice(1), used, env.index, 'outside');
    if (reason) {
      return skip(reason);
    }
  }

  const rebinding = findRebinding(entries, used, env.index) ?? findAliasClash(entries, new Map(moved.map((entry) => [entry.entry, keyOf(entry.rewritten.text)] as const)));
  if (rebinding) {
    return skip(rebinding);
  }

  return buildOutward(source, layout, newline, moved, insertion);
}

interface OutwardInsertion {
  /** Offset the moved directives are written at. */
  readonly offset: number;
}

function outwardInsertion(source: string, layout: Layout): OutwardInsertion | string {
  const last = [...layout.usings, ...layout.externs].reduce<UsingItem | ExternItem | undefined>((latest, item) => (!latest || item.end > latest.end ? item : latest), undefined);
  if (last) {
    return { offset: nextLine(source, last.end) };
  }

  if (layout.firstTokenStart < 0) {
    return 'the file has no code to put the directives in front of';
  }

  // A documentation comment in front of the first member documents it; it must not become a directive's.
  if (layout.firstTokenType !== 'namespace') {
    const region = source.slice(0, layout.firstTokenStart);
    const before = layout.comments.filter((comment) => comment.end <= layout.firstTokenStart).pop();
    if (before && /^\s*\/\/\/|^\s*\/\*\*/.test(source.slice(before.start, before.end)) && isBlankText(region.slice(before.end))) {
      return 'the first type of the file has a documentation comment that would become the comment of a using directive';
    }
  }

  const start = lineStart(source, layout.firstTokenStart);

  return { offset: isBlankText(source.slice(start, layout.firstTokenStart)) ? start : layout.firstTokenStart };
}

/** A directive written at its new place, with the comments of the duplicates dropped in its favor. */
interface Landing {
  readonly block: DirectiveBlock;
  readonly text: string;
  readonly leading: Comment[];
  readonly trailing: string[];
}

/** A directive already at the new place that receives the comments of the duplicates dropped in its favor. */
interface Survivor {
  readonly item: UsingItem;
  readonly leading: Comment[];
  readonly trailing: string[];
}

/**
 * Drops the moved directives that import what one already at the new place or one moved before them imports; their
 * comments go to the directive that stays. `existing` carries the key of what each directive imports where it stands,
 * which its text alone does not tell inside a namespace (`using Shared;` there may import `N.Shared`).
 */
function settleDuplicates(
  existing: readonly { item: UsingItem; key: string }[],
  moved: readonly { block: DirectiveBlock; text: string }[]
): { landings: Landing[]; survivors: Survivor[] } {
  const survivors = new Map<string, Survivor>();
  for (const { item, key } of existing) {
    survivors.set(key, { item, leading: [], trailing: [] });
  }

  const landings = new Map<string, Landing>();
  for (const { block, text } of moved) {
    const key = keyOf(text);
    const comments = [...block.leading];
    const trailing = block.trailing.trim() ? [block.trailing.trim()] : [];
    const survivor = survivors.get(key) ?? landings.get(key);
    if (survivor) {
      survivor.leading.push(...comments);
      survivor.trailing.push(...trailing);
    } else {
      landings.set(key, { block, text, leading: [], trailing: [] });
    }
  }

  return { landings: [...landings.values()], survivors: [...survivors.values()] };
}

/** Writes the comments of dropped duplicates into the directives that stay. */
function survivorEdits(source: string, survivors: readonly Survivor[], newline: string, indent: string): TextEdit[] {
  const edits: TextEdit[] = [];
  for (const { item, leading, trailing } of survivors) {
    if (leading.length > 0) {
      const at = lineStart(source, item.start);
      edits.push({ start: at, end: at, text: leading.map((comment) => `${indent}${comment.text}${newline}`).join('') });
    }

    if (trailing.length > 0) {
      const eol = lineEnd(source, item.end);
      edits.push({ start: eol, end: eol, text: ` ${trailing.join(' ')}` });
    }
  }

  return edits;
}

function renderBlock(landing: Landing, indent: string, newline: string): string {
  const { block } = landing;
  let lines = '';
  let inline = '';
  for (const comment of [...block.leading, ...landing.leading]) {
    if (comment.inline) {
      inline += `${comment.text} `;
    } else {
      lines += `${indent}${comment.text}${newline}`;
    }
  }

  // The gap in front of the comment at the end of the line stays as written, unless a duplicate adds one.
  const trailing = [block.trailing.trim(), ...landing.trailing].filter(Boolean).join(' ');
  const gap = landing.trailing.length === 0 ? block.trailing : trailing ? ` ${trailing}` : '';

  return `${lines}${indent}${inline}${landing.text}${gap}${newline}`;
}

function buildOutward(source: string, layout: Layout, newline: string, moved: readonly Moved[], insertion: OutwardInsertion): PlacementResult {
  const existing = layout.usings.map((item) => ({ item, key: keyOf(source.slice(item.start, item.end)) }));
  const { landings, survivors } = settleDuplicates(existing, moved.map((entry) => ({ block: entry.block, text: entry.rewritten.text })));
  const edits: TextEdit[] = [
    ...moved.map((entry) => ({ start: entry.block.removeStart, end: entry.block.removeEnd, text: '' })),
    ...survivorEdits(source, survivors, newline, ''),
  ];

  const block = landings.map((landing) => renderBlock(landing, '', newline)).join('');
  if (block) {
    const rest = source.slice(insertion.offset);
    const blankAfter = rest === '' || isBlankText(rest.slice(0, lineEnd(rest, 0)));
    edits.push({ start: insertion.offset, end: insertion.offset, text: block + (blankAfter ? '' : newline) });
  }

  return { status: 'moved', text: tidyNamespaceOpenings(applyEdits(source, edits), moved, layout) };
}

/** Taking the directives out leaves the blank line that followed them: none after `{`, one after `namespace N;`. */
function tidyNamespaceOpenings(text: string, moved: readonly Moved[], original: Layout): string {
  const emptied = new Set(moved.map((entry) => original.namespaces.indexOf(entry.namespace)));
  const layout = analyzeLayout(text);
  if (!layout.ok || layout.namespaces.length !== original.namespaces.length) {
    return text;
  }

  const edits: TextEdit[] = [];
  for (const index of emptied) {
    const namespace = layout.namespaces[index];
    if (namespace.externs.length > 0 || namespace.usings.length > 0) {
      continue;
    }

    const opener = namespace.open;
    if (!isBlankText(text.slice(opener.end, lineEnd(text, opener.end)))) {
      continue;
    }

    const afterOpener = nextLine(text, opener.end);
    let end = afterOpener;
    while (end < text.length && isBlankText(text.slice(end, lineEnd(text, end))) && lineEnd(text, end) < text.length) {
      end = nextLine(text, end);
    }

    if (end > afterOpener) {
      // A file-scoped namespace keeps one blank line after its semicolon.
      const keep = namespace.kind === 'file' ? nextLine(text, afterOpener) : afterOpener;
      edits.push({ start: keep, end: Math.max(keep, end), text: '' });
    }
  }

  return applyEdits(text, edits);
}

// ---------------------------------------------------------------------------------------------
// Inwards
// ---------------------------------------------------------------------------------------------

function moveInside(source: string, layout: Layout, env: PlacementEnvironment): PlacementResult {
  const fileLevel = layout.usings.filter((item) => !item.isGlobal);
  if (fileLevel.length === 0 || layout.topLevel.length !== 1 || layout.otherTopLevel || layout.hasGlobalAttributes) {
    return UNCHANGED;
  }

  if (!layout.ok) {
    return skip('the file could not be parsed');
  }

  if (env.incomplete) {
    return skip(`the declarations of the project are not fully known (${env.incomplete})`);
  }

  const namespace = layout.topLevel[0];
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const used = usedNames(source, layout);
  const blocks: DirectiveBlock[] = [];
  for (const item of fileLevel) {
    const block = blockOf(source, layout, item);
    if (typeof block === 'string') {
      return skip(block);
    }

    blocks.push(block);
  }

  const opener = insertionAnchor(namespace);
  const anchorEnd = opener.end;
  if (!isBlankText(source.slice(anchorEnd, lineEnd(source, anchorEnd)))) {
    return skip(`'namespace ${namespace.declaredName}' shares its line with other code`);
  }

  const firstMoved = blocks[0];
  const start = firstMoved.startsFile ? firstMoved.item.start : (tokenBefore(layout, firstMoved.item.start)?.end ?? 0);
  if (preprocessorBetween(layout, start, nextLine(source, anchorEnd))) {
    return skip(INTERLEAVED);
  }

  const scopes = scopesOf(namespace.fullName);
  const movedEntries: { block: DirectiveBlock; rewritten: Rewritten; entry: Entry }[] = [];
  for (const block of blocks) {
    const rewritten = rewriteDirective(
      {
        source,
        index: env.index,
        externalReferences: env.externalReferences,
        currentScopes: scopes,
        innerExterns: new Set(),
        direction: 'inside',
      },
      block.item
    );
    if (typeof rewritten === 'string') {
      return skip(rewritten);
    }

    movedEntries.push({
      block,
      rewritten,
      entry: {
        label: source.slice(block.item.start, block.item.end).replace(/\s+/g, ' '),
        // What the directive imports is what it means at file level: the global reading.
        imported: describeImport(block.item, dottedName(source, block.item.tokens, block.item.targetFrom, block.item.targetTo), env.index),
        before: '',
        after: namespace.fullName,
      },
    });
  }

  // What the directives already in the namespace import is what they mean there: relative to the namespace. Their key is
  // that meaning written from the global namespace, where the moved directives come from; one that cannot be written
  // there equals none of them.
  const kept = namespace.usings.map((item) => {
    const relative = rewriteDirective(
      {
        source,
        index: env.index,
        externalReferences: true,
        currentScopes: scopes,
        innerExterns: enclosingExterns(namespace),
        direction: 'outside',
      },
      item
    );
    const label = source.slice(item.start, item.end).replace(/\s+/g, ' ');
    const entry: Entry = {
      label,
      imported: describeImport(item, typeof relative === 'string' ? undefined : relative.target, env.index),
      before: namespace.fullName,
      after: namespace.fullName,
    };

    return { item, entry, key: typeof relative === 'string' ? `unresolved ${label}` : keyOf(relative.text) };
  });
  const keptEntries = kept.map(({ entry }) => entry);
  const globalEntries = [
    ...layout.usings
      .filter((item) => item.isGlobal)
      .map((item) => ({
        label: source.slice(item.start, item.end).replace(/\s+/g, ' '),
        imported: describeImport(item, dottedName(source, item.tokens, item.targetFrom, item.targetTo), env.index),
        before: '',
        after: '',
      })),
    ...globalUsingEntries(env.index, ''),
  ];

  const movedImports = movedEntries.map((moved) => moved.entry);
  for (const item of namespace.usings) {
    const reason = findHiddenBinding(source, item, scopes, movedImports, env.index);
    if (reason) {
      return skip(reason);
    }
  }

  // The directives of a nested namespace look names up in N and its directives before the global namespace: names they
  // find there now may be captured by the moved directives too.
  const nestedNames = layout.namespaces
    .filter((nested) => nested !== namespace)
    .flatMap((nested) => nested.usings.flatMap((item) => lookedUpNames(source, item).filter((name) => !name.qualifier).map((name) => name.name)));
  const reachable: UsedNames = { names: new Set([...used.names, ...nestedNames]), extensionNames: used.extensionNames };
  for (const { entry } of movedEntries) {
    // An alias may not share its name with a member of the namespace it is declared in, wherever that is declared (CS0576).
    const alias = entry.imported.alias;
    const reason =
      alias !== undefined && used.names.has(alias) && env.index.memberKind(namespace.fullName, alias) !== undefined
        ? `the alias '${alias}' of '${entry.label}' would conflict with ${namespace.fullName}.${alias}, which the namespace declares`
        : findCapturedName(entry, scopes.slice(1), reachable, env.index, 'inside');
    if (reason) {
      return skip(reason);
    }
  }

  const all = [...movedImports, ...keptEntries, ...globalEntries];
  const keys = new Map<Entry, string>([...movedEntries.map((moved) => [moved.entry, keyOf(moved.rewritten.text)] as const), ...kept.map(({ entry, key }) => [entry, key] as const)]);
  const rebinding = findRebinding(all, reachable, env.index) ?? findAliasClash(all, keys);
  if (rebinding) {
    return skip(rebinding);
  }

  return buildInward(source, env, newline, namespace, opener, kept, movedEntries);
}

/** The token after which directives are written in `namespace`: its last extern alias, else its `{` or `;`. */
function insertionAnchor(namespace: NamespaceItem): { end: number } {
  const lastExtern = namespace.externs[namespace.externs.length - 1];

  return { end: lastExtern ? lastExtern.end : namespace.open.end };
}

function memberIndentation(source: string, namespace: NamespaceItem, fallback: string): string {
  if (namespace.kind === 'file') {
    return '';
  }

  const candidates = [...namespace.externs, ...namespace.usings].map((item) => item.start);
  if (namespace.hasMembers) {
    candidates.push(namespace.membersStart);
  }

  for (const offset of candidates.sort((a, b) => a - b)) {
    const start = lineStart(source, offset);
    const indent = source.slice(start, offset);
    if (isBlankText(indent)) {
      return indent;
    }
  }

  const start = lineStart(source, namespace.keywordStart);
  const own = source.slice(start, namespace.keywordStart);

  return (isBlankText(own) ? own : '') + fallback;
}

function buildInward(
  source: string,
  env: PlacementEnvironment,
  newline: string,
  namespace: NamespaceItem,
  anchor: { end: number },
  kept: readonly { item: UsingItem; key: string }[],
  moved: readonly { block: DirectiveBlock; rewritten: Rewritten; entry: Entry }[]
): PlacementResult {
  const indent = memberIndentation(source, namespace, env.indent);
  const { landings, survivors } = settleDuplicates(kept, moved.map((entry) => ({ block: entry.block, text: entry.rewritten.text })));
  const edits: TextEdit[] = survivorEdits(source, survivors, newline, indent);
  const blankRunEnd = (from: number): number => {
    let end = from;
    while (end < source.length && isBlankText(source.slice(end, lineEnd(source, end))) && lineEnd(source, end) < source.length) {
      end = nextLine(source, end);
    }

    return end;
  };

  // Take the directives out of the file level; the blank lines that followed the last one go with it.
  const removals = moved.map((entry) => entry.block);
  const first = removals[0];
  const last = removals[removals.length - 1];
  const trailingEnd = blankRunEnd(last.removeEnd);
  const precededByBlank = first.removeStart === 0 || isBlankText(source.slice(lineStart(source, first.removeStart - 1), first.removeStart));
  // What stood between the directives and the code keeps one blank line, unless the directives were at the top of the file.
  const separator = !first.startsFile && !precededByBlank && trailingEnd < source.length ? newline : '';
  removals.forEach((removal, i) => {
    const next = removals[i + 1];
    // A blank line that only separates two moved groups goes with them.
    const end = next === undefined ? trailingEnd : blankRunEnd(removal.removeEnd) === next.removeStart ? next.removeStart : removal.removeEnd;
    edits.push({ start: removal.removeStart, end, text: next === undefined ? separator : '' });
  });

  // Write them into the namespace in front of the directives it has.
  const lines = landings.map((landing) => renderBlock(landing, indent, newline)).join('');
  if (lines) {
    const at = nextLine(source, anchor.end);
    const hasFollowing = namespace.usings.length > 0 || namespace.hasMembers;
    const leadBlank = namespace.kind === 'file' && namespace.externs.length === 0 ? newline : '';
    // One blank line between the directives and the first member; the blank lines that were there are replaced.
    const tail = namespace.usings.length > 0 || !namespace.hasMembers ? '' : newline;
    edits.push({ start: at, end: hasFollowing ? blankRunEnd(at) : at, text: leadBlank + lines + tail });
  }

  return { status: 'moved', text: applyEdits(source, edits) };
}
