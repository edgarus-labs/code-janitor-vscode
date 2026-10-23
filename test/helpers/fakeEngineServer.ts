import { PassThrough } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { CancellationToken, MessageConnection, ResponseError, StreamMessageReader, StreamMessageWriter, createMessageConnection } from 'vscode-jsonrpc/node';
import { EngineTransport, TransportFactory } from '../../src/engine/client';

type Handler = (params: Record<string, unknown>, token: CancellationToken) => unknown;

interface Waiter {
  readonly method: string;
  readonly resolve: () => void;
}

/**
 * An in-memory stand-in for the Roslyn server: answers the protocol methods it has handlers for (and
 * `initialize`/`shutdown`), records every request and notification, and can crash on demand.
 */
export class FakeServer {
  readonly calls: { method: string; params: unknown }[] = [];
  readonly notifications: { method: string; params: unknown }[] = [];
  started = false;
  disposed = false;
  private server: MessageConnection | undefined;
  private readonly exit = Promise.withResolvers<void>();
  private readonly waiters: Waiter[] = [];

  constructor(private readonly handlers: Readonly<Record<string, Handler>> = {}) {}

  /** The client side of a fresh in-memory connection to this server. */
  connect(): EngineTransport {
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    const server = createMessageConnection(new StreamMessageReader(toServer), new StreamMessageWriter(toClient));
    server.onRequest(async (method, params, token) => {
      this.calls.push({ method, params });
      this.wake(method);
      if (method === 'initialize' && !this.handlers.initialize) {
        return { serverVersion: 'fake', roslynVersion: '5.9.0' };
      }

      if (method === 'shutdown') {
        return null;
      }

      const handler = this.handlers[method];
      if (!handler) {
        throw new Error(`fake server: no handler for ${method}`);
      }

      // As the real server does: a failure is a JSON-RPC error whose message is the exception's.
      try {
        return await handler(params as Record<string, unknown>, token);
      } catch (err) {
        throw err instanceof ResponseError ? err : new ResponseError(-32000, (err as Error).message);
      }
    });
    server.onNotification((method, params) => {
      this.notifications.push({ method, params });
      this.wake(method);
    });
    server.listen();
    this.server = server;
    this.started = true;

    const connection = createMessageConnection(new StreamMessageReader(toClient), new StreamMessageWriter(toServer));

    return {
      connection,
      exited: this.exit.promise,
      dispose: () => {
        this.disposed = true;
        server.dispose();
        this.exit.resolve();
      },
    };
  }

  /** Ends the server as a crashed process would: its streams close and the process exits. */
  async crash(): Promise<void> {
    this.server?.dispose();
    this.exit.resolve();
    await this.exit.promise;
    await nextTurn();
  }

  /** Settles once a request of `method` arrived. */
  received(method: string): Promise<void> {
    return this.waitFor(method, this.calls);
  }

  /** Settles once a notification of `method` arrived. */
  notified(method: string): Promise<void> {
    return this.waitFor(method, this.notifications);
  }

  private waitFor(method: string, seen: readonly { method: string }[]): Promise<void> {
    if (seen.some((entry) => entry.method === method)) {
      return Promise.resolve();
    }

    const { promise, resolve } = Promise.withResolvers<void>();
    this.waiters.push({ method, resolve });

    return promise;
  }

  private wake(method: string): void {
    for (const waiter of this.waiters.filter((candidate) => candidate.method === method)) {
      waiter.resolve();
    }
  }
}

/** Hands out `servers` in order, one per server start; fails when the client starts more servers than given. */
export function fakeTransportFactory(servers: readonly FakeServer[]): TransportFactory {
  let next = 0;

  return async () => {
    const server = servers[next++];
    if (!server) {
      throw new Error('fake transport: no server left to start');
    }

    return server.connect();
  };
}
