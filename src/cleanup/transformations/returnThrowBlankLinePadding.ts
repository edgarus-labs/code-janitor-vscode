import { Node, findAll, parseCSharp } from '../parser';
import { SourceTransformation } from '../types';

const NON_STATEMENT_TYPES = new Set(['comment']);

/**
 * Inserts a blank line before a `return` or `throw` statement when it is preceded by at least one
 * other statement in the same block, visually separating the exit path from the preceding logic.
 * Idempotent: does nothing when a blank line already precedes it, or when the statement is the
 * first one in its block.
 */
export const returnThrowBlankLinePaddingConverter: SourceTransformation = {
  name: 'Blank Line Before Return/Throw',
  apply(source: string): string {
    if (!source) {
      return source;
    }

    const tree = parseCSharp(source);
    let candidateLines: number[];

    try {
      const candidates = new Set<number>();

      for (const statement of findAll(tree.rootNode, ['return_statement', 'throw_statement'])) {
        const block = statement.parent;
        if (!block || block.type !== 'block') {
          continue;
        }

        if (statementIndexInBlock(block, statement) <= 0) {
          continue;
        }

        candidates.add(statement.startPosition.row);
      }

      candidateLines = [...candidates];
    } finally {
      tree.delete();
    }

    if (candidateLines.length === 0) {
      return source;
    }

    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const lines = source.split(newline);

    for (const lineIndex of candidateLines.sort((a, b) => b - a)) {
      if (lineIndex <= 0 || lineIndex > lines.length - 1) {
        continue;
      }

      if (!lines[lineIndex - 1].trim()) {
        continue;
      }

      lines.splice(lineIndex, 0, '');
    }

    return lines.join(newline);
  },
};

/** Comments are trivia, so they must not shift a statement's position within its block. */
function statementIndexInBlock(block: Node, statement: Node): number {
  let index = 0;

  for (const child of block.namedChildren) {
    if (!child || NON_STATEMENT_TYPES.has(child.type)) {
      continue;
    }

    if (child.id === statement.id) {
      return index;
    }

    index++;
  }

  return -1;
}
