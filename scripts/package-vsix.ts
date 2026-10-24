/**
 * `npm run package`: packages the extension with vsce as edgarus-labs.code-janitor.vscode.v{version}.vsix,
 * the version taken from package.json (the release workflow sets it from the tag first).
 */
import fs from 'node:fs';
import { createVSIX } from '@vscode/vsce';
import { vsixFileName } from './releaseVersion';

const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { version: string };

createVSIX({ packagePath: vsixFileName(version) }).catch((err: unknown) => {
  console.error(`Packaging failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
