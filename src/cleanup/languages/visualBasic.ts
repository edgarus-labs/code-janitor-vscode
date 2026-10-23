import { CleanupSettings } from '../types';
import { padLines } from './padLines';

const REGION_DIRECTIVE = /^[ \t]*#(?:Region|End[ \t]+Region)\b[^\r\n]*(?:\r?\n|$)/gim;

/**
 * An attribute alone on its line (not an `Assembly:`/`Module:` one), then blank lines, unless the next line that is
 * not blank is a comment.
 */
const BLANK_LINES_AFTER_ATTRIBUTE =
  /^([ \t]*<(?![ \t]*(?:Assembly|Module)[ \t]*:)[A-Za-z_][^\r\n]*>[ \t]*)(\r?\n)(?:[ \t]*\r?\n)+(?!(?:[ \t]*\r?\n)*[ \t]*')/gim;

/** `BlankLinesAfterVisualBasicDocumentationCommentPattern`. */
const BLANK_LINES_AFTER_DOCUMENTATION_COMMENT = /^([ \t]*'''(?!')[^\r\n]*)(\r?\n)(?:[ \t]*\r?\n)+/gm;

const BLANK_LINES_BEFORE_CHAINED_STATEMENT = /(\r?\n)(?:[ \t]*\r?\n)+([ \t]*)(Else|ElseIf|Catch|Finally)\b/gi;

const REGION_START = /^[ \t]*#Region\b/i;
const REGION_END = /^[ \t]*#End[ \t]+Region\b/i;
const CASE = /^[ \t]*Case\b/i;
const SELECT_CASE = /^[ \t]*Select[ \t]+Case\b/i;
const COMMENT = /^[ \t]*'(?!'')/;

/** A line after which a comment opens a block: a declaration or a statement whose body follows. */
const BLOCK_OPENER =
  /^(?:(?:Public|Private|Protected|Friend|Shared|Overrides|Overridable|MustOverride|NotOverridable|Overloads|Shadows|Static|ReadOnly|WriteOnly|Partial|MustInherit|NotInheritable|Async|Iterator|Default|Widening|Narrowing|Custom)[ \t]+)*(?:Sub|Function|Class|Module|Structure|Interface|Namespace|Property|Enum|Get|Set|Operator|Event|Select|Case|Do|While|For|Try|Catch|Finally|Else|ElseIf|With|Using|SyncLock)\b|\bThen$/i;

/** Removes the `#Region` and `#End Region` directive lines (the text-level `RemoveRegions` of Visual Basic). */
export function removeVisualBasicRegions(source: string): string {
  return source.replace(REGION_DIRECTIVE, '');
}

/**
 * The blank line removals of Visual Basic (`RunCodeCleanupVB`): after attributes, after documentation comments
 * (always, as in Visual Studio) and before `Else`, `ElseIf`, `Catch` and `Finally`.
 */
export function removeVisualBasicBlankLines(source: string, settings: CleanupSettings): string {
  let text = source;
  if (settings.removeBlankLinesAfterAttributes) {
    text = text.replace(BLANK_LINES_AFTER_ATTRIBUTE, '$1$2');
  }

  text = text.replace(BLANK_LINES_AFTER_DOCUMENTATION_COMMENT, '$1$2');
  if (settings.removeBlankLinesBetweenChainedStatements) {
    text = text.replace(BLANK_LINES_BEFORE_CHAINED_STATEMENT, '$1$2$3');
  }

  return text;
}

/**
 * The blank line padding of Visual Basic that needs no code model: around `#Region`/`#End Region`, before a `Case`
 * that follows the statements of the previous `Case`, and before a `'` comment that follows code.
 */
export function padVisualBasic(source: string, settings: CleanupSettings): string {
  return padLines(source, (lines, index) => {
    const line = lines[index];
    const previous = lines[index - 1];
    if (
      (settings.insertBlankLinePaddingBeforeRegionTags && REGION_START.test(line)) ||
      (settings.insertBlankLinePaddingBeforeEndRegionTags && REGION_END.test(line)) ||
      (settings.insertBlankLinePaddingAfterRegionTags && REGION_START.test(previous)) ||
      (settings.insertBlankLinePaddingAfterEndRegionTags && REGION_END.test(previous))
    ) {
      return true;
    }

    if (settings.insertBlankLinePaddingBeforeCaseStatements && CASE.test(line) && !SELECT_CASE.test(line)) {
      return !SELECT_CASE.test(previous) && !CASE.test(previous) && !COMMENT.test(previous);
    }

    if (settings.insertBlankLinePaddingBeforeSingleLineComments && COMMENT.test(line)) {
      const code = previous.trim();

      return !code.startsWith("'") && !code.startsWith('#') && !BLOCK_OPENER.test(code) && !hasComment(code);
    }

    return false;
  });
}

/** Whether a line of code ends with a `'` comment (outside a string literal). */
function hasComment(line: string): boolean {
  let inString = false;
  for (const char of line) {
    if (char === '"') {
      inString = !inString;
    } else if (char === "'" && !inString) {
      return true;
    }
  }

  return false;
}
