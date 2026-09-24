import { describe, expect, it } from 'vitest';
import { countChangedRegions, diffLineHunks } from '../src/cleanup/lineDiff';

const text = (...lines: string[]) => `${lines.join('\n')}\n`;

describe('countChangedRegions', () => {
  it('counts each run of changed lines once', () => {
    const before = text('a', 'b', 'c', 'd', 'e', 'f', 'g');

    expect(countChangedRegions(before, before)).toBe(0);
    expect(countChangedRegions(before, text('a', 'B', 'c', 'd', 'E', 'f', 'g'))).toBe(2);
    expect(countChangedRegions(before, text('a', 'B', 'C', 'd', 'e', 'f', 'g'))).toBe(1);
    expect(countChangedRegions(before, text('a', 'b', 'x', 'c', 'd', 'e', 'f'))).toBe(2);
    expect(countChangedRegions(before, text('x', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'y'))).toBe(2);
  });

  it('still counts a region when every line changes', () => {
    const before = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n');
    const after = Array.from({ length: 3000 }, (_, i) => `LINE ${i}`).join('\n');

    expect(countChangedRegions(before, after)).toBe(1);
  });
});

describe('diffLineHunks', () => {
  it('locates each run of changed lines in both texts', () => {
    const before = text('a', 'b', 'c', 'd', 'e');

    expect(diffLineHunks(before, before)).toEqual([]);
    expect(diffLineHunks(before, text('a', 'B', 'c', 'x', 'd', 'e'))).toEqual([
      { beforeStart: 1, beforeEnd: 2, afterStart: 1, afterEnd: 2 },
      { beforeStart: 3, beforeEnd: 3, afterStart: 3, afterEnd: 4 },
    ]);
    expect(diffLineHunks(before, text('a', 'b', 'e'))).toEqual([{ beforeStart: 2, beforeEnd: 4, afterStart: 2, afterEnd: 2 }]);
  });
});
