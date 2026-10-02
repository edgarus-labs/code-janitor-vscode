import { describe, expect, it } from 'vitest';
import { applyEdits } from '../src/cleanup/parser';

describe('applyEdits', () => {
  it('applies edits given in any order against the original offsets', () => {
    expect(applyEdits('abcdef', [{ start: 4, end: 5, text: 'E' }, { start: 0, end: 1, text: 'A' }, { start: 2, end: 2, text: '+' }])).toBe('Ab+cdEf');
  });

  it('places insertions at the same offset last-given first, before a replacement given earlier', () => {
    const edits = [
      { start: 2, end: 4, text: 'R' },
      { start: 2, end: 2, text: '1' },
      { start: 2, end: 2, text: '2' },
    ];

    expect(applyEdits('abcdef', edits)).toBe('ab21Ref');
  });

  it('drops an edit that overlaps one starting later or a replacement given after an edit at the same offset', () => {
    expect(applyEdits('abcdef', [{ start: 1, end: 4, text: 'X' }, { start: 3, end: 5, text: 'Y' }])).toBe('abcYf');
    expect(applyEdits('abcdef', [{ start: 2, end: 2, text: 'I' }, { start: 2, end: 3, text: 'R' }])).toBe('abIcdef');
  });

  it('applies adjacent edits and edits at both ends of the text', () => {
    expect(applyEdits('abc', [{ start: 0, end: 1, text: 'X' }, { start: 1, end: 2, text: 'Y' }, { start: 3, end: 3, text: '!' }])).toBe('XYc!');
  });

  it('keeps the text on both sides of a reversed range, duplicating the span between them', () => {
    // end < start: the text before `start` and the text from `end` are both kept.
    expect(applyEdits('abcdef', [{ start: 4, end: 2, text: '|' }, { start: 0, end: 1, text: 'A' }])).toBe('Abcd|cdef');
  });
});
