import { describe, expect, it } from 'vitest';
import { nodeVersionProblem } from '../scripts/nodeVersion';

describe('nodeVersionProblem', () => {
  it.each(['22.23.4', '22.24.0', '24.22.1', '24.23.0', '26.12.1', '26.13.0', 'v24.22.1', '27.0.0'])('accepts %s', (version) => {
    expect(nodeVersionProblem(version)).toBeUndefined();
  });

  it.each([
    ['22.23.3', '22.23.4'],
    ['24.22.0', '24.22.1'],
    ['24.9.0', '24.22.1'],
    ['26.8.1', '26.12.1'],
  ])('rejects %s, which is older than the patched release %s of its line', (version, patched) => {
    expect(nodeVersionProblem(version)).toContain(patched);
  });

  it.each(['25.8.2', '23.11.1', '20.19.0', '18.20.8'])('rejects %s, a line that no longer gets security fixes', (version) => {
    expect(nodeVersionProblem(version)).toContain('no longer');
  });

  it('rejects text that is not a version', () => {
    expect(nodeVersionProblem('latest')).toContain('latest');
  });
});
