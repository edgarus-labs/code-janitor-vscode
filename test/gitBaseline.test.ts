import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readHeadVersion } from '../src/cleanup/gitBaseline';

const BASE = [
  'namespace Demo',
  '{',
  '    internal class Counter',
  '    {',
  '        private int total;',
  '',
  '        public void Add(int value)',
  '        {',
  '            if (value > 0)',
  '                total += value;',
  '        }',
  '    }',
  '}',
  '',
].join('\n');

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codejanitor-changed-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('readHeadVersion', () => {
  // Neither the developer's Git configuration (signing, hooks) nor a repository around the temp folder counts. The null device
  // is not accepted as a config file on Windows, so the global config is an empty file; the hooks folder does not exist,
  // so Git runs no hook.
  const emptyConfig = path.join(os.tmpdir(), 'codejanitor-empty-gitconfig');
  const noHooks = path.join(os.tmpdir(), 'codejanitor-no-hooks');

  beforeEach(() => {
    fs.writeFileSync(emptyConfig, '');
    vi.stubEnv('GIT_CONFIG_GLOBAL', emptyConfig);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_CEILING_DIRECTORIES', path.dirname(fs.realpathSync(root)));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(emptyConfig, { force: true });
  });

  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${noHooks}`, ...args], {
      cwd: root,
      stdio: 'pipe',
    });

  it('reads the committed text of a tracked file, and tells new files and files outside Git apart', async () => {
    const outside = await readHeadVersion(path.join(root, 'Counter.cs'));
    git('init', '-q');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'Counter.cs'), BASE);
    const beforeFirstCommit = await readHeadVersion(path.join(root, 'src', 'Counter.cs'));
    git('add', '.');
    git('commit', '-q', '-m', 'initial');
    fs.writeFileSync(path.join(root, 'src', 'Counter.cs'), `${BASE}// edited\n`);
    fs.writeFileSync(path.join(root, 'src', 'New.cs'), 'class New { }\n');

    expect(outside.kind).toBe('unavailable');
    expect(beforeFirstCommit).toEqual({ kind: 'new' });
    expect(await readHeadVersion(path.join(root, 'src', 'Counter.cs'))).toEqual({ kind: 'tracked', text: BASE });
    expect(await readHeadVersion(path.join(root, 'src', 'New.cs'))).toEqual({ kind: 'new' });
  });

  it('reads a tracked file deleted from disk, and reports a file of a missing folder as unavailable instead of throwing', async () => {
    git('init', '-q');
    fs.writeFileSync(path.join(root, 'Counter.cs'), BASE);
    git('add', '.');
    git('commit', '-q', '-m', 'initial');
    fs.rmSync(path.join(root, 'Counter.cs'));

    expect(await readHeadVersion(path.join(root, 'Counter.cs'))).toEqual({ kind: 'tracked', text: BASE });
    expect((await readHeadVersion(path.join(root, 'gone', 'Other.cs'))).kind).toBe('unavailable');
  });

  it('reports a repository whose HEAD cannot be read as unavailable, not as a new file', async () => {
    git('init', '-q');
    fs.writeFileSync(path.join(root, 'Counter.cs'), BASE);
    git('add', '.');
    git('commit', '-q', '-m', 'initial');
    const branch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(root, '.git', 'refs', 'heads', branch), `${'1'.repeat(40)}\n`);

    const baseline = await readHeadVersion(path.join(root, 'Counter.cs'));

    expect(baseline.kind).toBe('unavailable');
  });

  it.skipIf(process.platform === 'win32')('gives up on a Git that does not answer in time', async () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'codejanitor-fake-git-'));
    try {
      fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nexec sleep 5\n', { mode: 0o755 });
      vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`);
      const started = Date.now();

      const baseline = await readHeadVersion(path.join(root, 'Counter.cs'), { timeoutMs: 200 });

      expect(baseline).toMatchObject({ kind: 'unavailable', reason: expect.stringContaining('did not answer within 200 ms') });
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });
});
