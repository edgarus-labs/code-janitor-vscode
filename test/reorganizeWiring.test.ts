import { beforeEach, describe, expect, it } from 'vitest';
import { readCleanupSettings } from '../src/commands/settings';
import { resetMock, state } from './helpers/vscodeMock';

describe('Reorganize settings of cleanup', () => {
  beforeEach(() => resetMock());

  it('reads the reorganize settings from the VS Code configuration', () => {
    state.configuration.set('codeJanitor.reorganize.runAtStartOfCleanup', true);

    expect(readCleanupSettings().reorganize.runAtStartOfCleanup).toBe(true);
  });
});
