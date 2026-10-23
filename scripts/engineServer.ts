/**
 * The Roslyn server for the scripts and tests that run outside VS Code: `dist/server/CodeJanitor.Server.dll`,
 * published again (`npm run build:server`) when a server source is newer than it, or the server named by
 * `CODE_JANITOR_SERVER_DLL`.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EngineClient } from '../src/engine/client';
import { serverTransportFactory } from '../src/engine/serverProcess';

export const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const SERVER_SOURCES = path.join(REPOSITORY_ROOT, 'server');
const PUBLISHED_DLL = path.join(REPOSITORY_ROOT, 'dist', 'server', 'CodeJanitor.Server.dll');
const SKIPPED_FOLDERS = new Set(['bin', 'obj', 'tests', '.vs']);

function newestSource(folder: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      newest = SKIPPED_FOLDERS.has(entry.name) ? newest : Math.max(newest, newestSource(full));
    } else if (/\.(cs|csproj|props|targets|slnx|json|editorconfig)$/i.test(entry.name)) {
      newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  }

  return newest;
}

function isCurrent(): boolean {
  return fs.existsSync(PUBLISHED_DLL) && fs.statSync(PUBLISHED_DLL).mtimeMs >= newestSource(SERVER_SOURCES);
}

/**
 * The path of a server built from the current sources. Concurrent callers (vitest workers) publish it
 * once: the others wait for the lock folder to go away.
 */
export function ensureServerBuilt(): string {
  const configured = process.env.CODE_JANITOR_SERVER_DLL;
  if (configured) {
    return path.resolve(configured);
  }

  const lock = path.join(os.tmpdir(), `code-janitor-server-build-${Buffer.from(REPOSITORY_ROOT).toString('hex').slice(-32)}.lock`);
  const deadline = Date.now() + 10 * 60_000;
  while (!isCurrent()) {
    try {
      fs.mkdirSync(lock);
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for another process to publish the server (remove ${lock} if no build runs).`);
      }

      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      continue;
    }

    try {
      if (!isCurrent()) {
        execFileSync('npm', ['run', '--silent', 'build:server'], {
          cwd: REPOSITORY_ROOT,
          stdio: ['ignore', 'ignore', 'inherit'],
          shell: process.platform === 'win32',
        });
        // `dotnet publish` keeps the old timestamp of an unchanged assembly: the publish itself makes it current.
        const now = new Date();
        fs.utimesSync(PUBLISHED_DLL, now, now);
      }
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
  }

  return PUBLISHED_DLL;
}

/** A client of a server built from the current sources, for `workspaceFolders`; its log goes to `log`. */
export function startEngine(workspaceFolders: readonly string[], log: (message: string) => void = () => undefined): EngineClient {
  const serverDll = ensureServerBuilt();

  return new EngineClient(serverTransportFactory({ serverDll, dotnetPath: () => process.env.CODE_JANITOR_DOTNET, log }), {
    workspaceFolders: () => workspaceFolders,
    log,
    maxRestarts: 2,
  });
}

/** Runs the server's `check` CLI and returns its output lines and exit code. */
export function runServerCheck(args: readonly string[], cwd: string = process.cwd()): { lines: string[]; exitCode: number } {
  const serverDll = ensureServerBuilt();
  try {
    const output = execFileSync(process.env.CODE_JANITOR_DOTNET ?? 'dotnet', [serverDll, 'check', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    return { lines: output.split(/\r?\n/).filter((line) => line.length > 0), exitCode: 0 };
  } catch (err) {
    const failure = err as { status?: number | null; stdout?: string };
    if (typeof failure.status !== 'number') {
      throw err;
    }

    return { lines: (failure.stdout ?? '').split(/\r?\n/).filter((line) => line.length > 0), exitCode: failure.status };
  }
}
