/**
 * `npm run check -- [--root <dir>] <path>...`: Code Janitor's check mode for CI. Runs cleanup as a
 * dry run over the C# files of the paths (default: the current folder) and prints
 * `file:line: rule (severity): message` for every change cleanup would make and every enforced
 * `.editorconfig` violation it cannot fix. Exits with 1 when there is any, 2 on a usage error.
 * Needs no VS Code and no .NET SDK.
 */
import { checkPaths } from '../src/cli/check';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const rootIndex = args.indexOf('--root');
const root = rootIndex >= 0 ? args[rootIndex + 1] : process.cwd();
const paths = args.filter((_, index) => rootIndex < 0 || (index !== rootIndex && index !== rootIndex + 1));

// `process.exitCode` rather than `process.exit()`: exiting at once can cut off the report still being
// written to a pipe (CI step output), leaving a failure without the lines that explain it.
if (root === undefined || paths.some((arg) => arg.startsWith('--'))) {
  console.error('Usage: npm run check -- [--root <repository root>] [<file or folder>...]');
  process.exitCode = 2;
} else {
  checkPaths(paths.length > 0 ? paths : ['.'], root).then(
    (report) => {
      report.lines.forEach((line) => console.log(line));
      process.exitCode = report.exitCode;
    },
    (err: unknown) => {
      console.error(`Code Janitor check failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 2;
    }
  );
}
