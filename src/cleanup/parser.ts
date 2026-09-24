import { memoizeBySource } from './sourceCache';
import { Node, Tree } from './syntax/node';
import { parseCSharpSource } from './syntax/parser';

/**
 * Entry point for the syntax-aware transformations. Parsing is native TypeScript and synchronous,
 * so there is no runtime to initialize and nothing platform-specific to ship.
 */

export { Node, Tree };

/**
 * The syntax tree of `source`. Trees are shared: the same text returns the same tree, so callers
 * must not modify it (see `sourceCache.ts`).
 */
export const parseCSharp: (source: string) => Tree = memoizeBySource(parseCSharpSource);

/** Every named node of the tree under `node` (included), depth first, parents before children. */
export function walk(node: Node): Node[] {
  const nodes: Node[] = [];
  const pending: Node[] = [node];
  while (pending.length > 0) {
    const current = pending.pop() as Node;
    nodes.push(current);
    const children = current.namedChildren;
    for (let i = children.length - 1; i >= 0; i--) {
      pending.push(children[i]);
    }
  }

  return nodes;
}

export function findAll(root: Node, type: string | readonly string[]): Node[] {
  const types = typeof type === 'string' ? [type] : type;
  const matches: Node[] = [];
  const pending: Node[] = [root];
  while (pending.length > 0) {
    const current = pending.pop() as Node;
    if (types.includes(current.type)) {
      matches.push(current);
    }

    const children = current.namedChildren;
    for (let i = children.length - 1; i >= 0; i--) {
      pending.push(children[i]);
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
