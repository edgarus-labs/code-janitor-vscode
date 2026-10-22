import { beforeEach, describe, expect, it } from 'vitest';
import { createOutputChannel, logDiagnostic, logError, logInfo } from '../src/logging';
import { createContext, resetMock, state } from './helpers/vscodeMock';

beforeEach(() => {
  resetMock();
  createOutputChannel(createContext());
});

describe('logDiagnostic', () => {
  it('writes nothing outside diagnostics mode', () => {
    logDiagnostic('Cleanup: /w/a.cs skipped.');

    expect(state.outputChannelLines).toEqual([]);
  });

  it('writes the message in diagnostics mode (codeJanitor.general.diagnosticsMode)', () => {
    state.configuration.set('codeJanitor.general.diagnosticsMode', true);

    logDiagnostic('Cleanup: /w/a.cs skipped.');

    expect(state.outputChannelLines).toEqual([expect.stringMatching(/^\[[^\]]+\] Cleanup: \/w\/a\.cs skipped\.$/)]);
  });

  it('never hides errors and warnings, whatever the mode', () => {
    logError('Cleanup of /w/a.cs', new Error('boom'));
    logInfo('2 .editorconfig rule violation(s) were not fixed.');

    expect(state.outputChannelLines).toEqual([expect.stringContaining('ERROR - Cleanup of /w/a.cs: Error: boom'), expect.stringContaining('were not fixed')]);
  });
});
