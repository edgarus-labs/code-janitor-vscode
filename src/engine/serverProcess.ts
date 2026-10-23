import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { StreamMessageReader, StreamMessageWriter, createMessageConnection } from 'vscode-jsonrpc/node';
import { EngineUnavailableError, TransportFactory } from './client';

/** The oldest .NET major version the server runs on (it targets net10.0, as Roslyn's MSBuild workspace does, and rolls forward). */
export const MINIMUM_DOTNET_MAJOR = 10;

export const DOTNET_DOWNLOAD_URL = 'https://dotnet.microsoft.com/download';

/** Runs a command and returns its standard output; rejects when it cannot start or fails. */
export type CommandRunner = (command: string, args: readonly string[]) => Promise<string>;

const runCommand: CommandRunner = async (command, args) => {
  const child = execFile(command, [...args], { timeout: 15_000, windowsHide: true });
  let output = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
  const [code] = (await once(child, 'close')) as [number | null];
  if (code !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${code}`);
  }

  return output;
};

/** The major versions of the installed `Microsoft.NETCore.App` runtimes in `dotnet --list-runtimes` output. */
export function runtimeMajors(listRuntimesOutput: string): number[] {
  return [...listRuntimesOutput.matchAll(/^Microsoft\.NETCore\.App (\d+)\.\d+\S* /gm)].map((match) => Number(match[1]));
}

/** Where .NET installs `dotnet` when VS Code was started without it on PATH. */
export function dotnetInstallCandidates(): string[] {
  const executable = process.platform === 'win32' ? 'dotnet.exe' : 'dotnet';
  const roots =
    process.platform === 'win32'
      ? [process.env.ProgramFiles ?? 'C:\\Program Files', process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'].map((root) =>
          path.join(root, 'dotnet')
        )
      : ['/usr/local/share/dotnet', '/usr/share/dotnet', '/usr/lib/dotnet', '/opt/homebrew/opt/dotnet/libexec', path.join(os.homedir(), '.dotnet')];

  return [...(process.env.DOTNET_ROOT ? [process.env.DOTNET_ROOT] : []), ...roots].map((root) => path.join(root, executable));
}

/**
 * The `dotnet` to run the server with: `configured` (`codeJanitor.dotnetPath`) when set, otherwise `dotnet`
 * on PATH, then `candidates`. Throws {@link EngineUnavailableError} when none has a .NET 10+ runtime.
 */
export async function resolveDotnet(
  configured: string | undefined,
  run: CommandRunner = runCommand,
  candidates: readonly string[] = dotnetInstallCandidates()
): Promise<string> {
  const tried = configured?.trim() ? [configured.trim()] : ['dotnet', ...candidates];
  const tooOld: string[] = [];
  let lastError: unknown;
  for (const command of tried) {
    let output: string;
    try {
      output = await run(command, ['--list-runtimes']);
    } catch (err) {
      lastError = err;
      continue;
    }

    const newest = Math.max(...runtimeMajors(output));
    if (newest >= MINIMUM_DOTNET_MAJOR) {
      return command;
    }

    tooOld.push(Number.isFinite(newest) ? `found .NET ${newest} at ${command}` : `found no .NET runtime at ${command}`);
  }

  const needs = `C# cleanup needs .NET ${MINIMUM_DOTNET_MAJOR} or newer (the .NET SDK to load projects)`;
  if (tooOld.length > 0) {
    throw new EngineUnavailableError(`${needs}; ${tooOld.join(', ')}.`);
  }

  throw new EngineUnavailableError(
    configured?.trim()
      ? `${needs}; codeJanitor.dotnetPath is '${configured.trim()}', which could not be run: ${lastError instanceof Error ? lastError.message : String(lastError)}.`
      : `${needs}; no 'dotnet' was found on PATH. Install .NET or set codeJanitor.dotnetPath.`
  );
}

export interface ServerProcessOptions {
  /** The built server, `dist/server/CodeJanitor.Server.dll`. */
  readonly serverDll: string;
  /** `codeJanitor.dotnetPath`, read on each start. */
  readonly dotnetPath: () => string | undefined;
  /** Receives the server's stderr lines. */
  readonly log: (message: string) => void;
  readonly run?: CommandRunner;
}

/** Starts `dotnet CodeJanitor.Server.dll` and talks JSON-RPC to it over stdio. */
export function serverTransportFactory(options: ServerProcessOptions): TransportFactory {
  return async () => {
    if (!fs.existsSync(options.serverDll)) {
      throw new EngineUnavailableError(`The C# engine is missing (${options.serverDll}); reinstall the extension or run 'npm run build'.`, 'serverMissing');
    }

    const dotnet = await resolveDotnet(options.dotnetPath(), options.run);
    const child = spawn(dotnet, [options.serverDll], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' },
    });
    createInterface({ input: child.stderr }).on('line', (line) => options.log(`[engine] ${line}`));
    const exited = once(child, 'exit').then(
      ([code, signal]) => options.log(`C# engine exited (${signal ?? `code ${code}`}).`),
      (err: unknown) => options.log(`C# engine could not start: ${err instanceof Error ? err.message : String(err)}`)
    );

    return {
      connection: createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin)),
      exited,
      dispose: () => {
        if (child.exitCode === null) {
          child.kill();
        }
      },
    };
  };
}
