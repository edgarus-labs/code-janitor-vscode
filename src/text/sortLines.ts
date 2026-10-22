/**
 * Sort Lines, as `SortLinesCommand` of the Visual Studio extension does it: the lines of the
 * selection without the empty ones, ordered with the culture-aware string comparer (so `a`, `A`,
 * `b`), each followed by a line break.
 */

export interface LineSelection {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

// Pinned like the member comparer: the process locale (LANG) would otherwise decide whether `A` sorts before `a`.
const comparer = new Intl.Collator('en-US');

/**
 * The lines a selection sorts: with nothing selected the line of the cursor and the next one;
 * otherwise from the first selected line to the last, leaving out a last line the selection only
 * reaches the start of.
 */
export function lineRangeToSort(selection: LineSelection, lineCount: number): { firstLine: number; lastLine: number } {
  const isEmpty = selection.startLine === selection.endLine && selection.startCharacter === selection.endCharacter;

  if (isEmpty) {
    return { firstLine: selection.startLine, lastLine: Math.min(selection.startLine + 1, lineCount - 1) };
  }

  const endsAtLineStart = selection.endCharacter === 0 && selection.endLine > selection.startLine;

  return { firstLine: selection.startLine, lastLine: endsAtLineStart ? selection.endLine - 1 : selection.endLine };
}

/** `text` with the lines `firstLine` to `lastLine` (zero-based, inclusive) sorted; `text` itself when they already are. */
export function sortLineRange(text: string, firstLine: number, lastLine: number): string {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lineStarts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) {
    lineStarts.push(i + 1);
  }

  const start = lineStarts[Math.min(firstLine, lineStarts.length - 1)];
  const end = lastLine + 1 < lineStarts.length ? lineStarts[lastLine + 1] : text.length;
  const selected = text.slice(start, end);

  const sorted = selected
    .split(/\r\n|\n|\r/)
    .filter((line) => line.length > 0)
    .sort(comparer.compare)
    .map((line) => line + newline)
    .join('');

  return selected === sorted ? text : text.slice(0, start) + sorted + text.slice(end);
}
