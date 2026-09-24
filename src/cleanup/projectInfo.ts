import * as fs from 'node:fs';
import * as path from 'node:path';

/** What cleanup reads from the project file a C# file belongs to. */
export interface ProjectInfo {
  /** Folder of the project file. */
  readonly directory: string;
  /**
   * `<RootNamespace>` of the project file, else its file name (spaces become `_`, as in the .NET
   * SDK). `undefined` when a `Directory.Build.props` or MSBuild property decides it instead.
   */
  readonly rootNamespace?: string;
  /** `<TargetFramework>` or `<TargetFrameworks>`, when written in the project file itself. */
  readonly targetFrameworks?: readonly string[];
}

/**
 * The project of a C# file: the single `.csproj` in the nearest folder (from the file's folder up)
 * that has one. `undefined` when there is no such project or several project files share the folder.
 */
export function findProject(filePath: string): ProjectInfo | undefined {
  if (!filePath.trim()) {
    return undefined;
  }

  let directory = path.dirname(path.resolve(filePath));
  for (;;) {
    let projects: string[] = [];
    try {
      projects = fs.readdirSync(directory).filter((name) => name.toLowerCase().endsWith('.csproj'));
    } catch {
      return undefined;
    }

    if (projects.length > 0) {
      return projects.length === 1 ? readProject(directory, projects[0]) : undefined;
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      return undefined;
    }

    directory = parent;
  }
}

function readProject(directory: string, fileName: string): ProjectInfo | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(directory, fileName), 'utf8');
  } catch {
    return undefined;
  }

  const element = (name: string): string | undefined => new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, 'i').exec(text)?.[1];
  const frameworks = (element('TargetFrameworks') ?? element('TargetFramework'))
    ?.split(';')
    .map((framework) => framework.trim())
    .filter(Boolean);
  const declaredRoot = element('RootNamespace');
  const rootNamespace =
    declaredRoot !== undefined
      ? declaredRoot.includes('$(')
        ? undefined
        : declaredRoot
      : rootNamespaceSetOutside(directory)
        ? undefined
        : path.basename(fileName, path.extname(fileName)).replace(/ /g, '_');

  return {
    directory,
    rootNamespace,
    targetFrameworks: frameworks && frameworks.length > 0 && !frameworks.some((framework) => framework.includes('$(')) ? frameworks : undefined,
  };
}

/** True when a `Directory.Build.props` above the project sets `RootNamespace`. */
function rootNamespaceSetOutside(directory: string): boolean {
  for (let current = directory; ; current = path.dirname(current)) {
    try {
      if (/<RootNamespace\b/i.test(fs.readFileSync(path.join(current, 'Directory.Build.props'), 'utf8'))) {
        return true;
      }
    } catch {
      // No Directory.Build.props in this folder.
    }

    if (path.dirname(current) === current) {
      return false;
    }
  }
}

/** True when every framework is .NET `major` or later (`net9.0`, `net10.0-windows`, ...). */
export function targetsAtLeast(frameworks: readonly string[] | undefined, major: number): boolean {
  return (
    frameworks !== undefined &&
    frameworks.length > 0 &&
    frameworks.every((framework) => {
      const version = /^net(\d+)\.\d+/.exec(framework.toLowerCase());

      return version !== null && Number(version[1]) >= major;
    })
  );
}
