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
  /** A NuGet package is built from the project: code outside the workspace may use its public API. */
  readonly packable: boolean;
  /** The assembly exposes its internals to other assemblies (`InternalsVisibleTo`). */
  readonly internalsVisibleTo: boolean;
  /** Why the project's files are not known exactly, if so. */
  readonly problem?: string;
}

const SKIPPED_FOLDERS: Record<string, true> = { bin: true, obj: true, node_modules: true };
const TEXT_EXTENSIONS: Record<string, true> = { '.xaml': true, '.axaml': true, '.razor': true, '.cshtml': true, '.json': true };

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

  if (/<Compile\s[^>]*\bInclude\s*=/i.test(text) || /\.projitems\b/i.test(text)) {
    problems.push(`${path.basename(projectFile)} adds C# files from outside its folder`);
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

  const references = [...text.matchAll(/<ProjectReference\s[^>]*\bInclude\s*=\s*"([^"]+)"/gi)].map((match) =>
    path.resolve(directory, match[1].replace(/\\/g, path.sep))
  );
  const element = (name: string) => new RegExp(`<${name}>\\s*true\\s*</${name}>`, 'i').test(text);

  return {
    projectFile,
    directory,
    csharpFiles: csharpFiles.sort(),
    textFiles: textFiles.sort(),
    references,
    packable: element('IsPackable') || element('GeneratePackageOnBuild') || /<PackageId>/i.test(text),
    internalsVisibleTo: /<InternalsVisibleTo\b/i.test(text),
    problem: problems.length > 0 ? problems.join('; ') : undefined,
  };
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
      if (!closure.has(candidate) && candidate.references.some((reference) => [...closure].some((member) => member.projectFile === reference))) {
        closure.add(candidate);
        grew = true;
      }
    }
  }

  return [...closure];
}
