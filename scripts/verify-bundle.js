// Bundles the cleanup pipeline exactly like the extension bundle and runs it, which is the only
// way to catch bundler-level breakage of the tree-sitter WebAssembly loading (the unit tests
// import the sources directly and would not notice).
const esbuild = require('esbuild');
const path = require('node:path');

const entry = `
import { initCSharpParser } from './src/cleanup/parser';
import { runCleanup } from './src/cleanup/runCleanup';
import { createDefaultSettings } from './src/cleanup/types';

async function main(): Promise<void> {
  await initCSharpParser({ wasmDirectory: __dirname });

  const source = 'namespace N\\n{\\n    class C\\n    {\\n        void M() { }\\n    }\\n}\\n';
  const output = runCleanup(source, 'check.cs', { ...createDefaultSettings(), convertToFileScopedNamespace: true });

  if (!output.includes('namespace N;') || !output.includes('internal class C')) {
    throw new Error('Unexpected bundled pipeline output:\\n' + output);
  }

  console.log('Bundle check passed.');
}

void main();
`;

async function main() {
  await esbuild.build({
    stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts', sourcefile: 'verify-bundle.ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: 'dist/verify-bundle.cjs',
    logLevel: 'warning',
    banner: { js: "const __codejanitor_module_url = require('node:url').pathToFileURL(__filename).href;" },
    define: { 'import.meta.url': '__codejanitor_module_url' },
  });

  require(path.resolve('dist/verify-bundle.cjs'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
