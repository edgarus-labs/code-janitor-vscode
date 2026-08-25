import { Node, TextEdit, applyEdits, findAll, parseCSharp } from '../parser';
import { SourceTransformation } from '../types';

const NAMESPACE_TYPES = ['namespace_declaration', 'file_scoped_namespace_declaration'];

/**
 * Moves `using` directives out of namespace declarations (block-scoped and file-scoped) up to the
 * compilation unit, preserving the file header and deduplicating directives.
 */
export const moveUsingsOutsideNamespaceConverter: SourceTransformation = {
  name: 'Move using directives outside namespace',
  apply: moveUsingsOutside,
};

export function moveUsingsOutside(source: string): string {
  if (!source) {
    return source;
  }

  const tree = parseCSharp(source);

  try {
    const root = tree.rootNode;
    const namespaceUsings: Node[] = [];

    for (const namespaceNode of findAll(root, NAMESPACE_TYPES)) {
      namespaceUsings.push(...directUsings(namespaceNode));
    }

    if (namespaceUsings.length === 0) {
      return source;
    }

    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const topUsings = root.namedChildren.filter((child): child is Node => child?.type === 'using_directive');

    const seen = new Set(topUsings.map((directive) => usingKey(directive.text)));
    const additions: string[] = [];
    for (const directive of namespaceUsings) {
      const key = usingKey(directive.text);
      if (!seen.has(key)) {
        seen.add(key);
        additions.push(directive.text);
      }
    }

    const edits: TextEdit[] = namespaceUsings.map((directive) => ({
      start: lineStart(source, directive.startIndex),
      end: lineEnd(source, directive.endIndex),
      text: '',
    }));

    if (additions.length > 0) {
      const insertion = insertionPoint(root, topUsings, source);
      const separator = topUsings.length > 0 ? newline : newline + newline;
      edits.push({
        start: insertion,
        end: insertion,
        text: additions.join(newline) + separator,
      });
    }

    return applyEdits(source, edits);
  } finally {
    tree.delete();
  }
}

/** Usings declared directly in a namespace, not those nested in an inner namespace. */
function directUsings(namespaceNode: Node): Node[] {
  const body = namespaceNode.childForFieldName('body');
  const container = body && body.type === 'declaration_list' ? body : namespaceNode;

  return container.namedChildren.filter((child): child is Node => child?.type === 'using_directive');
}

/**
 * After the last top-level using, or - when there is none - at the first token of the file, which
 * keeps a file header comment in front of the moved directives.
 */
function insertionPoint(root: Node, topUsings: readonly Node[], source: string): number {
  if (topUsings.length > 0) {
    return lineEnd(source, topUsings[topUsings.length - 1].endIndex);
  }

  const firstToken = root.namedChildren.find((child) => child && child.type !== 'comment');

  return firstToken ? firstToken.startIndex : 0;
}

function usingKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function lineStart(source: string, index: number): number {
  const newlineIndex = source.lastIndexOf('\n', Math.max(0, index - 1));

  return newlineIndex < 0 ? 0 : newlineIndex + 1;
}

function lineEnd(source: string, index: number): number {
  const newlineIndex = source.indexOf('\n', index);

  return newlineIndex < 0 ? source.length : newlineIndex + 1;
}

/**
 * Converts a single top-level block-scoped namespace to a file-scoped namespace, dedenting the
 * body by one indentation level.
 */
export const fileScopedNamespaceConverter: SourceTransformation = {
  name: 'File-Scoped Namespace',
  apply: convertToFileScoped,
};

export function convertToFileScoped(source: string): string {
  if (!source) {
    return source;
  }

  let current = source;
  let tree = parseCSharp(current);

  try {
    if (findAll(tree.rootNode, 'file_scoped_namespace_declaration').length > 0) {
      return source;
    }

    let blockNamespaces = findAll(tree.rootNode, 'namespace_declaration');
    if (blockNamespaces.length !== 1 || blockNamespaces[0].parent?.type !== 'compilation_unit') {
      return source;
    }

    if (directUsings(blockNamespaces[0]).length > 0) {
      const moved = moveUsingsOutside(current);
      if (moved !== current) {
        current = moved;
        tree.delete();
        tree = parseCSharp(current);
        blockNamespaces = findAll(tree.rootNode, 'namespace_declaration');
        if (blockNamespaces.length !== 1) {
          return current;
        }
      }
    }

    const namespaceNode = blockNamespaces[0];
    const openBrace = namespaceNode.descendantsOfType('{')[0];
    const closeBrace = findCloseBrace(namespaceNode);
    const name = namespaceNode.childForFieldName('name')?.text;
    if (!openBrace || !closeBrace || !name) {
      return current;
    }

    const header = current.slice(0, namespaceNode.startIndex);
    const body = current.slice(openBrace.endIndex, closeBrace.startIndex);
    const newline = body.includes('\r\n') ? '\r\n' : '\n';
    const dedented = dedent(body, newline);

    let result = `${header}namespace ${name};`;
    if (dedented.trim()) {
      result += newline + newline + dedented;
    }

    return result + newline;
  } finally {
    tree.delete();
  }
}

export function hasMultipleNamespaces(source: string): boolean {
  if (!source) {
    return false;
  }

  const tree = parseCSharp(source);

  try {
    return findAll(tree.rootNode, NAMESPACE_TYPES).length > 1;
  } finally {
    tree.delete();
  }
}

function findCloseBrace(namespaceNode: Node): Node | undefined {
  const body = namespaceNode.childForFieldName('body');
  const container = body && body.type === 'declaration_list' ? body : namespaceNode;

  for (let i = container.childCount - 1; i >= 0; i--) {
    const child = container.child(i);
    if (child?.type === '}') {
      return child;
    }
  }

  return undefined;
}

/** Removes one indentation level (four spaces or a tab) after trimming surrounding blank lines. */
function dedent(body: string, newline: string): string {
  const trimmed = body.replace(/^[\r\n]+/, '').replace(/[\r\n]+$/, '');

  return trimmed
    .split(newline)
    .map((line) => (line.startsWith('    ') ? line.slice(4) : line.startsWith('\t') ? line.slice(1) : line))
    .join(newline);
}
