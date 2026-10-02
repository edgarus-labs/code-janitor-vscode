import { describe, expect, it } from 'vitest';
import { Check, failure } from './helpers/testbedChecks';

describe('testbed scenario checks', () => {
  it('fails a check whose type it does not know instead of treating it as satisfied', () => {
    const typo = { t: 'contain', s: 'class Clean' } as unknown as Check;

    expect(failure(typo, 'class Clean {}\n', [])).toBe('unknown check type "contain"');
  });
});
