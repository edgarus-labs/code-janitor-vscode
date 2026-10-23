import { setTimeout as delay } from 'node:timers/promises';
import { ResponseError, type CancellationToken, type MessageConnection } from 'vscode-jsonrpc';
import {
  AnalyzeResult,
  CleanupParams,
  CleanupResult,
  CommandParams,
  DocumentParams,
  FixRuleParams,
  FormatCommentTextParams,
  FormatCommentTextResult,
  InitializeParams,
  InitializeResult,
  Methods,
  OverrideNotesParams,
  OverrideNotesResult,
  QueryParams,
} from './protocol';

/** Why C# cleanup cannot run: no usable .NET, no server, or a server that keeps crashing or was shut down. */
export type EngineUnavailableReason = 'dotnetMissing' | 'serverMissing' | 'crashed' | 'stopped';

/** C# cleanup is unavailable; requests fail with this until the cause is fixed and the client is {@link EngineClient.reset reset}. */
export class EngineUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: EngineUnavailableReason = 'dotnetMissing'
  ) {
    super(message);
    this.name = 'EngineUnavailableError';
  }
}

/** The JSON-RPC error code of a request the server cancelled. */
const REQUEST_CANCELLED = -32800;

/** Whether `err` is the server's answer to a cancelled request rather than a failure. */
export function isCancellation(err: unknown): boolean {
  return err instanceof ResponseError && err.code === REQUEST_CANCELLED;
}

/** A started server: the connection to it, unlistened, and its process. */
export interface EngineTransport {
  readonly connection: MessageConnection;
  /** Settles when the server process exits. */
  readonly exited: Promise<void>;
  /** Ends the server process. */
  dispose(): void;
}

/** Starts a server; throws {@link EngineUnavailableError} when it cannot start at all (no .NET). */
export type TransportFactory = () => Promise<EngineTransport>;

export interface EngineClientOptions {
  /** The workspace folders sent with `initialize`. */
  workspaceFolders(): readonly string[];
  log(message: string): void;
  /** Restarts allowed within {@link restartWindowMs}; one more crash makes C# cleanup unavailable. */
  readonly maxRestarts?: number;
  readonly restartWindowMs?: number;
  /** The wait before the first restart; it doubles with each crash not followed by a successful request. */
  readonly backoffMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** How long `shutdown` waits for the server to answer before ending its process. */
  readonly shutdownTimeoutMs?: number;
  /** How long `initialize` may take before the server is considered hung and ended. */
  readonly initializeTimeoutMs?: number;
  /** How long one request may take before the server is considered hung and ended. */
  readonly requestTimeoutMs?: number;
}

const TIMED_OUT = Symbol('timed out');

/** `promise`, or {@link TIMED_OUT} when it does not settle within `ms`; the timer never outlives the call. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  const { promise: timeout, resolve } = Promise.withResolvers<typeof TIMED_OUT>();
  const timer = setTimeout(() => resolve(TIMED_OUT), ms);
  timer.unref();
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

interface Session {
  readonly transport: EngineTransport;
  alive: boolean;
  /** The client ended it on purpose (a restart or shutdown), so its failed requests are not a crash. */
  closed?: boolean;
}

/**
 * The client of the Roslyn server: starts it on the first request, restarts it after a crash (with a
 * growing backoff, at most {@link EngineClientOptions.maxRestarts} times in a window) and offers one
 * typed method per protocol request.
 */
export class EngineClient {
  private starting: Promise<Session> | undefined;
  private live: Session | undefined;
  private failure: EngineUnavailableError | undefined;
  private stopped = false;
  private consecutiveCrashes = 0;
  private crashTimes: number[] = [];

  constructor(
    private readonly factory: TransportFactory,
    private readonly options: EngineClientOptions
  ) {}

  cleanup(params: CleanupParams, token?: CancellationToken): Promise<CleanupResult> {
    return this.request(Methods.cleanup, params, token);
  }

  analyze(params: DocumentParams, token?: CancellationToken): Promise<AnalyzeResult> {
    return this.request(Methods.analyze, params, token);
  }

  query<T = unknown>(params: QueryParams, token?: CancellationToken): Promise<T> {
    return this.request(Methods.query, params, token);
  }

  fixRule(params: FixRuleParams, token?: CancellationToken): Promise<CleanupResult> {
    return this.request(Methods.fixRule, params, token);
  }

  command(params: CommandParams, token?: CancellationToken): Promise<CleanupResult> {
    return this.request(Methods.command, params, token);
  }

  overrideNotes(params: OverrideNotesParams, token?: CancellationToken): Promise<OverrideNotesResult> {
    return this.request(Methods.overrideNotes, params, token);
  }

  formatCommentText(params: FormatCommentTextParams, token?: CancellationToken): Promise<FormatCommentTextResult> {
    return this.request(Methods.formatCommentText, params, token);
  }

  /** Tells a running server a file changed on disk; never starts one. */
  fileChanged(path: string): void {
    if (this.live?.alive) {
      void this.live.transport.connection.sendNotification(Methods.fileChanged, { path }).catch(() => undefined);
    }
  }

  /** Forgets a start failure and the crash history, so the next request tries again (for example after `dotnetPath` changed). */
  reset(): void {
    this.failure = undefined;
    this.consecutiveCrashes = 0;
    this.crashTimes = [];
  }

  /** Asks the server to exit and ends its process; later requests fail. */
  async shutdown(): Promise<void> {
    this.stopped = true;
    const session = this.live ?? (await this.starting?.catch(() => undefined));
    this.live = undefined;
    if (session) {
      await this.closeSession(session);
    }
  }

