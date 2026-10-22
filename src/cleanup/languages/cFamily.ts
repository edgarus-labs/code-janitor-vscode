import { CleanupSettings } from '../types';
import { padLines } from './padLines';

/** `{`, an optional trailing `//` comment, then blank lines (`RemoveBlankLinesAfterOpeningBrace`). */
const BLANK_LINES_AFTER_OPENING_BRACE = /\{([ \t]*(?:\/\/[^\r\n]*)?)(\r?\n)(?:[ \t]*\r?\n)+/g;

/** Blank lines, then a line starting with `}` (`RemoveBlankLinesBeforeClosingBrace`). */
const BLANK_LINES_BEFORE_CLOSING_BRACE = /(\r?\n)(?:[ \t]*\r?\n)+([ \t]*)\}/g;

const LINE_COMMENT = /^[ \t]*\/\/(?!\/)/;

/** The blank line removals of the C-family languages (`RunCodeCleanupC`): after `{` and before `}`. */
export function removeCFamilyBlankLines(source: string, settings: CleanupSettings): string {
  let text = source;
  if (settings.removeBlankLinesAfterOpeningBrace) {
    text = text.replace(BLANK_LINES_AFTER_OPENING_BRACE, '{$1$2');
  }

  if (settings.removeBlankLinesBeforeClosingBrace) {
    text = text.replace(BLANK_LINES_BEFORE_CLOSING_BRACE, '$1$2}');
  }

  return text;
}

/**
 * A blank line before a `//` comment line that follows code (`InsertPaddingBeforeSingleLineComments`), as the C#
 * engine does it: not after another comment, a line with a comment, or a line opening a brace; never before `///`.
 */
export function padCFamilyComments(source: string, settings: CleanupSettings): string {
  if (!settings.insertBlankLinePaddingBeforeSingleLineComments) {
    return source;
  }

  return padLines(source, (lines, index) => {
    if (!LINE_COMMENT.test(lines[index])) {
      return false;
    }

    const previous = lines[index - 1].trim();

    return !previous.startsWith('{') && !previous.endsWith('{') && !previous.includes('//');
  });
}
