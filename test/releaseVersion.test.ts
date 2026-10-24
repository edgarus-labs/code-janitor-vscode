import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { packagedVersions, releaseVersionProblems, vsixFileName } from '../scripts/releaseVersion';

interface Entry {
  readonly name: string;
  readonly text: string | Buffer;
  readonly deflate?: boolean;
}

// A zip like the one vsce writes: the sizes are only in the central directory, the local headers carry zeros
// and a data descriptor follows each entry.
function zip(entries: readonly Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const raw = Buffer.from(entry.text);
    const data = entry.deflate ? deflateRawSync(raw) : raw;
    const method = entry.deflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x08, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(name.length, 26);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(data.length, 8);
    descriptor.writeUInt32LE(raw.length, 12);
    locals.push(local, name, data, descriptor);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x08, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length + descriptor.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

function manifest(version: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="code-janitor" Version="${version}" Publisher="codejanitor" />
  </Metadata>
</PackageManifest>`;
}

// The StringFileInfo entry of a Win32 version resource, as the .NET SDK writes it into an assembly: the key and
// the value in UTF-16, each ending in a null character, the value and the next entry aligned to 4 bytes.
function versionString(key: string, value: string): Buffer {
  const header = Buffer.alloc(6);
  const keyBytes = Buffer.from(key + '\0', 'utf16le');
  const keyPadding = Buffer.alloc((4 - ((header.length + keyBytes.length) % 4)) % 4);
  const valueBytes = Buffer.from(value + '\0', 'utf16le');
  const length = header.length + keyBytes.length + keyPadding.length + valueBytes.length;
  header.writeUInt16LE(length, 0);
  header.writeUInt16LE(valueBytes.length / 2, 2);
  header.writeUInt16LE(1, 4);

  return Buffer.concat([header, keyBytes, keyPadding, valueBytes, Buffer.alloc((4 - (length % 4)) % 4)]);
}

function assembly(productVersion: string): Buffer {
  return Buffer.concat([
    Buffer.from('MZ\0\0', 'latin1'),
    versionString('FileVersion', '9.9.9.0'),
    versionString('ProductVersion', productVersion),
    versionString('Assembly Version', '9.9.9.0'),
  ]);
}

function vsix(packageVersion: string, manifestVersion: string, assemblyVersion = packageVersion): Buffer {
  return zip([
    { name: '[Content_Types].xml', text: '<Types />' },
    { name: 'extension.vsixmanifest', text: manifest(manifestVersion), deflate: true },
    { name: 'extension/package.json', text: JSON.stringify({ name: 'code-janitor', version: packageVersion }), deflate: true },
    { name: 'extension/dist/server/CodeJanitor.Server.dll', text: assembly(`${assemblyVersion}+0123abc`), deflate: true },
    { name: 'extension/dist/server/CodeJanitor.Engine.dll', text: assembly(assemblyVersion) },
  ]);
}

const noAssemblies = { 'CodeJanitor.Server.dll': undefined, 'CodeJanitor.Engine.dll': undefined };
const assemblies = (version: string) => ({ 'CodeJanitor.Server.dll': version, 'CodeJanitor.Engine.dll': version });

describe('vsixFileName', () => {
  it('names the package edgarus-labs.code-janitor.vscode.v{version}.vsix', () => {
    expect(vsixFileName('1.4.1')).toBe('edgarus-labs.code-janitor.vscode.v1.4.1.vsix');
  });
});

describe('packagedVersions', () => {
  it('reads the version of the packaged package.json and of the VSIX manifest', () => {
    expect(packagedVersions(vsix('1.4.1', '1.4.2'))).toMatchObject({ packageJson: '1.4.1', manifest: '1.4.2' });
  });

  it('reads the product version of the packaged Code Janitor assemblies without the source revision', () => {
    expect(packagedVersions(vsix('1.4.1', '1.4.1', '1.0.0')).assemblies).toEqual(assemblies('1.0.0'));
  });

  it('leaves out the version of an assembly without a version resource', () => {
    const unversioned = zip([{ name: 'extension/dist/server/CodeJanitor.Server.dll', text: Buffer.from('MZ\0\0', 'latin1') }]);

    expect(packagedVersions(unversioned).assemblies).toEqual(noAssemblies);
  });

  it('reads stored entries as well as deflated ones', () => {
    const stored = zip([
      { name: 'extension/package.json', text: '{"version":"2.0.0"}' },
      { name: 'extension.vsixmanifest', text: manifest('2.0.0') },
    ]);

    expect(packagedVersions(stored)).toEqual({ packageJson: '2.0.0', manifest: '2.0.0', assemblies: noAssemblies });
  });

  it('leaves out the versions of entries the package does not contain', () => {
    expect(packagedVersions(zip([{ name: '[Content_Types].xml', text: '<Types />' }]))).toEqual({
      packageJson: undefined,
      manifest: undefined,
      assemblies: noAssemblies,
    });
  });

  it('leaves out the version of a packaged package.json without one', () => {
    const unversioned = zip([
      { name: 'extension/package.json', text: '{"name":"code-janitor"}' },
      { name: 'extension.vsixmanifest', text: manifest('2.0.0') },
    ]);

    expect(packagedVersions(unversioned)).toEqual({ packageJson: undefined, manifest: '2.0.0', assemblies: noAssemblies });
  });

  it('refuses a file that is not a zip', () => {
    expect(() => packagedVersions(Buffer.from('not a zip'))).toThrow(/not a VSIX/);
  });
});

describe('releaseVersionProblems', () => {
  const consistent = {
    tag: 'v1.4.1',
    packageVersion: '1.4.1',
    packaged: { packageJson: '1.4.1', manifest: '1.4.1', assemblies: assemblies('1.4.1') },
    vsixPath: 'out/edgarus-labs.code-janitor.vscode.v1.4.1.vsix',
  };

  it('accepts a tag, package.json, packaged versions and file name that agree', () => {
    expect(releaseVersionProblems(consistent)).toEqual([]);
  });

  it('accepts a build without a tag when the other versions agree', () => {
    expect(releaseVersionProblems({ ...consistent, tag: undefined })).toEqual([]);
  });

  it.each([
    ['a tag of another version', { tag: 'v1.4.0' }, 'v1.4.0'],
    ['a tag without the v prefix', { tag: '1.4.1' }, "'1.4.1'"],
    ['a stale packaged package.json', { packaged: { ...consistent.packaged, packageJson: '1.0.2' } }, '1.0.2'],
    ['a stale VSIX manifest', { packaged: { ...consistent.packaged, manifest: '1.0.2' } }, '1.0.2'],
    ['a file name of another version', { vsixPath: 'edgarus-labs.code-janitor.vscode.v1.0.2.vsix' }, 'v1.0.2'],
    ['the default vsce file name', { vsixPath: 'code-janitor-1.4.1.vsix' }, 'code-janitor-1.4.1.vsix'],
    ['a missing packaged package.json', { packaged: { ...consistent.packaged, packageJson: undefined } }, 'extension/package.json'],
    [
      'a server assembly with the SDK default version',
      { packaged: { ...consistent.packaged, assemblies: { ...assemblies('1.4.1'), 'CodeJanitor.Server.dll': '1.0.0' } } },
      'CodeJanitor.Server.dll',
    ],
    [
      'an engine assembly without a version',
      { packaged: { ...consistent.packaged, assemblies: { ...assemblies('1.4.1'), 'CodeJanitor.Engine.dll': undefined } } },
      'CodeJanitor.Engine.dll',
    ],
    ['a missing VSIX manifest', { packaged: { ...consistent.packaged, manifest: undefined } }, 'extension.vsixmanifest'],
  ])('reports %s', (_, change, mentioned) => {
    const problems = releaseVersionProblems({ ...consistent, ...change });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(mentioned);
  });
});
