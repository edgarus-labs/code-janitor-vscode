import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EngineUnavailableError } from '../src/engine/client';
import { resolveDotnet, runtimeMajors, serverTransportFactory } from '../src/engine/serverProcess';

const RUNTIMES = [
  'Microsoft.AspNetCore.App 8.0.11 [/usr/share/dotnet/shared/Microsoft.AspNetCore.App]',
  'Microsoft.NETCore.App 6.0.36 [/usr/share/dotnet/shared/Microsoft.NETCore.App]',
  'Microsoft.NETCore.App 10.0.12 [/usr/share/dotnet/shared/Microsoft.NETCore.App]',
  '',
].join('\n');

function runner(outputs: Record<string, string>) {
  const ran: string[] = [];
  const run = async (command: string, args: readonly string[]): Promise<string> => {
    ran.push(`${command} ${args.join(' ')}`);
    const output = outputs[command];
    if (output === undefined) {
      throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' });
    }

    return output;
  };

  return { run, ran };
}

describe('runtimeMajors', () => {
  it('lists the major versions of the installed Microsoft.NETCore.App runtimes only', () => {
    expect(runtimeMajors(RUNTIMES)).toEqual([6, 10]);
  });
});

describe('resolveDotnet', () => {
  it('uses codeJanitor.dotnetPath when it is set and has .NET 10 or newer', async () => {
    const { run, ran } = runner({ '/opt/dotnet/dotnet': RUNTIMES });

    expect(await resolveDotnet('/opt/dotnet/dotnet', run, [])).toBe('/opt/dotnet/dotnet');
    expect(ran).toEqual(['/opt/dotnet/dotnet --list-runtimes']);
  });

  it('falls back to dotnet on PATH, then to the usual install folders', async () => {
    const { run, ran } = runner({ '/usr/share/dotnet/dotnet': RUNTIMES });

    expect(await resolveDotnet(undefined, run, ['/usr/share/dotnet/dotnet'])).toBe('/usr/share/dotnet/dotnet');
    expect(ran).toEqual(['dotnet --list-runtimes', '/usr/share/dotnet/dotnet --list-runtimes']);
  });

  it('refuses a dotnet whose newest runtime is older than .NET 10, naming what it found', async () => {
    const { run } = runner({ dotnet: 'Microsoft.NETCore.App 6.0.36 [/x]\n' });

    const error = await resolveDotnet(undefined, run, []).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(EngineUnavailableError);
    expect((error as EngineUnavailableError).reason).toBe('dotnetMissing');
    expect((error as Error).message).toMatch(/\.NET 10 or newer.*found \.NET 6/);
  });

  it('reports a missing dotnet, and only the configured one when codeJanitor.dotnetPath is set', async () => {
    const { run, ran } = runner({ dotnet: RUNTIMES });

    await expect(resolveDotnet('/missing/dotnet', run, [])).rejects.toThrow(/codeJanitor\.dotnetPath.*\/missing\/dotnet.*spawn \/missing\/dotnet ENOENT/);
    expect(ran).toEqual(['/missing/dotnet --list-runtimes']);
    await expect(resolveDotnet(undefined, runner({}).run, [])).rejects.toThrow(/no 'dotnet' was found/);
  });
});

describe('serverTransportFactory', () => {
  it('reports a missing server build as unavailable without starting dotnet', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-server-'));
    try {
      const { run, ran } = runner({ dotnet: RUNTIMES });
      const factory = serverTransportFactory({
        serverDll: path.join(folder, 'CodeJanitor.Server.dll'),
        dotnetPath: () => undefined,
        log: () => undefined,
        run,
      });

      const error = await factory().catch((err: unknown) => err);

      expect(error).toBeInstanceOf(EngineUnavailableError);
      expect((error as EngineUnavailableError).reason).toBe('serverMissing');
      expect(ran).toEqual([]);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});
