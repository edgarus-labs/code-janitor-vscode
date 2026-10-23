import { CancellationToken } from 'vscode-jsonrpc';
import { EngineClient } from '../../src/engine/client';
import { CleanupResult } from '../../src/engine/protocol';
import { setEngine } from '../../src/engine/vscodeEngine';
import { FakeServer, fakeTransportFactory } from './fakeEngineServer';

/** The parameters of a request as the fake engine receives them. */
export type EngineParams = Record<string, unknown> & { filePath: string; text: string; settings: Record<string, unknown> };

type Handler = (params: EngineParams, token: CancellationToken) => unknown;

export interface FakeEngine {
  readonly server: FakeServer;
  /** The parameters of every request of `method`, in order. */
  requests(method: string): EngineParams[];
}

/** A cleanup result changing `filePath` to `text` and nothing else. */
export function cleanupResult(text: string, extra: Partial<CleanupResult> = {}): CleanupResult {
  return { text, otherFiles: [], newFiles: [], rules: [], unresolved: [], issues: [], failures: [], warnings: [], ...extra };
}

/** What the fake engine does by default: trailing whitespace removal, a change any test can see. */
export function trimTrailingWhitespace(text: string): string {
  return text.replace(/[ \t]+(?=\r?\n|$)/g, '');
}

const DEFAULT_HANDLERS: Readonly<Record<string, Handler>> = {
  cleanup: (params) => cleanupResult(trimTrailingWhitespace(params.text)),
  fixRule: (params) => cleanupResult(trimTrailingWhitespace(params.text)),
  command: (params) => cleanupResult(params.text),
  analyze: () => ({ diagnostics: [] }),
  query: () => null,
  overrideNotes: () => ({ notes: {} }),
};

/**
 * Makes the command layer talk to an in-memory engine (a real `EngineClient` over a fake server) answering
 * with `handlers`, the defaults for the others. Call in `beforeEach`, after `resetMock`.
 */
export function useFakeEngine(handlers: Readonly<Record<string, Handler>> = {}): FakeEngine {
  const server = new FakeServer({ ...DEFAULT_HANDLERS, ...handlers } as Record<string, (params: Record<string, unknown>, token: CancellationToken) => unknown>);
  setEngine(new EngineClient(fakeTransportFactory([server]), { workspaceFolders: () => [], log: () => undefined, sleep: async () => undefined }));

  return {
    server,
    requests: (method) => server.calls.filter((call) => call.method === method).map((call) => call.params as EngineParams),
  };
}
