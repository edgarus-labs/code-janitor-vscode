// Bundles the C# engine client exactly like the extension bundle and runs it against the published
// server (dist/server, `npm run build`), so that any bundler-level breakage of the client, its JSON-RPC
// transport or the packaged server is caught (the unit tests import the sources directly and would not
// notice).
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const entry = `
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EngineClient } from './src/engine/client';
import { serverTransportFactory } from './src/engine/serverProcess';
import { toEngineSettings } from './src/engine/settings';
import { runLayoutCleanup } from './src/cleanup/layoutCleanup';
import { createDefaultSettings } from './src/cleanup/types';

async function main(): Promise<void> {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-bundle-'));
  const log: string[] = [];
  const engine = new EngineClient(
    serverTransportFactory({ serverDll: path.resolve('dist/server/CodeJanitor.Server.dll'), dotnetPath: () => process.env.CODE_JANITOR_DOTNET, log: (line) => log.push(line) }),
    { workspaceFolders: () => [folder], log: (line) => log.push(line), maxRestarts: 0 }
  );
  try {
    fs.writeFileSync(path.join(folder, 'Check.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>');
    const filePath = path.join(folder, 'Check.cs');
    const text = 'namespace N\\n{\\n    class C\\n    {\\n        #region Members\\n        void M() { }   \\n        #endregion\\n    }\\n}\\n';
    fs.writeFileSync(filePath, text);
    const result = await engine.cleanup({ filePath, text, settings: toEngineSettings(createDefaultSettings()) });
    if (result.text.includes('#region') || /\\} +\\n/.test(result.text)) {
      throw new Error('Unexpected bundled engine output:\\n' + result.text + '\\n' + log.join('\\n'));
    }
  } finally {
    await engine.shutdown();
    fs.rmSync(folder, { recursive: true, force: true });
  }

  // The layout rules of the other file types stay in the extension.
  if (runLayoutCleanup('a  \\n', 'notes.txt', createDefaultSettings()) !== 'a\\n') {
    throw new Error('Unexpected bundled layout cleanup output.');
  }

  console.log('Bundle check passed.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
`;

async function main() {
  if (!fs.existsSync('dist/server/CodeJanitor.Server.dll')) {
    throw new Error('dist/server/CodeJanitor.Server.dll is missing: run `npm run build` first.');
  }

  await esbuild.build({
    stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts', sourcefile: 'verify-bundle.ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: 'dist/verify-bundle.cjs',
    logLevel: 'warning',
  });

  require(path.resolve('dist/verify-bundle.cjs'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
