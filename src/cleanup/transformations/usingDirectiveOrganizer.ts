import { COMMENT, classifyCSharp } from '../csharpScanner';
import { Node, TextEdit, applyEdits, findAll, parseCSharp } from '../parser';
import { SourceTransformation } from '../types';

const USING_PATTERN = /^\s*(global\s+)?using\s+(static\s+)?(?:([A-Za-z_@][\w]*)\s*=\s*)?([\s\S]*?);\s*$/;

interface ParsedUsing {
  node: Node;
  isGlobal: boolean;
  isStatic: boolean;
  alias?: string;
  name: string;
}

/**
 * Sorts `using` directives: plain usings first, then `using static`, then aliases; inside each
 * group `System` namespaces come first, then the names in Roslyn's order (see {@link compareNames}).
 *
 * Formatting is preserved by keeping each original slot in place and only swapping the directive
 * text. A block that contains comments, preprocessor directives or `global using` directives is
 * left completely untouched, so no trivia or conditional structure is ever lost. Removing unused
 * usings is a semantic operation and stays out of scope.
 */
export const usingDirectiveOrganizer: SourceTransformation = {
  name: 'Sort using directives',
  apply: (source) => sortUsingDirectives(source, true),
};

/** Sorts using directives as {@link usingDirectiveOrganizer} does; `System` goes first only when `systemFirst`. */
export function sortUsingDirectives(source: string, systemFirst: boolean): string {
  if (!source) {
    return source;
  }

  const tree = parseCSharp(source);

  try {
    const kinds = classifyCSharp(source);
    const edits: TextEdit[] = [];

    for (const container of usingContainers(tree.rootNode)) {
      collectSortEdits(source, kinds, container, edits, systemFirst);
    }

    return applyEdits(source, edits);
  } finally {
    tree.delete();
  }
}

/** Every node that can directly hold a using block: the file, and each namespace body. */
function usingContainers(root: Node): Node[] {
  const containers: Node[] = [root];

  for (const namespaceNode of findAll(root, ['namespace_declaration', 'file_scoped_namespace_declaration'])) {
    const body = namespaceNode.childForFieldName('body');
    containers.push(body && body.type === 'declaration_list' ? body : namespaceNode);
  }

  return containers;
}

function collectSortEdits(source: string, kinds: Uint8Array, container: Node, edits: TextEdit[], systemFirst: boolean): void {
  const children = container.namedChildren.filter((child): child is Node => Boolean(child));
  const usings = children.filter((child) => child.type === 'using_directive');
  if (usings.length < 2) {
    return;
  }

  const parsed = usings.map(parseUsing);
  if (parsed.some((entry) => entry === undefined)) {
    return;
  }

  const directives = parsed as ParsedUsing[];
  if (directives.some((directive) => directive.isGlobal)) {
    return;
  }

  if (blockHasCommentsOrDirectives(source, kinds, container, children, usings)) {
    return;
  }

  const sorted = [...directives].sort(
    (a, b) =>
      groupRank(a) - groupRank(b) ||
      (systemFirst ? systemRank(a) - systemRank(b) : 0) ||
      compareNames(sortName(a), sortName(b))
  );

  if (sorted.every((directive, index) => directive.node.id === directives[index].node.id)) {
    return;
  }

  for (let i = 0; i < directives.length; i++) {
    edits.push({
      start: directives[i].node.startIndex,
      end: directives[i].node.endIndex,
      text: sorted[i].node.text,
    });
  }
}

/**
 * Mirrors the "unsafe to reorder" rule: the block is skipped when any trivia around it holds a
 * comment or preprocessor directive - including the file header in front of the first directive.
 */
function blockHasCommentsOrDirectives(
  source: string,
  kinds: Uint8Array,
  container: Node,
  children: readonly Node[],
  usings: readonly Node[]
): boolean {
  const first = usings[0];
  const last = usings[usings.length - 1];

  let start = containerContentStart(container);
  for (let i = children.indexOf(first) - 1; i >= 0; i--) {
    if (children[i].type !== 'comment') {
      start = children[i].endIndex;
      break;
    }
  }

  const lineEnd = source.indexOf('\n', last.endIndex);
  const end = lineEnd < 0 ? source.length : lineEnd;

  for (let i = start; i < end; i++) {
    if (kinds[i] === COMMENT) {
      return true;
    }

    if (source[i] === '#' && kinds[i] !== COMMENT && isFirstNonBlankOfLine(source, i)) {
      return true;
    }
  }

  return false;
}