  /** Ends a running server so the next request starts one that sees the current workspace folders; does nothing when none runs. */
  async restart(): Promise<void> {
    if (this.stopped) {
      return;
    }

    const session = this.live ?? (await this.starting?.catch(() => undefined));
    this.live = undefined;
    this.starting = undefined;
    if (session) {
      await this.closeSession(session);
    }
  }

  private async closeSession(session: Session): Promise<void> {
    if (!session.alive) {
      return;
    }

    session.alive = false;
    session.closed = true;
    try {
      await withTimeout(session.transport.connection.sendRequest(Methods.shutdown, {}), this.options.shutdownTimeoutMs ?? 2000);
    } catch {
      // The process is ended below either way.
    } finally {
      session.transport.connection.dispose();
      session.transport.dispose();
    }
  }

  private async request<R>(method: string, params: object, token?: CancellationToken): Promise<R> {
    const session = await this.session();
    const timeoutMs = this.options.requestTimeoutMs ?? 10 * 60_000;
    let result: R | typeof TIMED_OUT;
    try {
      // An undefined token would be sent as a second, positional parameter.
      const connection = session.transport.connection;
      result = await withTimeout(token ? connection.sendRequest<R>(method, params, token) : connection.sendRequest<R>(method, params), timeoutMs);
    } catch (err) {
      if (!session.alive && !this.stopped) {
        throw new Error(
          session.closed
            ? `The C# engine was restarted while handling '${method}'; run it again.`
            : `The C# engine stopped unexpectedly while handling '${method}'; it restarts on the next request.`,
          { cause: err }
        );
      }

      throw err;
    }

    if (result === TIMED_OUT) {
      this.options.log(`The C# engine did not answer '${method}' within ${timeoutMs} ms; ending it.`);
      if (this.live === session) {
        this.live = undefined;
        this.starting = undefined;
      }

      this.endSession(session);
      throw new Error(`The C# engine request '${method}' timed out after ${timeoutMs} ms; it restarts on the next request.`);
    }

    this.consecutiveCrashes = 0;

    return result;
  }

  private session(): Promise<Session> {
    if (this.stopped) {
      return Promise.reject(new EngineUnavailableError('The C# engine was shut down.', 'stopped'));
    }

    if (this.failure) {
      return Promise.reject(this.failure);
    }

    this.starting ??= this.start().catch((err: unknown) => {
      this.starting = undefined;
      if (err instanceof EngineUnavailableError) {
        this.failure = err;
      } else {
        this.recordCrash(`the C# engine failed to start: ${err instanceof Error ? err.message : String(err)}`);
      }

      throw err;
    });

    return this.starting;
  }

  private async start(): Promise<Session> {
    if (this.consecutiveCrashes > 0) {
      const wait = (this.options.backoffMs ?? 1000) * 2 ** (this.consecutiveCrashes - 1);
      this.options.log(`Restarting the C# engine in ${wait} ms.`);
      await (this.options.sleep ?? ((ms: number) => delay(ms)))(wait);
    }

    this.throwIfStopped();
    const transport = await this.factory();
    const session: Session = { transport, alive: true };
    void transport.exited.then(() => this.exited(session));
    transport.connection.listen();
    try {
      this.throwIfStopped();
      const timeoutMs = this.options.initializeTimeoutMs ?? 120_000;
      const initializeParams: InitializeParams = { workspaceFolders: this.options.workspaceFolders() };
      const info = await withTimeout(transport.connection.sendRequest<InitializeResult>(Methods.initialize, initializeParams), timeoutMs);
      if (info === TIMED_OUT) {
        throw new Error(`the C# engine did not answer initialize within ${timeoutMs} ms`);
      }

      if (!session.alive) {
        throw new Error('the C# engine exited during initialize');
      }

      this.throwIfStopped();
      this.options.log(`C# engine started (server ${info.serverVersion}, Roslyn ${info.roslynVersion}).`);
    } catch (err) {
      this.endSession(session);
      throw err;
    }

    this.live = session;

    return session;
  }

  private throwIfStopped(): void {
    if (this.stopped) {
      throw new EngineUnavailableError('The C# engine was shut down.', 'stopped');
    }
  }

  private endSession(session: Session): void {
    session.alive = false;
    session.transport.connection.dispose();
    session.transport.dispose();
  }

  private exited(session: Session): void {
    if (!session.alive) {
      return;
    }

    session.alive = false;
    session.transport.connection.dispose();
    // A server that exits during `initialize` fails its start, which counts the crash.
    if (this.live === session) {
      this.live = undefined;
      this.starting = undefined;
      if (!this.stopped) {
        this.recordCrash('the C# engine stopped unexpectedly');
      }
    }
  }

  private recordCrash(message: string): void {
    const now = Date.now();
    const window = this.options.restartWindowMs ?? 5 * 60_000;
    const maxRestarts = this.options.maxRestarts ?? 5;
    this.consecutiveCrashes++;
    this.crashTimes = [...this.crashTimes.filter((time) => now - time < window), now];
    this.options.log(`${message} (${this.crashTimes.length} time(s) in the last ${Math.round(window / 60_000)} minutes).`);
    if (this.crashTimes.length > maxRestarts) {
      this.failure = new EngineUnavailableError(
        `The C# engine stopped unexpectedly ${this.crashTimes.length} times; C# cleanup is unavailable until the window is reloaded (see the Code Janitor output).`,
        'crashed'
      );
    }
  }
}
