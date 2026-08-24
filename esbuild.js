// Minimal esbuild bundler for the extension host (CommonJS, Node target, vscode external).
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// The tree-sitter runtime and the C# grammar are WebAssembly: one artifact for every OS/CPU.
const wasmModules = [
  ['node_modules/web-tree-sitter/tree-sitter.wasm', 'tree-sitter.wasm'],
  ['node_modules/tree-sitter-wasms/out/tree-sitter-c_sharp.wasm', 'tree-sitter-c_sharp.wasm'],
];

function copyWasmModules() {
  fs.mkdirSync('dist', { recursive: true });

  for (const [from, name] of wasmModules) {
    if (!fs.existsSync(from)) {
      throw new Error(`Missing ${from}. Run "npm install" first.`);
    }

    fs.copyFileSync(from, path.join('dist', name));
  }
}

// Logs the begin/end markers the .vscode/tasks.json "$esbuild-watch" problem matcher looks for.
const watchLogPlugin = {
  name: 'watch-log',
  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`);
        }
      });
      console.log('[watch] build finished');
    });
  },
};

// The tree-sitter glue is ESM and calls createRequire(import.meta.url); the CJS bundle has to
// provide an equivalent module URL.
const moduleUrlShim = {
  banner: { js: "const __codejanitor_module_url = require('node:url').pathToFileURL(__filename).href;" },
  define: { 'import.meta.url': '__codejanitor_module_url' },
};

async function main() {
  copyWasmModules();

  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    logLevel: 'silent',
    plugins: [watchLogPlugin],
    ...moduleUrlShim,
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
