/**
 * `npm run check -- [--root <dir>] <path>...`: Code Janitor's check mode for CI, the C# engine's `check`
 * command (`dotnet dist/server/CodeJanitor.Server.dll check`). Runs cleanup as a dry run over the C# files
 * of the paths (default: the current folder) and prints `file:line: rule (severity): message` for every
 * change cleanup would make and every enforced `.editorconfig` violation it cannot fix. Exits with 1 when
 * there is any, 2 on a usage error. Needs .NET 10 or newer (the SDK to load projects); no VS Code.
 */
import { spawnSync } from 'node:child_process';
import { ensureServerBuilt } from './engineServer';

const args = process.argv.slice(2).filter((arg) => arg !== '--');

// `process.exitCode` rather than `process.exit()`: exiting at once can cut off the report still being
// written to a pipe (CI step output), leaving a failure without the lines that explain it. Exit code 1 is
// reserved for findings, so a server that cannot be built or started is 2, like a usage error.
try {
  const result = spawnSync(process.env.CODE_JANITOR_DOTNET ?? 'dotnet', [ensureServerBuilt(), 'check', ...args], { stdio: 'inherit' });
  if (result.error) {
    console.error(`Code Janitor check failed: ${result.error.message}`);
  }

  process.exitCode = result.status ?? 2;
} catch (err) {
  console.error(`Code Janitor check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
}
