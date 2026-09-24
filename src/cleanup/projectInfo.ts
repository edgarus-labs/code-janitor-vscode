import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The target frameworks of the project a C# file belongs to: the `<TargetFramework>` or
 * `<TargetFrameworks>` of the single `.csproj` in the nearest folder (from the file's folder up)
 * that has one. `undefined` when there is no such project, several project files share the folder,
 * or the frameworks are not written in the project file itself.
 */
export function findTargetFrameworks(filePath: string): string[] | undefined {
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
      return projects.length === 1 ? targetFrameworksOf(path.join(directory, projects[0])) : undefined;
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      return undefined;
    }

    directory = parent;
  }
}

function targetFrameworksOf(projectPath: string): string[] | undefined {
  let text: string;
  try {
    text = fs.readFileSync(projectPath, 'utf8');
  } catch {
    return undefined;
  }

  const match = /<TargetFrameworks?>\s*([^<]*?)\s*<\/TargetFrameworks?>/i.exec(text);
  const frameworks = match?.[1].split(';').map((framework) => framework.trim()).filter(Boolean) ?? [];

  return frameworks.length > 0 && !frameworks.some((framework) => framework.includes('$(')) ? frameworks : undefined;
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
