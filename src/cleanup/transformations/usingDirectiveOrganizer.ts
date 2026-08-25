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
 * group `System` namespaces come first, then ordinal alphabetical.
 *
 * Formatting is preserved by keeping each original slot in place and only swapping the directive
 * text. A block that contains comments, preprocessor directives or `global using` directives is
 * left completely untouched, so no trivia or conditional structure is ever lost. Removing unused
 * usings is a semantic operation and stays out of scope.
 */
export const usingDirectiveOrganizer: SourceTransformation = {
  name: 'Sort using directives',
  apply(source: string): string {
    if (!source) {
      return source;
    }

    const tree = parseCSharp(source);

    try {
      const kinds = classifyCSharp(source);
      const edits: TextEdit[] = [];

      for (const container of usingContainers(tree.rootNode)) {
        collectSortEdits(source, kinds, container, edits);
      }

      return applyEdits(source, edits);
    } finally {
      tree.delete();
    }
  },
};

/** Every node that can directly hold a using block: the file, and each namespace body. */
function usingContainers(root: Node): Node[] {
  const containers: Node[] = [root];

  for (const namespaceNode of findAll(root, ['namespace_declaration', 'file_scoped_namespace_declaration'])) {
    const body = namespaceNode.childForFieldName('body');
    containers.push(body && body.type === 'declaration_list' ? body : namespaceNode);
  }

  return containers;
}

function collectSortEdits(source: string, kinds: Uint8Array, container: Node, edits: TextEdit[]): void {
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
    (a, b) => groupRank(a) - groupRank(b) || systemRank(a) - systemRank(b) || compareOrdinal(sortName(a), sortName(b))
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

  return directive.name === 'System' || directive.name.startsWith('System.') ? 0 : 1;
}

function sortName(directive: ParsedUsing): string {
  return directive.alias ?? directive.name;
}

function compareOrdinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
