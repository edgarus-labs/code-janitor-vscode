import { describe, expect, it } from 'vitest';
import { changedLineRanges } from '../src/engine/changedLines';

const BASE = ['class C', '{', '    int a;', '    int b;', '}', ''].join('\n');

describe('changedLineRanges', () => {
  it('is null (every line) for a file Git does not know yet', () => {
    expect(changedLineRanges(undefined, BASE)).toBeNull();
  });

  it('lists the 1-based inclusive ranges of the lines added or modified, not the ones around a deletion', () => {
    const current = ['class C', '{', '    int a = 1;', '    int x;', '    int b;', '}', ''].join('\n');

    expect(changedLineRanges(BASE, current)).toEqual([{ start: 3, end: 4 }]);
    expect(changedLineRanges(BASE, BASE.replace('    int a;\n', ''))).toEqual([]);
  });

  it('ignores a byte order mark and the line ending style', () => {
    expect(changedLineRanges(`\uFEFF${BASE}`, BASE.replace(/\n/g, '\r\n'))).toEqual([]);
  });

  it('keeps separate changes separate', () => {
    const current = BASE.replace('class C', 'class D').replace('    int b;', '    int c;');

    expect(changedLineRanges(BASE, current)).toEqual([
      { start: 1, end: 1 },
      { start: 4, end: 4 },
    ]);
  });
});
