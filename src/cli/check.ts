import * as fs from 'node:fs';
import * as path from 'node:path';
import { CleanupFinding, analyzeCleanup } from '../cleanup/analysis';
import { applyRepositoryPolicy, readRepositoryPolicy } from '../cleanup/repositoryOverrides';
import { discoverDisqualifiedTypeNames } from '../cleanup/transformations/sealedClass';
import { createDefaultSettings } from '../cleanup/types';

/**
 * Check mode for CI, without VS Code: runs cleanup as a dry run over C# files and lists, as
 * `file:line: rule (severity): message`, every change cleanup would make and every enforced
 * `.editorconfig` violation it cannot fix. The exit code is 1 when there is any.
 */

const SKIPPED_FOLDERS = new Set(['bin', 'obj', 'node_modules', '.git', '.vs']);

export interface CheckReport {
  readonly lines: readonly string[];
  readonly exitCode: 0 | 1;
}

/**
 * Checks the `.cs` files of `paths` (files or folders, relative to the current folder; `bin`/`obj` excluded) with the Code Janitor
 * defaults, each file's nearest `.codejanitor` and its `.editorconfig`. Paths are shown relative to `root`.
 */
export async function checkPaths(paths: readonly string[], root: string): Promise<CheckReport> {
  const files = [...new Set(paths.flatMap((target) => csharpFiles(path.resolve(target))))].sort();
  const sources = new Map(await Promise.all(files.map(async (file) => [file, await fs.promises.readFile(file, 'utf8')] as const)));
  const disqualifiedTypeNames = discoverDisqualifiedTypeNames(sources.values());

  const lines: string[] = [];
  let changing = 0;
  let unfixable = 0;
  for (const [file, source] of sources) {
    const siblingFileNames = new Set(fs.readdirSync(path.dirname(file)).filter((name) => name.toLowerCase().endsWith('.cs')));
    // The nearest `.codejanitor` of each file, found walking up from its folder.
    const settings = applyRepositoryPolicy(createDefaultSettings(), readRepositoryPolicy(path.dirname(file), (message) => console.warn(message)));
    const { findings } = analyzeCleanup(source, file, settings, { disqualifiedTypeNames, siblingFileNames });
    const shown = path.relative(root, file).split(path.sep).join('/');
    lines.push(...findings.map((finding) => `${shown}:${finding.startLine + 1}: ${describe(finding)}`));
    changing += findings.some((finding) => finding.wouldChange) ? 1 : 0;
    unfixable += findings.filter((finding) => !finding.wouldChange).length;
  }

  if (changing === 0 && unfixable === 0) {
    return { lines: [`Code Janitor check: ${files.length} file(s) checked, all clean.`], exitCode: 0 };
  }

  lines.push(`Code Janitor check: ${files.length} file(s) checked, ${changing} would change, ${unfixable} violation(s) cleanup cannot fix.`);

  return { lines, exitCode: 1 };
}

function describe(finding: CleanupFinding): string {
  return `${finding.rule}${finding.severity ? ` (${finding.severity})` : ''}: ${finding.message}`;
}

/** `target` itself when it is a file, or the `.cs` files under it outside build and tool folders. */
function csharpFiles(target: string): string[] {
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) {
    return [target];
  }

  return fs.readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) {
      return SKIPPED_FOLDERS.has(entry.name.toLowerCase()) ? [] : csharpFiles(full);
    }

    return entry.name.toLowerCase().endsWith('.cs') ? [full] : [];
  });
}
