// Smoke-tests the cleanup pipeline against every .cs file in an arbitrary real-world repository.
// Read-only: nothing is written back. Useful for catching parser/pipeline crashes that hand-written
// unit test fixtures don't reach, without needing a VS Code host at all (the pipeline has no
// `vscode` dependency).
//
// Usage: node scripts/smoke-test.js <path-to-repo> [--verbose]
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const target = process.argv[2];
const verbose = process.argv.includes('--verbose');

if (!target) {
  console.error('Usage: node scripts/smoke-test.js <path-to-repo> [--verbose]');
  process.exit(1);
}

const SKIP_DIRS = new Set(['bin', 'obj', 'node_modules', '.git', '.vs']);

function collectCSharpFiles(root) {
  const files = [];
  const stack = [root];

  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          stack.push(path.join(dir, entry.name));
        }
      } else if (entry.name.toLowerCase().endsWith('.cs')) {
        files.push(path.join(dir, entry.name));
      }
    }
  }

  return files;
}

const entry = `
import { runCleanup } from './src/cleanup/runCleanup';
import { createDefaultSettings } from './src/cleanup/types';
import { createDefaultXmlDocOptions, planTargets } from './src/cleanup/xmlDocumentation';

const files: string[] = ${JSON.stringify(collectCSharpFiles(path.resolve(target)))};
const settings = createDefaultSettings();
const xmlDocOptions = createDefaultXmlDocOptions();

let cleanupErrors = 0;
let xmlDocErrors = 0;
let changed = 0;
let aiTargetsPlanned = 0;

for (const file of files) {
  const fs = require('node:fs');
  const source = fs.readFileSync(file, 'utf8');

  try {
    const output = runCleanup(source, file, settings);
    if (output !== source) {
      changed++;
    }
  } catch (err) {
    cleanupErrors++;
    console.log('[cleanup-error]', file);
    console.log('  ' + (err instanceof Error ? (err.stack || err.message) : String(err)).replace(/\\n/g, '\\n  '));
  }

  try {
    const targets = planTargets(source, xmlDocOptions);
    aiTargetsPlanned += targets.filter((t) => t.requiresAi).length;
  } catch (err) {
    xmlDocErrors++;
    console.log('[xmldoc-plan-error]', file);
    console.log('  ' + (err instanceof Error ? (err.stack || err.message) : String(err)).replace(/\\n/g, '\\n  '));
  }
}

console.log('');
console.log('Files scanned:            ' + files.length);
console.log('Cleanup exceptions:       ' + cleanupErrors);
console.log('XML doc plan exceptions:  ' + xmlDocErrors);
console.log('Files cleanup would change: ' + changed);
console.log('AI documentation targets planned: ' + aiTargetsPlanned);

if (cleanupErrors > 0 || xmlDocErrors > 0) {
  process.exitCode = 1;
}
`;

async function main() {
  await esbuild.build({
    stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts', sourcefile: 'smoke-test-entry.ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: 'out/smoke-test.cjs',
    logLevel: verbose ? 'info' : 'warning',
  });

  require(path.resolve('out/smoke-test.cjs'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
