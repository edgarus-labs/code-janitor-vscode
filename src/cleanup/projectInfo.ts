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
  /**
   * The C# language version: `<LangVersion>` of the project or a `Directory.Build.props` above it,
   * else the default of its target frameworks (the lowest one). `latest`/`preview` read as 99.
   */
  readonly languageVersion?: number;
  /** True when every target has the .NET Core 3.0+ runtime types (`Index`, `Range`, `Span<T>`). */
  readonly modernRuntime?: boolean;
  /**
   * The project's nullable context: `<Nullable>` of the project or a `Directory.Build.props` above
   * it, `disable` when neither sets it; `undefined` when set to something else (an MSBuild property).
   */
  readonly nullable?: NullableContext;
}

export type NullableContext = 'enable' | 'disable' | 'annotations' | 'warnings';

const NULLABLE_CONTEXTS: Record<string, true> = { enable: true, disable: true, annotations: true, warnings: true };

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

  const targetFrameworks = frameworks && frameworks.length > 0 && !frameworks.some((framework) => framework.includes('$(')) ? frameworks : undefined;
  // Old-style projects name a .NET Framework version instead (`v4.7.2`).
  const targets = targetFrameworks ?? (element('TargetFrameworkVersion') ? ['net4'] : undefined);
  const defaults = targets?.map(defaultLanguageVersion);
  const defaultVersion = defaults && defaults.every((version) => version !== undefined) ? Math.min(...(defaults as number[])) : undefined;
  const declared = element('LangVersion') ?? propertySetOutside(directory, 'LangVersion');
  const languageVersion = declared === undefined || /^default$/i.test(declared) ? defaultVersion : parseLanguageVersion(declared);

  const nullable = (element('Nullable') ?? propertySetOutside(directory, 'Nullable'))?.toLowerCase();

  return {
    directory,
    rootNamespace,
    targetFrameworks,
    ...(nullable === undefined || NULLABLE_CONTEXTS[nullable] === true ? { nullable: (nullable ?? 'disable') as NullableContext } : {}),
    ...(languageVersion !== undefined ? { languageVersion } : {}),
    ...(targets ? { modernRuntime: targets.every(hasModernRuntime) } : {}),
  };
}

/** The C# version a `<LangVersion>` value selects; `latest`, `latestMajor` and `preview` read as 99. */
function parseLanguageVersion(value: string): number | undefined {
  if (/^(?:latest|latestmajor|preview)$/i.test(value)) {
    return 99;
  }

  const version = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());

  return version ? Number(version[1]) + (version[2] ? Number(`0.${version[2]}`) : 0) : undefined;
}

/**
 * The default C# version of a target framework
 * (https://learn.microsoft.com/dotnet/csharp/language-reference/configure-language-version#c-language-version-reference).
 */
function defaultLanguageVersion(framework: string): number | undefined {
  const name = framework.toLowerCase();
  const modern = /^net(\d+)\.\d+/.exec(name);
  if (modern) {
    return Math.min(Number(modern[1]) + 4, 14);
  }

  if (/^netcoreapp3\./.test(name) || name === 'netstandard2.1') {
    return 8;
  }

  return /^(?:netcoreapp[12]\.|netstandard1\.|netstandard2\.0|net[1-4])/.test(name) ? 7.3 : undefined;
}

function hasModernRuntime(framework: string): boolean {
  return /^(?:net(?:[5-9]|\d{2,})\.\d+|netcoreapp3\.|netstandard2\.1)/.test(framework.toLowerCase());
}

/** `<LangVersion>` of a `Directory.Build.props` above the project, when one sets it. */
function propertySetOutside(directory: string, name: string): string | undefined {
  for (let current = directory; ; current = path.dirname(current)) {
    try {
      const value = new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, 'i').exec(fs.readFileSync(path.join(current, 'Directory.Build.props'), 'utf8'))?.[1];
      if (value !== undefined) {
        return value;
      }
    } catch {
      // No Directory.Build.props in this folder.
    }

    if (path.dirname(current) === current) {
      return undefined;
    }
  }
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
