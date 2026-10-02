import { describe, expect, it } from 'vitest';
import { parseErrorCount } from '../src/cleanup/transformations/editorConfigSupport';
import { reorganizeSourceDetailed } from '../src/reorganize/reorganize';
import { Random, generateFile, randomCleanupSettings, randomReorganizeSettings } from './helpers/reorganizeFuzz';

/** The lines of a file, without blank lines and region directives: a reorganized file holds exactly these. */
function contentLines(source: string): string[] {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/^#\s*(end)?region\b/.test(line))
    .sort();
}

describe('reorganize: generated files', () => {
  it('only moves lines, never breaks the syntax and is idempotent, for any settings', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const random = new Random(seed);
      const { source } = generateFile(random, true);
      const settings = randomReorganizeSettings(random);
      const cleanup = randomCleanupSettings(random);
      const first = reorganizeSourceDetailed(source, settings, cleanup);
      const context = `seed ${seed}\n--- settings ---\n${JSON.stringify(settings)}\n--- source ---\n${source}\n--- output ---\n${first.output}`;

      expect(contentLines(first.output), `lines changed: ${context}`).toEqual(contentLines(source));
      expect(parseErrorCount(first.output), `parse errors: ${context}`).toBeLessThanOrEqual(parseErrorCount(source));

      const second = reorganizeSourceDetailed(first.output, settings, cleanup);
      expect(second.output, `not idempotent: ${context}`).toBe(first.output);
    }
  });
});
