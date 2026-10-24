/**
 * `npm run check:release -- [--tag <tag>] <vsix>`: fails when the tag (if given), package.json, the
 * package.json, manifest and Code Janitor server assemblies packaged in the VSIX, and the VSIX file name do
 * not carry the same version.
 * Exactly one VSIX must be given, so that the CI artifact and the release asset are the same file.
 */
import fs from 'node:fs';
import { packagedVersions, releaseVersionProblems } from './releaseVersion';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const tagIndex = args.indexOf('--tag');
const tag = tagIndex < 0 ? undefined : args[tagIndex + 1];
const vsixPaths = tagIndex < 0 ? args : args.filter((_, index) => index !== tagIndex && index !== tagIndex + 1);

try {
  if ((tagIndex >= 0 && tag === undefined) || vsixPaths.length !== 1) {
    throw new Error(`Usage: check-release-version [--tag <tag>] <vsix>; got ${vsixPaths.length} VSIX path(s): ${vsixPaths.join(' ')}`);
  }

  const [vsixPath] = vsixPaths;
  const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { version: string };
  const problems = releaseVersionProblems({ tag, packageVersion: version, packaged: packagedVersions(fs.readFileSync(vsixPath)), vsixPath });
  for (const problem of problems) {
    console.error(problem);
  }

  if (problems.length > 0) {
    process.exitCode = 1;
  } else {
    console.log(
      `${vsixPath}: version ${version} matches${tag === undefined ? '' : ` the tag ${tag},`} package.json, the packaged manifest and assemblies, and the file name.`
    );
  }
} catch (err) {
  console.error(`Release version check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
