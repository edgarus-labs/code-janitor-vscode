import { EditorConfigProperties, loadEditorConfigProperties } from './editorconfig';
import { padCFamilyComments, removeCFamilyBlankLines } from './languages/cFamily';
import { commentPrefix, detectLanguage, languageFamily } from './languages/codeLanguage';
import { applyFileHeader } from './languages/fileHeader';
import { cleanupMarkup } from './languages/markup';
import { padVisualBasic, removeVisualBasicBlankLines, removeVisualBasicRegions } from './languages/visualBasic';
import { CleanupSettings } from './types';

/** Formats the comments of `text` that start with `commentPrefix` (the C# engine's comment formatter). */
export type CommentTextFormatter = (text: string, commentPrefix: string) => Promise<string>;

/**
 * The cleanup of the files that are not C#: plain-text rules only, the text is never parsed. Each language gets
 * the steps of its family in Visual Studio (`CodeCleanupManager.FindCodeCleanupMethod`): the file header and the
 * layout rules for every language, plus the brace and comment rules of the C-family languages, the tag rules of
 * markup and the text-level rules of Visual Basic. The `.editorconfig` core properties of the file override the
 * corresponding settings. `languageId` (the VS Code language of the document) decides when the extension does not.
 */
export function runLayoutCleanup(source: string, filePath: string, settings: CleanupSettings, languageId?: string): string {
  if (!source) {
    return source;
  }

  const language = detectLanguage(filePath, languageId);
  const family = languageFamily(language);
  const props = loadEditorConfigProperties(filePath);
  const charset = acceptedValue(props, 'charset', ['utf-8', 'utf-8-bom']);
  const trim = acceptedValue(props, 'trim_trailing_whitespace', ['true', 'false']);
  const finalNewline = acceptedValue(props, 'insert_final_newline', ['true', 'false']) !== 'false';

  let text = applyFileHeader(source, language, settings);
  if (charset === undefined ? settings.removeByteOrderMark : charset === 'utf-8') {
    text = text.replace(/^\uFEFF/, '');
  }

  if (acceptedValue(props, 'indent_style', ['space', 'tab']) === 'space') {
    const width = tabWidth(props);
    text = text.replace(/^[ \t]*\t[ \t]*/gm, (indentation) => ' '.repeat(indentColumns(indentation, width)));
  }

  if (family === 'vb' && settings.removeRegions) {
    text = removeVisualBasicRegions(text);
  }

  if (trim === undefined ? settings.removeEndOfLineWhitespace : trim === 'true') {
    text = text.replace(/[ \t]+(?=\r?\n)/g, '').replace(/[ \t]+$/, '');
  }

  if (settings.removeBlankLinesAtTop) {
    text = text.replace(/^(?:[ \t]*\r?\n)+/, '');
  }

  if (settings.removeBlankLinesAtBottom) {
    text = removeBlankLinesAtBottom(text, finalNewline);
  }

  if (family === 'cFamily') {
    text = removeCFamilyBlankLines(text, settings);
  } else if (family === 'markup') {
    text = cleanupMarkup(text, settings, language === 'html');
  } else if (family === 'vb') {
    text = removeVisualBasicBlankLines(text, settings);
  }

  if (settings.removeMultipleConsecutiveBlankLines) {
    text = text.replace(/\r?\n(?:[^\S\r\n]*\r?\n){2,}/g, (match) => (match.includes('\r\n') ? '\r\n\r\n' : '\n\n'));
  }

  if (family === 'cFamily') {
    text = padCFamilyComments(text, settings);
  } else if (family === 'vb') {
    text = padVisualBasic(text, settings);
  }

  if (!finalNewline || !text) {
    return text;
  }

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  if (settings.removeBlankLinesAtBottom) {
    return text.replace(/[\r\n]+$/, '') + eol;
  }

  return text.endsWith('\n') ? text : text + eol;
}

/**
 * {@link runLayoutCleanup}, then, for Visual Basic with `formatComments` on, the comment formatting Visual Studio
 * runs at the end of its Visual Basic cleanup, through `formatComments`.
 */
export async function runLanguageCleanup(
  source: string,
  filePath: string,
  settings: CleanupSettings,
  options: { readonly languageId?: string; readonly formatComments: CommentTextFormatter }
): Promise<string> {
  const text = runLayoutCleanup(source, filePath, settings, options.languageId);
  const language = detectLanguage(filePath, options.languageId);

  return language === 'vb' && settings.formatComments && text ? options.formatComments(text, commentPrefix(language)!) : text;
}

/** The value of `key`, lower-cased, when it is one of `accepted`; an unknown value is ignored. */
function acceptedValue(props: EditorConfigProperties, key: string, accepted: readonly string[]): string | undefined {
  const value = props.get(key)?.trim().toLowerCase();

  return value !== undefined && accepted.includes(value) ? value : undefined;
}

/** Width of a tab character: `tab_width`, else a numeric `indent_size`, else 4. */
function tabWidth(props: EditorConfigProperties): number {
  const width = [props.get('tab_width'), props.get('indent_size')].find((raw) => raw !== undefined && /^\s*\d+\s*$/.test(raw) && Number.parseInt(raw, 10) > 0);

  return width === undefined ? 4 : Number.parseInt(width, 10);
}

/** The visual width of `indentation` with tab stops every `width` columns. */
function indentColumns(indentation: string, width: number): number {
  let columns = 0;
  for (const char of indentation) {
    columns = char === '\t' ? columns + width - (columns % width) : columns + 1;
  }

  return columns;
}

/** Removes the blank lines at the end, with the final newline unless `keepFinalNewline` (then exactly one stays). */
function removeBlankLinesAtBottom(source: string, keepFinalNewline: boolean): string {
  const trailing = /(?:\r?\n[ \t]*)+$/.exec(source);
  if (!trailing) {
    return source;
  }

  return source.slice(0, trailing.index) + (keepFinalNewline ? (trailing[0].startsWith('\r\n') ? '\r\n' : '\n') : '');
}
