import { describe, expect, it } from 'vitest';
import { countChangedRegions } from '../src/cleanup/lineDiff';

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
