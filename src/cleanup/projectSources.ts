import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The files the .NET SDK adds to a project by default: the `.cs` and markup files under the project
 * folder, following symbolic links as MSBuild globbing does, without `bin` and `obj` directly in the
 * project folder (the default `BaseOutputPath` and `BaseIntermediateOutputPath`), hidden folders,
 * `node_modules` in web projects (the Web and Razor SDKs exclude it) and folders of nested projects.
 */

/** Folders directly in the project folder never holding the project's own sources. */
const OUTPUT_FOLDERS: Record<string, true> = { bin: true, obj: true };

/** More files than this and the listing stops (reported in `problems`). */
const MAX_PROJECT_FILES = 20000;

/** Markup the SDK compiles into classes of the assembly (Razor components and pages, XAML, Avalonia XAML). */
const MARKUP_SOURCE = /\.(?:razor|cshtml|xaml|axaml)$/i;

/** Modification times this close to the listing may not change again for an entry added right after (coarse file system clocks). */
const RECENT_CHANGE_MS = 2000;

export interface ProjectSourceListing {
  /** Every folder read, with its modification time: adding, removing or renaming an entry changes it. */
  readonly folders: ReadonlyMap<string, number>;
  /** Full paths of the `.cs` files. */
  readonly files: readonly string[];
  /** Full paths of the markup files (see `MARKUP_SOURCE`). */
  readonly markup: readonly string[];
  /** Folders that could not be read, or the file limit that stopped the listing. */
  readonly problems: readonly string[];
  /** No folder failed to read or changed too recently for its modification time to tell a later change. */
  readonly reusable: boolean;
}

const listingByRoot = new Map<string, ProjectSourceListing>();

/**
 * The `.cs` and markup files under `root` the SDK compiles by default; listed again only when one of
 * the folders read changed. `excludeNodeModules`: the project uses the Web or Razor SDK.
 */
export function listProjectSources(root: string, excludeNodeModules = false): ProjectSourceListing {
  const key = `${excludeNodeModules ? 'web' : 'sdk'}:${root}`;
  let listing = listingByRoot.get(key);
  if (!listing?.reusable || [...listing.folders].some(([folder, mtimeMs]) => fs.statSync(folder, { throwIfNoEntry: false })?.mtimeMs !== mtimeMs)) {
    listing = walkProjectSources(root, excludeNodeModules);
    listingByRoot.set(key, listing);
  }

  return listing;
}

function walkProjectSources(root: string, excludeNodeModules: boolean): ProjectSourceListing {
  const folders = new Map<string, number>();
  const files: string[] = [];
  const markup: string[] = [];
  const problems: string[] = [];
  const now = Date.now();
  let reusable = true;
  // Real paths of the folders walked: a symbolic link back to one of them would loop.
  const visited = new Set<string>();
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop() as string;
    let entries: fs.Dirent[];
    try {
      const real = fs.realpathSync(directory);
      if (visited.has(real)) {
        continue;
      }

      visited.add(real);
      const mtimeMs = fs.statSync(directory).mtimeMs;
      folders.set(directory, mtimeMs);
      reusable &&= now - mtimeMs > RECENT_CHANGE_MS;
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      problems.push(`folder ${directory} could not be read (${(error as Error).message})`);
      reusable = false;
      continue;
    }

    // A nested folder with its own project file belongs to that project.
    if (directory !== root && entries.some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.csproj'))) {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      let kind: 'directory' | 'file' | undefined = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : undefined;
      if (entry.isSymbolicLink()) {
        const target = fs.statSync(full, { throwIfNoEntry: false });
        kind = target?.isDirectory() ? 'directory' : target?.isFile() ? 'file' : undefined;
      }

      const name = entry.name.toLowerCase();
      if (kind === 'directory') {
        const excluded = (directory === root && OUTPUT_FOLDERS[name] === true) || (excludeNodeModules && name === 'node_modules');
        if (!entry.name.startsWith('.') && !excluded) {
          pending.push(full);
        }
      } else if (kind === 'file' && name.endsWith('.cs')) {
        files.push(path.resolve(full));
      } else if (kind === 'file' && MARKUP_SOURCE.test(entry.name)) {
        markup.push(path.resolve(full));
      }
    }

    if (files.length > MAX_PROJECT_FILES) {
      problems.push(`the project has more than ${MAX_PROJECT_FILES} C# files`);
      break;
    }
  }

  return { folders, files, markup, problems, reusable };
}
