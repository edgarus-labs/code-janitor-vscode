import { CODE, classifyCSharp } from '../csharpScanner';
import { SourceTransformation } from '../types';

/** Strips the Unicode Byte Order Mark (U+FEFF) from the start of a source string. */
export const byteOrderMarkConverter: SourceTransformation = {
  name: 'Remove Byte Order Mark (BOM)',
  apply(source: string): string {
    if (!source) {
      return source;
    }

    return source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  },
};

/**
 * Ensures the source ends with exactly one line break, matching the line-break style already used
 * in the file.
 */
export const ensureFinalNewlineConverter: SourceTransformation = {
  name: 'Ensure final newline',
  apply(source: string): string {
    if (!source) {
      return source;
    }

    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const trimmed = source.replace(/[\r\n]+$/, '');

    return trimmed + newline;
  },
};

/** Collapses runs of two or more consecutive blank lines down to one. */
export const normalizeBlankLinesConverter: SourceTransformation = {
  name: 'Normalize blank lines',
  apply(source: string): string {
    if (!source) {
      return source;
    }

    return source.replace(/\r?\n(?:[^\S\r\n]*\r?\n){2,}/g, (match) => {
      const nl = match.includes('\r\n') ? '\r\n' : '\n';

      return nl + nl;
    });
  },
};

/** Removes `#region` / `#endregion` directive lines while preserving other preprocessor directives. */
export const regionDirectiveRemover: SourceTransformation = {
  name: 'Remove region directives',
  apply(source: string): string {
    if (!source) {
      return source;
    }

    return source.replace(/^[ \t]*#(?:end)?region\b[^\r\n]*(?:\r?\n)?/gm, '');
  },
};

/**
 * Removes trailing spaces/tabs at the end of a line, including whitespace-only lines, without
 * touching whitespace that belongs to a string literal or to the text of a comment.
 */
export const removeTrailingWhitespaceConverter: SourceTransformation = {
  name: 'Remove trailing whitespace',
  apply: removeTrailingWhitespace,
};

export function removeTrailingWhitespace(source: string): string {
  if (!source) {
    return source;
  }

  const kinds = classifyCSharp(source);
  const parts: string[] = [];
  const n = source.length;
  let lineStart = 0;

  for (let i = 0; i <= n; i++) {
    if (i !== n && source[i] !== '\n') {
      continue;
    }

    let contentEnd = i;
    if (contentEnd > lineStart && source[contentEnd - 1] === '\r') {
      contentEnd--;
    }

    let trimEnd = contentEnd;
    while (
      trimEnd > lineStart &&
      (source[trimEnd - 1] === ' ' || source[trimEnd - 1] === '\t') &&
      kinds[trimEnd - 1] === CODE
    ) {
      trimEnd--;
    }

    parts.push(source.slice(lineStart, trimEnd), source.slice(contentEnd, i === n ? n : i + 1));
    lineStart = i + 1;
  }

  return parts.join('');
}

const DEFAULT_TAB_SIZE = 4;

/**
 * Expands tabs used for indentation/layout into spaces, leaving tabs inside string/char literals
 * and comment text untouched.
 */
export function createTabToSpaceConverter(tabSize: number = DEFAULT_TAB_SIZE): SourceTransformation {
  if (tabSize < 1) {
    throw new RangeError('Tab size must be at least 1.');
  }

  const replacement = ' '.repeat(tabSize);

  return {
    name: 'Convert tabs to spaces',
    apply(source: string): string {
      if (!source) {
        return source;
      }

      if (!source.includes('\t')) {
        return source;
      }

      const kinds = classifyCSharp(source);
      let result = '';
      let copiedUpTo = 0;

      for (let i = 0; i < source.length; i++) {
        if (source[i] === '\t' && kinds[i] === CODE) {
          result += source.slice(copiedUpTo, i) + replacement;
          copiedUpTo = i + 1;
        }
      }

      return copiedUpTo === 0 ? source : result + source.slice(copiedUpTo);
    },
  };
}

/**
 * Updates `#endregion` directives to match the name of their corresponding `#region` directive and
 * normalizes whitespace around region names.
 */
export const updateEndRegionDirectivesConverter: SourceTransformation = {
  name: 'Update end region directives',
  apply(source: string): string {
    if (!source) {
      return source;
    }

    const lines = source.split(/\r\n|\r|\n/);
    const terminators = source.match(/\r\n|\r|\n/g) ?? [];
    const regionStack: string[] = [];
    let result = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.replace(/^\s+/, '');

      if (trimmedLine.startsWith('#region ')) {
        regionStack.push(trimmedLine.slice(8).trim());
        result += line;
      } else if (trimmedLine.startsWith('#endregion')) {
        if (regionStack.length > 0) {
          const matchingRegionName = regionStack.pop() ?? '';
          const indentation = getIndentation(line);
          result += indentation + (matchingRegionName ? `#endregion ${matchingRegionName}` : '#endregion');
        } else {
          result += line;
        }
      } else {
        result += line;
      }

      if (i < lines.length - 1) {
        result += terminators[i] ?? '\n';
      }
    }

    return result;
  },
};

function getIndentation(line: string): string {
  let count = 0;
  while (count < line.length && (line[count] === ' ' || line[count] === '\t')) {
    count++;
  }

  return line.slice(0, count);
}

const SINGLE_LINE_COMMENT = /^(\s*)\/\/\s*(.*)$/;
const MULTI_LINE_COMMENT_START = /^(\s*)\/\*/;

/**
 * Applies consistent spacing to `//` comments and realigns `*` continuation lines of `/* *\/`
 * comments. Only runs when the caller enables it (`formatComments`).
 */
export const commentFormatConverter: SourceTransformation = {
  name: 'Format comments',
  apply(source: string): string {
    if (!source) {
      return source;
    }

    const lines = source.split(/\r\n|\r|\n/);
    const result: string[] = [];
    let inMultiLineComment = false;
    let multiLineCommentIndentation = '';

    for (const line of lines) {
      if (inMultiLineComment) {
        if (line.includes('*/')) {
          inMultiLineComment = false;
          result.push(line);
        } else {
          result.push(normalizeMultiLineCommentLine(line, multiLineCommentIndentation));
        }

        continue;
      }

      const multiLineStartMatch = MULTI_LINE_COMMENT_START.exec(line);
      if (multiLineStartMatch) {
        inMultiLineComment = !line.includes('*/');
        multiLineCommentIndentation = multiLineStartMatch[1];
        result.push(line);
        continue;
      }

      const singleLineMatch = SINGLE_LINE_COMMENT.exec(line);
      if (singleLineMatch) {
        const indentation = singleLineMatch[1];
        const commentText = singleLineMatch[2];
        result.push(commentText.trim() ? `${indentation}// ${commentText.replace(/^\s+/, '')}` : `${indentation}//`);
        continue;
      }

      result.push(line);
    }

    const newline = source.includes('\r\n') ? '\r\n' : source.includes('\r') ? '\r' : '\n';

    return result.join(newline);
  },
};

function normalizeMultiLineCommentLine(line: string, baseIndentation: string): string {
  const trimmed = line.replace(/^\s+/, '');

  return trimmed.startsWith('*') ? `${baseIndentation} ${trimmed}` : line;
}
