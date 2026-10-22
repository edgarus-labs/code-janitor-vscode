// Performance probe: times the C# engine's cleanup of every file of a C# corpus with the generated
// .editorconfig (every rule cleanup applies set to warning), counts what each rule changed, and writes
// each file's output and reports, so that two runs (before and after a change) can be diffed for
// byte-identical results.
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
import { createDefaultSettings } from '../src/cleanup/types';
import { CleanupResult } from '../src/engine/protocol';
import { toEngineSettings } from '../src/engine/settings';
import { renderEditorConfig } from './editorConfigTemplate';
import { startEngine } from './engineServer';

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

async function main(corpus: string): Promise<void> {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-perf-'));
  // The copy holds the whole corpus: it is removed even when a cleanup fails.
  const engine = startEngine([copy]);
  try {
    copyTree(corpus, copy);
    fs.writeFileSync(path.join(copy, '.editorconfig'), renderEditorConfig(), 'utf8');
    const output = outputArgument ? path.resolve(outputArgument) : undefined;
    const filter = process.env.PERF_FILTER;

    const files = csharpFiles(copy).filter((file) => !filter || file.includes(filter));
    const settings = toEngineSettings(createDefaultSettings());
    const ruleTotals = new Map<string, number>();
    const fileTotals: { file: string; ms: number }[] = [];
    let notIdempotent = 0;
    const clean = (text: string, filePath: string): Promise<CleanupResult> => engine.cleanup({ filePath, text, settings });

    // The first request loads the projects: it is timed apart.
    const loadStarted = performance.now();
    if (files[0]) {
      await clean(fs.readFileSync(files[0], 'utf8'), files[0]);
    }
    const load = performance.now() - loadStarted;

    const started = performance.now();
    for (const file of files) {
      const input = fs.readFileSync(file, 'utf8');
      const fileStarted = performance.now();
      const first = await clean(input, file);
      fileTotals.push({ file: path.relative(copy, file), ms: performance.now() - fileStarted });
      for (const rule of first.rules.filter((candidate) => candidate.changes > 0)) {
        ruleTotals.set(rule.name, (ruleTotals.get(rule.name) ?? 0) + rule.changes);
      }

      const second = (await clean(first.text, file)).text;
      if (second !== first.text) {
        notIdempotent++;
      }

      if (output) {
        const target = path.join(output, path.relative(copy, file));
        const issues = [
          ...first.issues,
          ...first.unresolved.map((unresolved) => `unresolved: ${unresolved.id} line ${unresolved.line}: ${unresolved.message} (${unresolved.reason})`),
        ];
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(`${target}.out`, first.text, 'utf8');
        fs.writeFileSync(`${target}.issues`, issues.map((issue) => issue.replace(copy, '<corpus>')).join('\n'), 'utf8');
        if (second !== first.text) {
          fs.writeFileSync(`${target}.second`, second, 'utf8');
        }
      }
    }

    const total = performance.now() - started;
    const cleanupTotal = fileTotals.reduce((sum, entry) => sum + entry.ms, 0);
    const lines = [
      `files: ${files.length}, project load: ${load.toFixed(0)} ms, cleanup: ${cleanupTotal.toFixed(0)} ms (with the idempotence pass: ${total.toFixed(0)} ms), not idempotent: ${notIdempotent}`,
      '',
      'changes by rule (first pass):',
      ...[...ruleTotals].sort((a, b) => b[1] - a[1]).map(([name, changes]) => `  ${String(changes).padStart(7)}  ${name}`),
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
  } finally {
    await engine.shutdown();
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

main(path.resolve(corpusArgument)).catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
