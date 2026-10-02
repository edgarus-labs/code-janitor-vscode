import { describe, expect, it } from 'vitest';
import { lineRangeToSort, sortLineRange } from '../src/reorganize/sortLines';

// Ported from SortLinesCommand.SortText: the selected lines, empty lines dropped, sorted with the
// culture comparer, each followed by a line break.
describe('sort lines', () => {
  it('sorts the lines of the range and leaves the rest', () => {
    expect(sortLineRange('head\nc\nb\na\ntail\n', 1, 3)).toBe('head\na\nb\nc\ntail\n');
  });

  it('drops empty lines, like the Visual Studio command', () => {
    expect(sortLineRange('b\n\nA\n\na\n', 0, 4)).toBe('a\nA\nb\n');
  });

  it('keeps lines that are only whitespace', () => {
    expect(sortLineRange('b\n  \na\n', 0, 2)).toBe('  \na\nb\n');
  });

  it('compares the way a culture-aware comparer does, not by code unit', () => {
    expect(sortLineRange('b\nB\na\nA\n', 0, 3)).toBe('a\nA\nb\nB\n');
    expect(sortLineRange('_x\nz\nY\n', 0, 2)).toBe('_x\nY\nz\n');
  });

  it('uses the line breaks of the file', () => {
    expect(sortLineRange('b\r\na\r\nz\r\n', 0, 1)).toBe('a\r\nb\r\nz\r\n');
  });

  it('gives the last line a line break, as AppendLine does', () => {
    expect(sortLineRange('b\na', 0, 1)).toBe('a\nb\n');
  });

  it('returns the text unchanged when the lines are already sorted', () => {
    const text = 'x\na\nb\nc\ny';

    expect(sortLineRange(text, 1, 3)).toBe(text);
  });

  it('sorts the current and the next line when nothing is selected', () => {
    expect(lineRangeToSort({ startLine: 2, startCharacter: 4, endLine: 2, endCharacter: 4 }, 10)).toEqual({ firstLine: 2, lastLine: 3 });
    expect(lineRangeToSort({ startLine: 9, startCharacter: 0, endLine: 9, endCharacter: 0 }, 10)).toEqual({ firstLine: 9, lastLine: 9 });
  });

  it('sorts whole lines from the first selected line to the last, leaving out a last line that starts at the selection end', () => {
    expect(lineRangeToSort({ startLine: 1, startCharacter: 3, endLine: 4, endCharacter: 2 }, 10)).toEqual({ firstLine: 1, lastLine: 4 });
    expect(lineRangeToSort({ startLine: 1, startCharacter: 3, endLine: 4, endCharacter: 0 }, 10)).toEqual({ firstLine: 1, lastLine: 3 });
  });
});
