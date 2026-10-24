import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

export interface PackagedVersions {
  readonly packageJson: string | undefined;
  readonly manifest: string | undefined;
  readonly assemblies: Readonly<Record<string, string | undefined>>;
}

const PACKAGE_JSON = 'extension/package.json';
const MANIFEST = 'extension.vsixmanifest';
const ASSEMBLY_FOLDER = 'extension/dist/server/';
const ASSEMBLIES = ['CodeJanitor.Server.dll', 'CodeJanitor.Engine.dll'];

export function vsixFileName(version: string): string {
  return `edgarus-labs.code-janitor.vscode.v${version}.vsix`;
}

// The sizes are read from the central directory: vsce writes zeros in the local headers and a data descriptor
// after each entry.
function zipEntries(zip: Buffer, wanted: ReadonlySet<string>): Map<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > zip.length) {
    throw new Error('The file is not a VSIX: no zip central directory.');
  }

  const entries = new Map<string, Buffer>();
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  for (let index = 0; index < count; index++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) {
      throw new Error('The file is not a VSIX: corrupt zip central directory.');
    }

    const method = zip.readUInt16LE(at + 10);
    const compressedSize = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const localHeader = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (!wanted.has(name)) {
      continue;
    }

    if (zip.readUInt32LE(localHeader) !== 0x04034b50) {
      throw new Error(`The file is not a VSIX: corrupt zip entry ${name}.`);
    }

    const start = localHeader + 30 + zip.readUInt16LE(localHeader + 26) + zip.readUInt16LE(localHeader + 28);
    const data = zip.subarray(start, start + compressedSize);
    if (method !== 0 && method !== 8) {
      throw new Error(`The VSIX entry ${name} uses zip compression method ${method}, which this check cannot read.`);
    }

    entries.set(name, method === 8 ? inflateRawSync(data) : data);
  }

  return entries;
}

// The ProductVersion string of the assembly's Win32 version resource, where the .NET SDK writes the
// informational version, without the source revision the SDK appends after a '+'. Its String entry holds the
// entry length, the value length in UTF-16 characters and the type, then the null-terminated key and value,
// the value aligned to 4 bytes.
function assemblyProductVersion(assembly: Buffer): string | undefined {
  const key = Buffer.from('ProductVersion\0', 'utf16le');
  const keyAt = assembly.indexOf(key);
  if (keyAt < 6) {
    return undefined;
  }

  const entryAt = keyAt - 6;
  const valueLength = assembly.readUInt16LE(entryAt + 2);
  const valueAt = entryAt + Math.ceil((6 + key.length) / 4) * 4;
  const value = assembly.toString('utf16le', valueAt, valueAt + valueLength * 2).replace(/\0+$/, '');

  return value.split('+')[0] || undefined;
}

export function packagedVersions(vsix: Buffer): PackagedVersions {
  const entries = zipEntries(vsix, new Set([PACKAGE_JSON, MANIFEST, ...ASSEMBLIES.map((name) => ASSEMBLY_FOLDER + name)]));
  const packageJson = entries.get(PACKAGE_JSON)?.toString('utf8');
  const manifest = entries.get(MANIFEST)?.toString('utf8');
  const packagedVersion = packageJson === undefined ? undefined : (JSON.parse(packageJson) as { version?: unknown }).version;

  return {
    packageJson: typeof packagedVersion === 'string' ? packagedVersion : undefined,
    manifest: manifest === undefined ? undefined : /<Identity\b[^>]*\bVersion="([^"]*)"/.exec(manifest)?.[1],
    assemblies: Object.fromEntries(
      ASSEMBLIES.map((name) => {
        const assembly = entries.get(ASSEMBLY_FOLDER + name);

        return [name, assembly === undefined ? undefined : assemblyProductVersion(assembly)];
      })
    ),
  };
}

export function releaseVersionProblems(input: {
  readonly tag: string | undefined;
  readonly packageVersion: string;
  readonly packaged: PackagedVersions;
  readonly vsixPath: string;
}): string[] {
  const { tag, packageVersion, packaged, vsixPath } = input;
  const problems: string[] = [];
  if (tag !== undefined && tag !== `v${packageVersion}`) {
    problems.push(`The tag '${tag}' does not match package.json version ${packageVersion} (expected tag v${packageVersion}).`);
  }

  if (packaged.packageJson !== packageVersion) {
    problems.push(
      packaged.packageJson === undefined
        ? `The VSIX has no ${PACKAGE_JSON} version.`
        : `The VSIX ${PACKAGE_JSON} has version ${packaged.packageJson}, package.json has ${packageVersion}.`
    );
  }

  if (packaged.manifest !== packageVersion) {
    problems.push(
      packaged.manifest === undefined
        ? `The VSIX has no ${MANIFEST} Identity version.`
        : `The VSIX ${MANIFEST} has version ${packaged.manifest}, package.json has ${packageVersion}.`
    );
  }

  for (const name of ASSEMBLIES) {
    const version = packaged.assemblies[name];
    if (version !== packageVersion) {
      problems.push(
        version === undefined
          ? `The VSIX has no ${ASSEMBLY_FOLDER}${name} with a product version.`
          : `The VSIX ${ASSEMBLY_FOLDER}${name} has product version ${version}, package.json has ${packageVersion}.`
      );
    }
  }

  const fileName = path.basename(vsixPath);
  if (fileName !== vsixFileName(packageVersion)) {
    problems.push(`The VSIX is named ${fileName}, expected ${vsixFileName(packageVersion)}.`);
  }

  return problems;
}
