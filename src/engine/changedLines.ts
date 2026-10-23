import { diffLineHunks } from '../cleanup/lineDiff';
import { LineRange } from './protocol';

/**
 * The `changedLines` of a cleanup request: the 1-based inclusive ranges of the lines of `current` added
 * or modified since `base` (the file at HEAD), or `null` (every line) for a file Git does not know yet.
 * A byte order mark and the line ending style are not changes.
 */
export function changedLineRanges(base: string | undefined, current: string): LineRange[] | null {
  if (base === undefined) {
    return null;
  }

  const normalize = (text: string) => text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

  return diffLineHunks(normalize(base), normalize(current))
    .filter((hunk) => hunk.afterEnd > hunk.afterStart)
    .map((hunk) => ({ start: hunk.afterStart + 1, end: hunk.afterEnd }));
}
