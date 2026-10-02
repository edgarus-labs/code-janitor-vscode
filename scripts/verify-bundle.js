// Bundles the cleanup pipeline exactly like the extension bundle and runs it, so that any
// bundler-level breakage is caught (the unit tests import the sources directly and would not
// notice).
const esbuild = require('esbuild');
const path = require('node:path');

const entry = `
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCleanup } from './src/cleanup/runCleanup';
import { createDefaultSettings } from './src/cleanup/types';

function main(): void {
  const source = 'namespace N\\n{\\n    class C\\n    {\\n        void M() { }\\n    }\\n}\\n';
  // File-scoped namespaces need a project that is known to use C# 10 or newer.
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-bundle-'));
  fs.writeFileSync(path.join(folder, 'Check.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>');
  const output = runCleanup(source, path.join(folder, 'check.cs'), { ...createDefaultSettings(), convertToFileScopedNamespace: true });
  fs.rmSync(folder, { recursive: true, force: true });

  if (!output.includes('namespace N;') || !output.includes('internal class C')) {
    throw new Error('Unexpected bundled pipeline output:\\n' + output);
  }

  console.log('Bundle check passed.');
}

main();
`;

async function main() {
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
