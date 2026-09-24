import { STRING, classifyCSharp } from '../csharpScanner';
import { Node, TextEdit, applyEdits, findAll, parseCSharp } from '../parser';
import { SourceTransformation } from '../types';
import { lineStartAt, nextLineStartAt } from './editorConfigSupport';

const NAMESPACE_TYPES = ['namespace_declaration', 'file_scoped_namespace_declaration'];

/**
 * Moves `using` directives out of namespace declarations (block-scoped and file-scoped) up to the
 * compilation unit, preserving the file header and deduplicating directives.
 */
export const moveUsingsOutsideNamespaceConverter: SourceTransformation = {
  name: 'Move using directives outside namespace',
  apply: (source) => (usingsCanMoveOutside(source) ? moveUsingsOutside(source) : source),
};

const WELL_KNOWN_ROOTS: Record<string, true> = { System: true, Microsoft: true };

/**
 * True when a using directive names the same thing inside and outside the namespace: `global::`
 * names, `System`/`Microsoft` names and names starting with the namespace's first segment. Other
 * names may resolve relative to the enclosing namespace
 * (https://learn.microsoft.com/dotnet/csharp/language-reference/keywords/using-directive).
 */
export function isFullyQualifiedUsing(text: string, namespaceRoot: string | undefined): boolean {
  const target = /^using\s+(?:static\s+)?(?:@?\w+\s*=\s*)?([\s\S]*?);$/.exec(text.trim())?.[1].trim();
  if (!target) {
    return false;
  }

  if (target.startsWith('global::')) {
    return true;
  }

  const first = target.split(/[.<:\s]/)[0];

  return WELL_KNOWN_ROOTS[first] === true || first === namespaceRoot;
}

/** True when the file has one namespace and every using inside it is fully qualified. */
function usingsCanMoveOutside(source: string): boolean {
  if (!source) {
    return false;
  }

  const tree = parseCSharp(source);
  try {
    const namespaces = findAll(tree.rootNode, NAMESPACE_TYPES);
    const root = namespaces[0]?.childForFieldName('name')?.text.split('.')[0];

    return namespaces.length === 1 && directUsings(namespaces[0]).every((directive) => isFullyQualifiedUsing(directive.text, root));
  } finally {
    tree.delete();
  }
}

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
      start: lineStartAt(source, directive.startIndex),
      end: nextLineStartAt(source, directive.endIndex),
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
    return nextLineStartAt(source, topUsings[topUsings.length - 1].endIndex);
  }

  const firstToken = root.namedChildren.find((child) => child && child.type !== 'comment');

  return firstToken ? firstToken.startIndex : 0;
}

function usingKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
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
    const dedented = dedent(current, openBrace.endIndex, closeBrace.startIndex);

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

/**
 * `source` between `start` and `end` without its surrounding blank lines, with one indentation
 * level (four spaces or a tab) removed from every line that starts in code. Lines that continue a
 * string literal (verbatim, raw, multi-line interpolated) and every line break keep their text.
 */
function dedent(source: string, start: number, end: number): string {
  const kinds = classifyCSharp(source);
  const body = source.slice(start, end);
  const first = body.search(/[^\r\n]/);
  if (first < 0) {
    return '';
  }

  let result = '';
  let lineStart = first;
  while (lineStart < body.length) {
    const next = body.indexOf('\n', lineStart);
    const lineEnd = next < 0 ? body.length : next + 1;
    const line = body.slice(lineStart, lineEnd);
    const inString = lineStart > 0 && kinds[start + lineStart - 1] === STRING;
    result += inString ? line : line.startsWith('    ') ? line.slice(4) : line.startsWith('\t') ? line.slice(1) : line;
    lineStart = lineEnd;
  }

  return result.replace(/[\r\n]+$/, '');
}
