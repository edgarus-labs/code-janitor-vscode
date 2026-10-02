import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatRazor } from '../src/razor/razorFormatter';

/**
 * Realistic components and views (the sources of the compile oracle in test/oracle/Razor) and the
 * layout the formatter gives them. The same files are built before and after formatting in
 * razorOracle.test.ts; here the exact result is reviewed and pinned.
 */
const cases: [string, string][] = [
  ['Pages/Counter.razor', 'Counter.expected.razor'],
  ['Views/Index.cshtml', 'Index.expected.cshtml'],
  ['Shared/MainLayout.razor', 'MainLayout.expected.razor'],
  ['Components/Card.razor', 'Card.expected.razor'],
];

describe('formatRazor: realistic files', () => {
  it.each(cases)('formats %s', (source, expected) => {
    const input = fs.readFileSync(path.resolve(__dirname, 'oracle', 'Razor', source), 'utf8');
    const output = fs.readFileSync(path.resolve(__dirname, 'fixtures', 'razor', expected), 'utf8');

    expect(formatRazor(input)).toBe(output);
    expect(formatRazor(output)).toBe(output);
  });

  it('leaves the files that need no change as they are', () => {
    for (const file of ['_Imports.razor', 'Views/_ViewImports.cshtml']) {
      const input = fs.readFileSync(path.resolve(__dirname, 'oracle', 'Razor', file), 'utf8');

      expect(formatRazor(input)).toBe(input);
    }
  });
});
