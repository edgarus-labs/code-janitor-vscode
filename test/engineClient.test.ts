import { describe, expect, it, vi } from 'vitest';
import { CancellationTokenSource, ResponseError } from 'vscode-jsonrpc';
import { EngineClient, EngineUnavailableError, isCancellation } from '../src/engine/client';
import { FakeServer, fakeTransportFactory } from './helpers/fakeEngineServer';

const SETTINGS = { removeRegions: true };
const CLEANED = { text: 'cleaned', otherFiles: [], newFiles: [], rules: [], unresolved: [], issues: [], failures: [], warnings: [] };
/** The JSON-RPC error code StreamJsonRpc answers a cancelled request with. */
const REQUEST_CANCELLED = -32800;

function client(servers: FakeServer[], options: Partial<ConstructorParameters<typeof EngineClient>[1]> = {}): EngineClient {
  return new EngineClient(fakeTransportFactory(servers), {
    workspaceFolders: () => ['/ws'],
    log: () => undefined,
    sleep: async () => undefined,
    ...options,
  });
}

describe('EngineClient', () => {
  it('starts the server only on the first request and initializes it with the workspace folders', async () => {
    const servers: FakeServer[] = [];
    const engine = client(servers);
    expect(servers).toHaveLength(0);

    servers.push(new FakeServer({ cleanup: () => CLEANED }));
    const result = await engine.cleanup({ filePath: '/ws/A.cs', text: 'x', settings: SETTINGS });

    expect(result.text).toBe('cleaned');
    expect(servers[0].calls.map((call) => call.method)).toEqual(['initialize', 'cleanup']);
    expect(servers[0].calls[0].params).toEqual({ workspaceFolders: ['/ws'] });
    expect(servers[0].calls[1].params).toEqual({ filePath: '/ws/A.cs', text: 'x', settings: SETTINGS });
  });

  it('sends every protocol method with its parameters and returns its result', async () => {
    const server = new FakeServer({
      analyze: () => ({ diagnostics: [{ id: 'IDE0011' }] }),
      query: (params) => ({ echoed: params.query }),
      fixRule: () => CLEANED,
      command: () => CLEANED,
      overrideNotes: () => ({ notes: { removeRegions: 'set by .codejanitor' } }),
    });
    const engine = client([server]);
    const document = { filePath: '/ws/A.cs', text: 'x', settings: SETTINGS };

    expect((await engine.analyze(document)).diagnostics).toEqual([{ id: 'IDE0011' }]);
    expect(await engine.query({ ...document, query: 'memberAtPosition', arguments: { line: 1, character: 2 } })).toEqual({ echoed: 'memberAtPosition' });
    expect((await engine.fixRule({ ...document, ruleId: 'IDE0011', line: 3 })).text).toBe('cleaned');
    expect((await engine.command({ ...document, command: 'reorganize' })).text).toBe('cleaned');
    expect((await engine.overrideNotes({ directory: '/ws', settings: SETTINGS })).notes).toEqual({ removeRegions: 'set by .codejanitor' });

    expect(server.calls.slice(1).map((call) => [call.method, call.params])).toEqual([
      ['analyze', document],
      ['query', { ...document, query: 'memberAtPosition', arguments: { line: 1, character: 2 } }],
      ['fixRule', { ...document, ruleId: 'IDE0011', line: 3 }],
      ['command', { ...document, command: 'reorganize' }],
      ['overrideNotes', { directory: '/ws', settings: SETTINGS }],
    ]);
  });

  it('forwards fileChanged to a running server and never starts one for it', async () => {
    const servers: FakeServer[] = [];
    const engine = client(servers);
    engine.fileChanged('/ws/A.csproj');
    expect(servers).toHaveLength(0);

    servers.push(new FakeServer({ cleanup: () => CLEANED }));
    await engine.cleanup({ filePath: '/ws/A.cs', text: 'x', settings: SETTINGS });
    engine.fileChanged('/ws/.editorconfig');
    await servers[0].notified('fileChanged');

    expect(servers[0].notifications).toEqual([{ method: 'fileChanged', params: { path: '/ws/.editorconfig' } }]);
  });

  it('restarts a crashed server on the next request, after a backoff that grows with each crash in a row', async () => {
    const delays: number[] = [];
    const crashing: FakeServer = new FakeServer({
      cleanup: () => {
        void crashing.crash();

        return Promise.withResolvers<never>().promise;
      },
    });
    const servers = [new FakeServer({ cleanup: () => CLEANED }), crashing, new FakeServer({ cleanup: () => CLEANED })];
    const engine = client(servers, { sleep: async (ms) => void delays.push(ms), backoffMs: 100 });
    const document = { filePath: '/ws/A.cs', text: 'x', settings: SETTINGS };

    await engine.cleanup(document);
    await servers[0].crash();
    await expect(engine.cleanup(document)).rejects.toThrow(/stopped unexpectedly/);
    await engine.cleanup(document);

    expect(servers.map((server) => server.started)).toEqual([true, true, true]);
    expect(delays).toEqual([100, 200]);
  });

  it('fails a request in flight when the server crashes during it', async () => {
    const server = new FakeServer({ cleanup: () => Promise.withResolvers<never>().promise });
    const engine = client([server]);
    const pending = expect(engine.cleanup({ filePath: '/ws/A.cs', text: 'x', settings: SETTINGS })).rejects.toThrow(/C# engine stopped unexpectedly/);
    await server.received('cleanup');
    await server.crash();

    await pending;
  });

  it('gives up after the crash cap: requests fail with EngineUnavailableError and no server starts', async () => {
    const servers = [1, 2, 3].map(() => new FakeServer({ cleanup: () => CLEANED }));
    const engine = client(servers, { maxRestarts: 2 });
    const document = { filePath: '/ws/A.cs', text: 'x', settings: SETTINGS };

    for (const server of servers) {
      await engine.cleanup(document);
      await server.crash();
    }

    await expect(engine.cleanup(document)).rejects.toBeInstanceOf(EngineUnavailableError);
    expect(servers.every((server) => server.started)).toBe(true);
  });

  it('counts only the crashes inside the restart window toward the cap', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const servers = [1, 2, 3, 4].map(() => new FakeServer({ cleanup: () => CLEANED }));
      const engine = client(servers, { maxRestarts: 2, restartWindowMs: 1000 });
      const document = { filePath: '/ws/A.cs', text: 'x', settings: SETTINGS };

      for (const server of servers.slice(0, 3)) {
        await engine.cleanup(document);
        await server.crash();
        vi.advanceTimersByTime(2000);
      }

      await expect(engine.cleanup(document)).resolves.toEqual(CLEANED);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts again after reset() once the crash cap was reached, with a fresh crash count', async () => {
    const servers = [1, 2, 3, 4, 5].map(() => new FakeServer({ cleanup: () => CLEANED }));
    const engine = client(servers, { maxRestarts: 2 });
    const document = { filePath: '/ws/A.cs', text: 'x', settings: SETTINGS };
    for (const server of servers.slice(0, 3)) {
      await engine.cleanup(document);
      await server.crash();
    }
    await expect(engine.cleanup(document)).rejects.toBeInstanceOf(EngineUnavailableError);

    engine.reset();
    await engine.cleanup(document);
    await servers[3].crash();

    await expect(engine.cleanup(document)).resolves.toEqual(CLEANED);
    expect(servers[4].started).toBe(true);
  });

  it('resets the crash count after a request succeeds', async () => {
    const delays: number[] = [];
    const servers = [1, 2, 3].map(() => new FakeServer({ cleanup: () => CLEANED }));
    const engine = client(servers, { sleep: async (ms) => void delays.push(ms), backoffMs: 100 });
    const document = { filePath: '/ws/A.cs', text: 'x', settings: SETTINGS };

    await engine.cleanup(document);
    await servers[0].crash();
    await engine.cleanup(document);
    await engine.cleanup(document);
    await servers[1].crash();
    await engine.cleanup(document);

    expect(delays).toEqual([100, 100]);
  });

  it('keeps a start failure that cannot be retried (no .NET) and reports it on every request', async () => {
    let attempts = 0;
    const engine = new EngineClient(
      async () => {
        attempts++;
        throw new EngineUnavailableError('.NET 10 or newer was not found');
      },
      { workspaceFolders: () => [], log: () => undefined, sleep: async () => undefined }
    );
    const document = { filePath: '/ws/A.cs', text: 'x', settings: SETTINGS };

    await expect(engine.cleanup(document)).rejects.toThrow('.NET 10 or newer was not found');
    await expect(engine.cleanup(document)).rejects.toThrow('.NET 10 or newer was not found');
    expect(attempts).toBe(1);

    engine.reset();
    await expect(engine.cleanup(document)).rejects.toThrow('.NET 10 or newer was not found');
    expect(attempts).toBe(2);
  });

  it('cancels a request through $/cancelRequest', async () => {
    const cancelled = Promise.withResolvers<void>();
    const server = new FakeServer({
      cleanup: (_params, token) => {
        const { promise, reject } = Promise.withResolvers<never>();
        token.onCancellationRequested(() => {
          cancelled.resolve();
          reject(new ResponseError(REQUEST_CANCELLED, 'cancelled'));
        });

        return promise;
      },
    });
    const engine = client([server]);
    const source = new CancellationTokenSource();
    const pending = engine.cleanup({ filePath: '/ws/A.cs', text: 'x', settings: SETTINGS }, source.token);
    await server.received('cleanup');
    source.cancel();

    const error = await pending.catch((err: unknown) => err);
    expect(isCancellation(error)).toBe(true);
    expect(isCancellation(new Error('cancelled'))).toBe(false);
    await cancelled.promise;
  });

  it('shuts the server down with the shutdown request and does not restart it afterwards', async () => {
    const servers = [new FakeServer({ cleanup: () => CLEANED })];
    const engine = client(servers);
    await engine.cleanup({ filePath: '/ws/A.cs', text: 'x', settings: SETTINGS });

    await engine.shutdown();

    expect(servers[0].calls.map((call) => call.method)).toEqual(['initialize', 'cleanup', 'shutdown']);
    expect(servers[0].disposed).toBe(true);
    await expect(engine.cleanup({ filePath: '/ws/A.cs', text: 'x', settings: SETTINGS })).rejects.toBeInstanceOf(EngineUnavailableError);
  });

  it('shutting down a server that never started does nothing', async () => {
    const servers: FakeServer[] = [];
    await client(servers).shutdown();

    expect(servers).toHaveLength(0);
  });

  it('restarts on demand: the old server is shut down and the next request starts a new one with the current folders', async () => {
    let folders = ['/ws'];
    const servers = [new FakeServer({ cleanup: () => CLEANED }), new FakeServer({ cleanup: () => CLEANED })];
    const engine = client(servers, { workspaceFolders: () => folders });
    const document = { filePath: '/ws/A.cs', text: 'x', settings: SETTINGS };
    await engine.cleanup(document);

    folders = ['/ws', '/other'];
    await engine.restart();
    await engine.cleanup(document);

    expect(servers[0].calls.map((call) => call.method)).toEqual(['initialize', 'cleanup', 'shutdown']);
    expect(servers[0].disposed).toBe(true);
    expect(servers[1].calls[0]).toEqual({ method: 'initialize', params: { workspaceFolders: ['/ws', '/other'] } });
  });

  it('restarting before the first start or after shutdown starts nothing', async () => {
    const servers: FakeServer[] = [];
    const engine = client(servers);
    await engine.restart();
    await engine.shutdown();
    await engine.restart();

    expect(servers).toHaveLength(0);
  });

  it('ends the process and counts a crash when initialize fails', async () => {
    const failing = new FakeServer({ initialize: () => Promise.reject(new Error('boom')) });
    const servers = [failing, new FakeServer({ cleanup: () => CLEANED })];
    const engine = client(servers);
    const document = { filePath: '/ws/A.cs', text: 'x', settings: SETTINGS };

    await expect(engine.cleanup(document)).rejects.toThrow('boom');
    expect(failing.disposed).toBe(true);

    await expect(engine.cleanup(document)).resolves.toMatchObject({ text: 'cleaned' });
  });

  it('gives up on a server that never answers initialize and ends its process', async () => {
    const hung = new FakeServer({ initialize: () => Promise.withResolvers<never>().promise });
    const engine = client([hung], { initializeTimeoutMs: 20 });

    await expect(engine.cleanup({ filePath: '/ws/A.cs', text: 'x', settings: SETTINGS })).rejects.toThrow(/initialize/);
    expect(hung.disposed).toBe(true);
  });

  it('times out a request the server never answers and ends the hung process', async () => {
    const hung = new FakeServer({ cleanup: () => Promise.withResolvers<never>().promise });
    const engine = client([hung], { requestTimeoutMs: 20 });

    await expect(engine.cleanup({ filePath: '/ws/A.cs', text: 'x', settings: SETTINGS })).rejects.toThrow(/timed out/);
    expect(hung.disposed).toBe(true);
  });

  it('does not count a timed-out request as a crash', async () => {
    const hung = new FakeServer({ cleanup: () => Promise.withResolvers<never>().promise });
    const engine = client([hung, new FakeServer({ cleanup: () => CLEANED })], { requestTimeoutMs: 20, maxRestarts: 0 });
    const document = { filePath: '/ws/A.cs', text: 'x', settings: SETTINGS };

    await expect(engine.cleanup(document)).rejects.toThrow(/timed out/);

    await expect(engine.cleanup(document)).resolves.toEqual(CLEANED);
  });

  it('tells a request that the engine was restarted, not that it crashed', async () => {
    const server = new FakeServer({ cleanup: () => Promise.withResolvers<never>().promise });
    const engine = client([server, new FakeServer({ cleanup: () => CLEANED })]);
    const pending = engine.cleanup({ filePath: '/ws/A.cs', text: 'x', settings: SETTINGS }).catch((err: Error) => err.message);
    await server.received('cleanup');

    await engine.restart();

    await expect(pending).resolves.toMatch(/C# engine was restarted while handling 'cleanup'/);
  });

  it('does not use a server whose start finished after shutdown', async () => {
    const server = new FakeServer({ cleanup: () => CLEANED });
    const gate = Promise.withResolvers<void>();
    const engine = new EngineClient(
      async () => {
        await gate.promise;

        return server.connect();
      },
      { workspaceFolders: () => [], log: () => undefined, sleep: async () => undefined }
    );
    const pending = expect(engine.cleanup({ filePath: '/ws/A.cs', text: 'x', settings: SETTINGS })).rejects.toBeInstanceOf(EngineUnavailableError);
    const down = engine.shutdown();
    gate.resolve();

    await pending;
    await down;
    expect(server.disposed).toBe(true);
    expect(server.calls.map((call) => call.method)).not.toContain('cleanup');
  });
});
