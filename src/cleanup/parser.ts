import { Node, Tree } from './syntax/node';
import { parseCSharpSource } from './syntax/parser';

/**
 * Entry point for the syntax-aware transformations. Parsing is native TypeScript and synchronous,
 * so there is no runtime to initialize and nothing platform-specific to ship.
 */

export { Node, Tree };

export function parseCSharp(source: string): Tree {
  return parseCSharpSource(source);
}

/** Depth-first walk over every named node of the tree. */
export function* walk(node: Node): Generator<Node> {
  yield node;

  for (const child of node.namedChildren) {
    yield* walk(child);
  }
}

/** Depth-first walk including anonymous nodes (punctuation, keywords). */
export function* walkAll(node: Node): Generator<Node> {
  yield node;

  for (const child of node.children) {
    yield* walkAll(child);
  }
}

export function findAll(root: Node, type: string | readonly string[]): Node[] {
  const types = typeof type === 'string' ? [type] : type;
  const matches: Node[] = [];

  for (const node of walk(root)) {
    if (types.includes(node.type)) {
      matches.push(node);
    }
  }

  return matches;
}

export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/** Applies non-overlapping edits to the source, right to left so offsets stay valid. */
export function applyEdits(source: string, edits: readonly TextEdit[]): string {
  if (edits.length === 0) {
    return source;
  }

  const ordered = [...edits].sort((a, b) => b.start - a.start);
  let result = source;
  let previousStart = Number.POSITIVE_INFINITY;

  for (const edit of ordered) {
    if (edit.end > previousStart) {
      continue;
    }

    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    previousStart = edit.start;
  }

  return result;
}
