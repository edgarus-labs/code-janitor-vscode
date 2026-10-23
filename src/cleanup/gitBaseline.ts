import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** What a file was at the last commit: its text, nothing (a new file), or unknown. */
export type Baseline =
  { readonly kind: 'tracked'; readonly text: string } | { readonly kind: 'new' } | { readonly kind: 'unavailable'; readonly reason: string };

/** How long one Git command may run before the baseline is given up as unavailable. */
const GIT_TIMEOUT_MS = 10_000;

/**
 * The text of `filePath` at `HEAD` of its Git repository (`git show HEAD:<path>`). A file of a
 * repository without commits, or not in `HEAD`, is new (also when it is not on disk: an unsaved
 * editor buffer); without Git or a repository, when Git cannot read `HEAD` or the file, or does not answer
 * within `timeoutMs`, the baseline is unavailable. Never throws.
 */
export async function readHeadVersion(filePath: string, options: { readonly timeoutMs?: number } = {}): Promise<Baseline> {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const directory = path.dirname(filePath);
  let root: string;
  let relative: string;
  try {
    root = (await git(directory, timeoutMs, 'rev-parse', '--show-toplevel')).trim();
    // The folder, not the file, is resolved: the file may exist only in the editor or in HEAD.
    const realFile = path.join(await fs.promises.realpath(directory), path.basename(filePath));
    relative = path
      .relative(await fs.promises.realpath(root), realFile)
      .split(path.sep)
      .join('/');
  } catch (err) {
    return { kind: 'unavailable', reason: `${directory} is not in a Git repository (${describe(err, timeoutMs)})` };
  }

  try {
    try {
      await git(root, timeoutMs, 'rev-parse', '--verify', '--quiet', 'HEAD');
    } catch (err) {
      // `--quiet` exits with 1 and no message when HEAD names nothing: no commit yet.
      if (err instanceof Error && 'code' in err && err.code === 1) {
        return { kind: 'new' };
      }

      throw err;
    }

    if ((await git(root, timeoutMs, 'ls-tree', '--name-only', 'HEAD', '--', relative)).trim() === '') {
      return { kind: 'new' };
    }

    return { kind: 'tracked', text: await git(root, timeoutMs, 'show', `HEAD:${relative}`) };
  } catch (err) {
    return { kind: 'unavailable', reason: `Git could not read ${relative} at HEAD (${describe(err, timeoutMs)})` };
  }
}

function git(cwd: string, timeoutMs: number, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs }, (error, stdout) =>
      error ? reject(error) : resolve(stdout)
    )
  );
}

function describe(err: unknown, timeoutMs: number): string {
  return err instanceof Error && 'killed' in err && err.killed === true ? `Git did not answer within ${timeoutMs} ms` : firstLine(err);
}

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0];
}