function containerContentStart(container: Node): number {
  if (container.type === 'compilation_unit') {
    return 0;
  }

  const opener = container.children.find((child) => child?.type === '{' || child?.type === ';');

  return opener ? opener.endIndex : container.startIndex;
}

function isFirstNonBlankOfLine(source: string, index: number): boolean {
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

function parseUsing(node: Node): ParsedUsing | undefined {
  const match = USING_PATTERN.exec(node.text);
  if (!match) {
    return undefined;
  }

  const name = match[4].trim();
  const alias = match[3];
  if (!name && !alias) {
    return undefined;
  }

  return { node, isGlobal: Boolean(match[1]), isStatic: Boolean(match[2]), alias, name };
}

function groupRank(directive: ParsedUsing): number {
  if (directive.alias) {
    return 2;
  }

  return directive.isStatic ? 1 : 0;
}

function systemRank(directive: ParsedUsing): number {
  if (directive.alias) {
    return 0;
  }

  return nameParts(directive.name)[0].identifier.replace(/^@/, '') === 'System' ? 0 : 1;
}

function sortName(directive: ParsedUsing): string {
  return directive.alias ?? directive.name;
}

const IGNORING_CASE = new Intl.Collator('und', { sensitivity: 'base' });
const LOWERCASE_FIRST = new Intl.Collator('und', { sensitivity: 'case', caseFirst: 'lower' });

/**
 * Roslyn's `NameSyntaxComparer` (Organize Usings, `dotnet format`): the names are compared part by part
 * (`System.IO` after `System.IdentityModel`), a name before the longer names it starts; `Goo` before
 * `Goo<T>`, fewer type arguments first, then the type arguments themselves.
 */
function compareNames(a: string, b: string): number {
  const x = nameParts(a);
  const y = nameParts(b);
  for (let i = 0; i < x.length && i < y.length; i++) {
    const compare = compareIdentifiers(x[i].identifier, y[i].identifier) || compareTypeArguments(x[i].typeArguments, y[i].typeArguments);
    if (compare !== 0) {
      return compare;
    }
  }

  return x.length - y.length;
}

/**
 * Roslyn's `TokenComparer`: invariant culture ignoring case, accents and width, then lowercase first. The
 * value of the identifier counts, so `@class` is `class`.
 */
function compareIdentifiers(a: string, b: string): number {
  const x = a.replace(/^@/, '');
  const y = b.replace(/^@/, '');

  return IGNORING_CASE.compare(x, y) || LOWERCASE_FIRST.compare(x, y);
}

function compareTypeArguments(a: readonly string[] | undefined, b: readonly string[] | undefined): number {
  if (a === undefined || b === undefined) {
    return (a === undefined ? 0 : 1) - (b === undefined ? 0 : 1);
  }

  if (a.length !== b.length) {
    return a.length - b.length;
  }

  for (let i = 0; i < a.length; i++) {
    const compare = compareNames(a[i], b[i]);
    if (compare !== 0) {
      return compare;
    }
  }

  return 0;
}

interface NamePart {
  identifier: string;
  typeArguments?: string[];
}

/** `global::A.B<C, D>` -> `global`, `A`, `B` with type arguments `C` and `D`. */
function nameParts(name: string): NamePart[] {
  const parts: NamePart[] = [];
  let depth = 0;
  let start = 0;
  const text = name.replace(/\s+/g, '');
  const add = (end: number): void => {
    const part = text.slice(start, end);
    const open = part.indexOf('<');
    parts.push(open < 0 ? { identifier: part } : { identifier: part.slice(0, open), typeArguments: splitTopLevel(part.slice(open + 1, part.lastIndexOf('>'))) });
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    depth += char === '<' || char === '(' || char === '[' ? 1 : char === '>' || char === ')' || char === ']' ? -1 : 0;
    if (depth === 0 && (char === '.' || (char === ':' && text[i + 1] === ':'))) {
      add(i);
      i += char === ':' ? 1 : 0;
      start = i + 1;
    }
  }

  add(text.length);

  return parts;
}

/** `A, B<C, D>` -> `A`, `B<C, D>`. */
function splitTopLevel(text: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    depth += char === '<' || char === '(' || char === '[' ? 1 : char === '>' || char === ')' || char === ']' ? -1 : 0;
    if (depth === 0 && char === ',') {
      items.push(text.slice(start, i));
      start = i + 1;
    }
  }

  items.push(text.slice(start));

  return items;
}
