import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContext, resetMock, state } from './helpers/vscodeMock';
import { EngineUnavailableError } from '../src/engine/client';
import { ENGINE_WATCH_GLOB, activateEngine, deactivateEngine, engine, reportEngineUnavailable } from '../src/engine/vscodeEngine';

beforeEach(() => resetMock());
afterEach(async () => deactivateEngine());

describe('activateEngine', () => {
  it('watches solution files next to projects and the other files the server depends on', () => {
    activateEngine(createContext());

    expect(state.watchedGlobs).toContain(ENGINE_WATCH_GLOB);
    for (const extension of ['cs', 'csproj', 'props', 'targets', 'sln', 'slnx']) {
      expect(ENGINE_WATCH_GLOB).toContain(`*.${extension}`);
    }
  });

  it('restarts the engine when the workspace folders change, so the next start sees the new folders', () => {
    activateEngine(createContext());
    const restart = vi.spyOn(engine(), 'restart').mockResolvedValue();

    state.workspaceFolderListeners.forEach((listener) => listener());

    expect(restart).toHaveBeenCalledTimes(1);
  });
});

describe('reportEngineUnavailable', () => {
  it('leaves other errors to the caller', () => {
    expect(reportEngineUnavailable(new Error('boom'))).toBe(false);
    expect(state.errorMessages).toEqual([]);
  });

  it('offers the output, not the .NET install, when the engine keeps crashing', () => {
    expect(reportEngineUnavailable(new EngineUnavailableError('It crashed.', 'crashed'))).toBe(true);

    expect(state.errorActions).toEqual([['Show Output']]);
  });

  it('shows a cause again after codeJanitor.dotnetPath changes, and resets the engine', () => {
    activateEngine(createContext());
    const reset = vi.spyOn(engine(), 'reset');
    const missing = new EngineUnavailableError('No .NET.', 'dotnetMissing');
    reportEngineUnavailable(missing);
    reportEngineUnavailable(missing);

    state.configurationListeners.forEach((listener) => listener({ affectsConfiguration: (section) => section === 'codeJanitor.dotnetPath' }));
    reportEngineUnavailable(missing);

    expect(state.errorMessages).toHaveLength(2);
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
