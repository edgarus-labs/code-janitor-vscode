import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** What a file was at the last commit: its text, nothing (a new file), or unknown. */
export type Baseline =
  | { readonly kind: 'tracked'; readonly text: string }
  | { readonly kind: 'new' }
  | { readonly kind: 'unavailable'; readonly reason: string };

/**
 * The text of `filePath` at `HEAD` of its Git repository (`git show HEAD:<path>`). A file of a
 * repository without commits, or not in `HEAD`, is new; without Git or a repository, the baseline
 * is unavailable.
 */
export async function readHeadVersion(filePath: string): Promise<Baseline> {
  const directory = path.dirname(filePath);
  let root: string;
  try {
    root = (await git(directory, 'rev-parse', '--show-toplevel')).trim();
  } catch (err) {
    return { kind: 'unavailable', reason: `${directory} is not in a Git repository (${firstLine(err)})` };
  }

  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(filePath)).split(path.sep).join('/');
  try {
    await git(root, 'cat-file', '-e', `HEAD:${relative}`);
  } catch {
    // No commit yet, or the file is not in HEAD (untracked or only added).
    return { kind: 'new' };
  }

  return { kind: 'tracked', text: await git(root, 'show', `HEAD:${relative}`) };
}

function git(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
  );
}

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0];
}
