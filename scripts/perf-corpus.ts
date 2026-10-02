// Performance probe: times every cleanup step over a C# corpus with the generated .editorconfig
// (every rule cleanup applies set to warning) and writes each file's output and reports, so that
// two runs (before and after a change) can be diffed for byte-identical results.
//
// Development-time only; read-only for the corpus: it is copied to a temporary folder first.
//
// Usage: npm run perf:corpus -- <corpus folder> [<output folder>]
//   The output folder receives, per C# file, `<path>.out` (cleaned text), `<path>.issues` (the
//   reports) and `<path>.second` when a second cleanup of the output still changes it; plus
//   `timings.txt`. PERF_FILTER=<substring> limits the run to matching paths.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { getCleanupPipeline } from '../src/cleanup/runCleanup';
import { discoverDisqualifiedTypeNames } from '../src/cleanup/transformations/sealedClass';
import { createDefaultSettings } from '../src/cleanup/types';
import { renderEditorConfig } from './editorConfigTemplate';

const SKIPPED_FOLDERS = new Set(['bin', 'obj', '.git', '.vs', 'node_modules']);

function copyTree(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIPPED_FOLDERS.has(entry.name) || entry.name === '.editorconfig') {
      continue;
    }

    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyTree(source, target);
    } else if (entry.isFile()) {
      fs.copyFileSync(source, target);
    }
  }
}

function csharpFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return SKIPPED_FOLDERS.has(entry.name) ? [] : csharpFiles(full);
      }

      return entry.name.endsWith('.cs') ? [full] : [];
    })
    .sort();
}

const [corpusArgument, outputArgument] = process.argv.slice(2);
if (!corpusArgument) {
  console.error('Usage: npm run perf:corpus -- <corpus folder> [<output folder>]');
  process.exit(1);
}

const corpus = path.resolve(corpusArgument);
const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-perf-'));
copyTree(corpus, copy);
fs.writeFileSync(path.join(copy, '.editorconfig'), renderEditorConfig(), 'utf8');
const output = outputArgument ? path.resolve(outputArgument) : undefined;
const filter = process.env.PERF_FILTER;

const files = csharpFiles(copy).filter((file) => !filter || file.includes(filter));
const inputs = new Map(files.map((file) => [file, fs.readFileSync(file, 'utf8')]));
const disqualified = discoverDisqualifiedTypeNames(inputs.values());
const settings = createDefaultSettings();
const stageTotals = new Map<string, number>();
const fileTotals: { file: string; ms: number }[] = [];
let notIdempotent = 0;

function clean(source: string, file: string, issues: string[], timed: boolean): string {
  const started = performance.now();
  const pipeline = getCleanupPipeline(source, file, settings, disqualified, (issue) => issues.push(`${issue.kind}: ${issue.filePath}: ${issue.detail}`));
  if (timed) {
    stageTotals.set('(pipeline setup)', (stageTotals.get('(pipeline setup)') ?? 0) + performance.now() - started);
  }

  let current = source;
  for (const step of pipeline.transformations) {
    const before = performance.now();
    current = step.apply(current) ?? current;
    if (timed) {
      stageTotals.set(step.name, (stageTotals.get(step.name) ?? 0) + performance.now() - before);
    }
  }

  return current;
}

const started = performance.now();
for (const file of files) {
  const input = inputs.get(file) as string;
  const issues: string[] = [];
  const fileStarted = performance.now();
  const cleaned = clean(input, file, issues, true);
  fileTotals.push({ file: path.relative(copy, file), ms: performance.now() - fileStarted });

  const second = clean(cleaned, file, [], false);
  if (second !== cleaned) {
    notIdempotent++;
  }

  if (output) {
    const target = path.join(output, path.relative(copy, file));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(`${target}.out`, cleaned, 'utf8');
    fs.writeFileSync(`${target}.issues`, issues.map((issue) => issue.replace(copy, '<corpus>')).join('\n'), 'utf8');
    if (second !== cleaned) {
      fs.writeFileSync(`${target}.second`, second, 'utf8');
    }
  }
}

const total = performance.now() - started;
const cleanupTotal = fileTotals.reduce((sum, entry) => sum + entry.ms, 0);
const lines = [
  `files: ${files.length}, cleanup: ${cleanupTotal.toFixed(0)} ms (with the idempotence pass: ${total.toFixed(0)} ms), not idempotent: ${notIdempotent}`,
  '',
  'stage totals (first pass):',
  ...[...stageTotals]
    .sort((a, b) => b[1] - a[1])
    .map(([name, ms]) => `  ${ms.toFixed(0).padStart(7)} ms  ${name}`),
  '',
  'slowest files:',
  ...[...fileTotals]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 10)
    .map((entry) => `  ${entry.ms.toFixed(0).padStart(7)} ms  ${entry.file}`),
];
console.log(lines.join('\n'));
if (output) {
  fs.writeFileSync(path.join(output, 'timings.txt'), `${lines.join('\n')}\n`, 'utf8');
}

fs.rmSync(copy, { recursive: true, force: true });
