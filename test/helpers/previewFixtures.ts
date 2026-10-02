import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Uri, state } from './vscodeMock';

export const FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'preview');

const tempRoots: string[] = [];

export function tempDirectory(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-preview-'));
  tempRoots.push(root);

  return root;
}

export function removeTempDirectories(): void {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function filesUnder(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);

    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

export interface PreviewProject {
  readonly root: string;
  /** Absolute path of a fixture file. */
  file(relative: string): string;
  uri(relative: string): Uri;
  /** The text of every file as the fixture (and the disk) has it. */
  readonly originals: ReadonlyMap<string, string>;
}

/**
 * Copies the fixture project to a temporary folder (so `.editorconfig` resolution is real and
 * isolated) and mirrors it in the vscode mock's file system.
 */
export function previewProject(source: string = FIXTURE_ROOT): PreviewProject {
  const root = tempDirectory();
  fs.cpSync(source, root, { recursive: true });
  const originals = new Map<string, string>();
  for (const file of filesUnder(root)) {
    const text = fs.readFileSync(file, 'utf8');
    originals.set(file, text);
    state.files.set(file, text);
  }

  state.workspaceFolders = [{ uri: Uri.file(root), name: 'w' }];

  return {
    root,
    originals,
    file: (relative) => path.join(root, relative),
    uri: (relative) => Uri.file(path.join(root, relative)),
  };
}

/** The C# files of a project, relative to its root, in a stable order. */
export function csharpFiles(project: PreviewProject): string[] {
  return [...project.originals.keys()]
    .filter((file) => file.endsWith('.cs'))
    .map((file) => path.relative(project.root, file))
    .sort();
}

/** Resets the mock's file system to the original text of the project. */
export function restoreOriginals(project: PreviewProject): void {
  project.originals.forEach((text, file) => state.files.set(file, text));
}
