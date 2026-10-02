import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The C# projects of a workspace, as the workspace-wide rename needs them: which files each project
 * compiles, which other projects reference it, and whether code outside the workspace may use its
 * API. Read from the project files with the same syntactic rules as the rest of cleanup (no MSBuild).
 */

export interface WorkspaceProject {
  /** Full path of the `.csproj` file. */
  readonly projectFile: string;
  readonly directory: string;
  /** The `.cs` files under the project folder (not in `bin`/`obj` or a nested project's folder). */
  readonly csharpFiles: readonly string[];
  /** XAML, Razor and JSON files under the project folder: they may name C# symbols as text. */
  readonly textFiles: readonly string[];
  /** Full paths of the projects this one references (`<ProjectReference>`). */
  readonly references: readonly string[];
  /** `<ProjectReference>` paths that cannot be resolved without MSBuild (other properties, wildcards). */
  readonly unresolvedReferences: readonly string[];
  /** A NuGet package is built from the project: code outside the workspace may use its public API. */
  readonly packable: boolean;
  /** The assembly exposes its internals to other assemblies (`InternalsVisibleTo`). */
  readonly internalsVisibleTo: boolean;
  /** Why the project's files are not known exactly, if so. */
  readonly problem?: string;
}

const SKIPPED_FOLDERS: Record<string, true> = { bin: true, obj: true, node_modules: true };
const TEXT_EXTENSIONS: Record<string, true> = { '.xaml': true, '.axaml': true, '.razor': true, '.cshtml': true, '.json': true };
/** Files MSBuild imports into every project below their folder. */
const DIRECTORY_BUILD_FILES = ['Directory.Build.props', 'Directory.Build.targets'];

/** Every `.csproj` under `roots` (skipping `bin`, `obj`, `node_modules` and hidden folders). */
export function discoverProjects(roots: readonly string[]): WorkspaceProject[] {
  const projectFiles = new Set<string>();
  const pending = roots.map((root) => path.resolve(root));
  while (pending.length > 0) {
    const directory = pending.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && SKIPPED_FOLDERS[entry.name.toLowerCase()] !== true) {
          pending.push(full);
        }
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.csproj')) {
        projectFiles.add(full);
      }
    }
  }

  return [...projectFiles].sort().map(readProject);
}

function readProject(projectFile: string): WorkspaceProject {
  const directory = path.dirname(projectFile);
  const problems: string[] = [];
  let text = '';
  try {
    text = fs.readFileSync(projectFile, 'utf8');
  } catch (error) {
    problems.push(`${projectFile} could not be read (${(error as Error).message})`);
  }

  if (fs.readdirSync(directory).filter((name) => name.toLowerCase().endsWith('.csproj')).length > 1) {
    problems.push(`${directory} holds several project files`);
  }

  if (addsOutsideFiles(text)) {
    problems.push(`${path.basename(projectFile)} adds C# files from outside its folder`);
  }

  // Settings and project references of Directory.Build.props/.targets apply to the project too (every ancestor is read: one may import its parent's).
  const buildFiles: { readonly text: string; readonly folder: string }[] = [];
  for (let current = directory; ; current = path.dirname(current)) {
    for (const name of DIRECTORY_BUILD_FILES) {
      const buildFile = path.join(current, name);
      if (!fs.existsSync(buildFile)) {
        continue;
      }

      try {
        const buildText = fs.readFileSync(buildFile, 'utf8');
        buildFiles.push({ text: buildText, folder: current });
        if (addsOutsideFiles(buildText)) {
          problems.push(`${buildFile} adds C# files from outside the project folder`);
        }
      } catch (error) {
        problems.push(`${buildFile} could not be read (${(error as Error).message})`);
      }
    }

    if (path.dirname(current) === current) {
      break;
    }
  }

  const csharpFiles: string[] = [];
  const textFiles: string[] = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      problems.push(`folder ${current} could not be read (${(error as Error).message})`);
      continue;
    }

    // A nested folder with its own project file belongs to that project.
    if (current !== directory && entries.some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.csproj'))) {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && SKIPPED_FOLDERS[entry.name.toLowerCase()] !== true) {
          pending.push(full);
        }
      } else if (entry.isFile()) {
        const extension = path.extname(entry.name).toLowerCase();
        if (extension === '.cs') {
          csharpFiles.push(full);
        } else if (TEXT_EXTENSIONS[extension] === true) {
          textFiles.push(full);
        }
      }
    }
  }

  const references: string[] = [];
  const unresolvedReferences: string[] = [];
  // Relative includes resolve from the project's folder even in an imported file; `$(MSBuildThisFileDirectory)` is the file's own.
  for (const source of [{ text, folder: directory }, ...buildFiles]) {
    for (const match of source.text.matchAll(/<ProjectReference\s[^>]*?\bInclude\s*=\s*(["'])(.*?)\1/gi)) {
      for (const include of match[2].split(';').map((part) => part.trim()).filter((part) => part !== '')) {
        const expanded = include
          .replace(/\$\(MSBuildThisFileDirectory\)/gi, `${source.folder}${path.sep}`)
          .replace(/\$\(MSBuildProjectDirectory\)/gi, `${directory}${path.sep}`)
          .replace(/\\/g, path.sep);
        if (/\$\(|[*?]/.test(expanded)) {
          unresolvedReferences.push(include);
        } else {
          references.push(path.resolve(directory, expanded));
        }
      }
    }
  }

  const settings = [text, ...buildFiles.map((buildFile) => buildFile.text)].join('\n');
  const element = (name: string) => new RegExp(`<${name}>\\s*true\\s*</${name}>`, 'i').test(settings);

  return {
    projectFile,
    directory,
    csharpFiles: csharpFiles.sort(),
    textFiles: textFiles.sort(),
    references,
    unresolvedReferences,
    packable: element('IsPackable') || element('GeneratePackageOnBuild') || /<PackageId>/i.test(settings),
    internalsVisibleTo: /<InternalsVisibleTo\b/i.test(settings),
    problem: problems.length > 0 ? problems.join('; ') : undefined,
  };
}

/** `<Compile Include>` items or a shared project (`.projitems`) bring C# files from elsewhere. */
function addsOutsideFiles(text: string): boolean {
  return /<Compile\s[^>]*\bInclude\s*=/i.test(text) || /\.projitems\b/i.test(text);
}

/** The project whose folder holds `filePath` (the nearest one), if any. */
export function projectOf(projects: readonly WorkspaceProject[], filePath: string): WorkspaceProject | undefined {
  const file = path.resolve(filePath);

  return projects
    .filter((project) => project.csharpFiles.includes(file))
    .sort((a, b) => b.directory.length - a.directory.length)[0];
}

/** `project` and every project that references it, directly or through other projects. */
export function referencingClosure(projects: readonly WorkspaceProject[], project: WorkspaceProject): WorkspaceProject[] {
  const closure = new Set<WorkspaceProject>([project]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const candidate of projects) {
      if (!closure.has(candidate) && candidate.references.some((reference) => [...closure].some((member) => samePath(member.projectFile, reference)))) {
        closure.add(candidate);
        grew = true;
      }
    }
  }

  return [...closure];
}

/** Windows paths are case-insensitive: `..\lib\Lib.csproj` names `Lib/Lib.csproj`. */
function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
