import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CompilerError } from '../../scripts/compileOracle';
import { BuildResult } from './dotnetBuild';

/**
 * Real-compiler verification of Razor: the Razor source generator reports `RZxxxx` errors besides the
 * C# compiler's `CSxxxx`, which `test/helpers/dotnetBuild.ts` (C# only) does not read.
 */
const ERROR_LINE = /^(?:(.+?)\((\d+),\d+\)|[^:]+?)\s*:\s*error ((?:CS|RZ|BL|MVC|ASP)\d+)\s*:\s*(.*?)(?:\s+\[[^\]]+\])?$/;

/** The compiler and Razor errors of a build, each once. */
export function razorErrors(output: string, root: string): CompilerError[] {
  const seen = new Set<string>();
  const errors: CompilerError[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = ERROR_LINE.exec(line.trim());
    if (!match || seen.has(line.trim())) {
      continue;
    }

    seen.add(line.trim());
    const file = match[1] ? path.relative(root, match[1]).split(path.sep).join('/') : '';
    errors.push({ code: match[3], file, line: match[2] ? Number(match[2]) : 0, message: match[4] });
  }

  return errors;
}

const SKIPPED = new Set(['bin', 'obj']);

/** All files under `folder`, relative and `/`-separated, without build output. */
export function projectFiles(folder: string, relative = ''): string[] {
  return fs.readdirSync(path.join(folder, relative), { withFileTypes: true }).flatMap((entry) => {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      return SKIPPED.has(entry.name) ? [] : projectFiles(folder, child);
    }

    return [child];
  });
}

/** Copies a project folder (without build output) to a new temporary folder. */
export function copyProject(source: string): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-razor-'));
  for (const file of projectFiles(source)) {
    fs.mkdirSync(path.dirname(path.join(folder, file)), { recursive: true });
    fs.copyFileSync(path.join(source, file), path.join(folder, file));
  }

  return folder;
}

export function buildRazorProject(folder: string, projectName: string): BuildResult {
  const result = spawnSync(
    'dotnet',
    [
      'build',
      path.join(folder, projectName),
      '-nologo',
      '-v:q',
      '-clp:NoSummary',
      '-p:RunAnalyzers=false',
      '-p:EnforceCodeStyleInBuild=false',
      '-p:TreatWarningsAsErrors=false',
      '-p:WarningsAsErrors=',
    ],
    { cwd: folder, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
  );
  const output = `${result.stdout}\n${result.stderr}`;

  return { ok: result.status === 0, errors: razorErrors(output, folder), output };
}
