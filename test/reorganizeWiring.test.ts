import { beforeEach, describe, expect, it } from 'vitest';
import { buildPipeline } from '../src/cleanup/runCleanup';
import { createDefaultSettings } from '../src/cleanup/types';
import { readCleanupSettings } from '../src/commands/settings';
import { resetMock, state } from './helpers/vscodeMock';

const SOURCE = `class C
{
    public void B() { }

    public int A;
}
`;

describe('Reorganize in the cleanup pipeline', () => {
  beforeEach(() => resetMock());

  it('does not reorganize members by default', () => {
    const output = buildPipeline(createDefaultSettings()).run(SOURCE);

    expect(output.indexOf('void B')).toBeLessThan(output.indexOf('int A'));
  });

  it('reorganizes members first when runAtStartOfCleanup is on', () => {
    const settings = createDefaultSettings();
    settings.reorganize.runAtStartOfCleanup = true;

    const output = buildPipeline(settings).run(SOURCE);

    expect(output.indexOf('int A')).toBeLessThan(output.indexOf('void B'));
  });

  it('reads the reorganize settings from the VS Code configuration', () => {
    state.configuration.set('codeJanitor.reorganize.runAtStartOfCleanup', true);

    expect(readCleanupSettings().reorganize.runAtStartOfCleanup).toBe(true);
  });
});
