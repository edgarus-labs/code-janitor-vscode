import { Node } from 'web-tree-sitter';
import { TextEdit, applyEdits, findAll, parseCSharp } from '../parser';
import { SourceTransformation } from '../types';

/**
 * Removes XML documentation comments (`///` and `/** ... *\/`) together with the indentation and
 * the line break that belong to them, so no blank line is left behind.
 */
export const removeXmlDocumentationConverter: SourceTransformation = {
  name: 'Remove XML documentation comments',
  apply(source: string): string {
    if (!source) {
      return source;
    }

    const tree = parseCSharp(source);

    try {
      const edits: TextEdit[] = [];

      for (const comment of findAll(tree.rootNode, 'comment')) {
        if (!isDocumentationComment(comment)) {
          continue;
        }

        const start = lineStartIfOnlyWhitespaceBefore(source, comment);
        edits.push({ start, end: endOfLine(source, comment.endIndex), text: '' });
      }

      return applyEdits(source, edits);
    } finally {
      tree.delete();
    }
  },
};

export function hasXmlDocumentation(source: string): boolean {
  if (!source) {
    return false;
  }

  const tree = parseCSharp(source);

  try {
    return findAll(tree.rootNode, 'comment').some(isDocumentationComment);
  } finally {
    tree.delete();
  }
}

function isDocumentationComment(comment: Node): boolean {
  const text = comment.text;

  return text.startsWith('///') || text.startsWith('/**');
}

/** Keeps a trailing comment in place on a code line; only whole comment lines lose their indent. */
function lineStartIfOnlyWhitespaceBefore(source: string, comment: Node): number {
  const newlineIndex = source.lastIndexOf('\n', Math.max(0, comment.startIndex - 1));
  const lineStart = newlineIndex < 0 ? 0 : newlineIndex + 1;

  return source.slice(lineStart, comment.startIndex).trim() ? comment.startIndex : lineStart;
}

function endOfLine(source: string, index: number): number {
  for (let i = index; i < source.length; i++) {
    if (source[i] === '\n') {
      return i + 1;
    }

    if (source[i] !== ' ' && source[i] !== '\t' && source[i] !== '\r') {
      return index;
    }
  }

  return source.length;
}
