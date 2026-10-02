import * as vscode from 'vscode';
import { lineRangeToSort, sortLineRange } from '../reorganize/sortLines';

/**
 * Replaces the document's text with `newText`, changing only the part between the common start and
 * the common end of the two texts, so the cursor, folding and scroll position outside of it stay.
 */
export async function replaceChangedPart(editor: vscode.TextEditor, newText: string): Promise<boolean> {
  const document = editor.document;
  const oldText = document.getText();
  if (oldText === newText) {
    return true;
  }

  const limit = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < limit && oldText[prefix] === newText[prefix]) {
    prefix++;
  }

  let suffix = 0;
  while (suffix < limit - prefix && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]) {
    suffix++;
  }

  const range = new vscode.Range(document.positionAt(prefix), document.positionAt(oldText.length - suffix));

  return editor.edit((builder) => builder.replace(range, newText.slice(prefix, newText.length - suffix)));
}

/** The lines a selection covers: a last line the selection only reaches the start of is left out. */
export function selectedLines(selection: vscode.Selection): { firstLine: number; lastLine: number } {
  const endsAtLineStart = selection.end.character === 0 && selection.end.line > selection.start.line;

  return { firstLine: selection.start.line, lastLine: endsAtLineStart ? selection.end.line - 1 : selection.end.line };
}

/** Sort Lines (`SortLinesCommand`): sorts the selected lines, or the current and the next one. */
export async function sortLinesInEditor(editor: vscode.TextEditor): Promise<void> {
  const { selection, document } = editor;
  const { firstLine, lastLine } = lineRangeToSort(
    { startLine: selection.start.line, startCharacter: selection.start.character, endLine: selection.end.line, endCharacter: selection.end.character },
    document.lineCount
  );

  await replaceChangedPart(editor, sortLineRange(document.getText(), firstLine, lastLine));
}
