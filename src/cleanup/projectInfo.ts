import * as fs from 'node:fs';
import * as path from 'node:path';
import { readMSBuildProject } from './msbuildProperties';

/** What cleanup reads from the project file a C# file belongs to. */
export interface ProjectInfo {
  /** Folder of the project file. */
  readonly directory: string;
  /**
   * `<RootNamespace>` of the project (or the files it imports), else its file name (spaces become
   * `_`, as in the .NET SDK). `undefined` when a condition or an unknown property decides it.
   */
  readonly rootNamespace?: string;
  /** `<TargetFrameworks>`, else `<TargetFramework>`, when evaluated without MSBuild conditions. */
  readonly targetFrameworks?: readonly string[];
  /**
   * The C# language version: `<LangVersion>` (project, `Directory.Build.props`/`.targets`, imports),
   * else the default of its target frameworks (the lowest one). `latest`/`preview` read as 99.
   * `undefined` when a condition or an unknown property decides it.
   */
  readonly languageVersion?: number;
  /** True when every target has the .NET Core 3.0+ runtime types (`Index`, `Range`, `Span<T>`). */
  readonly modernRuntime?: boolean;
  /**
   * The project's nullable context: `<Nullable>` (project, `Directory.Build.props`/`.targets`,
   * imports), `disable` when nothing sets it; `undefined` when a condition, an unknown import or
   * property decides it, or its value is not a nullable context.
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
  const project = readMSBuildProject(path.join(directory, fileName));
  if (!project) {
    return undefined;
  }

  // A property MSBuild alone can decide (a condition, an unknown import or property) stays unknown.
  const certain = (name: string): { value?: string } | undefined => (project.isCertain(name) ? { value: project.property(name) || undefined } : undefined);
  // A non-empty TargetFrameworks wins over TargetFramework, as in the SDK.
  const multiTargeting = certain('TargetFrameworks');
  const frameworksProperty = multiTargeting === undefined || multiTargeting.value !== undefined ? multiTargeting : certain('TargetFramework');
  const frameworks = frameworksProperty?.value
    ?.split(';')
    .map((framework) => framework.trim())
    .filter(Boolean);
  const targetFrameworks = frameworks && frameworks.length > 0 ? frameworks : undefined;
  const rootNamespace = certain('RootNamespace');

  // Old-style projects name a .NET Framework version instead (`v4.7.2`).
  const targets = targetFrameworks ?? (certain('TargetFrameworkVersion')?.value ? ['net4'] : undefined);
  const defaults = targets?.map(defaultLanguageVersion);
  const defaultVersion = defaults && defaults.every((version) => version !== undefined) ? Math.min(...(defaults as number[])) : undefined;
  const declared = certain('LangVersion');
  const languageVersion = declared === undefined ? undefined : declared.value === undefined || /^default$/i.test(declared.value) ? defaultVersion : parseLanguageVersion(declared.value);

  const nullableSetting = certain('Nullable');
  const nullable = nullableSetting === undefined ? undefined : (nullableSetting.value ?? 'disable').toLowerCase();

  return {
    directory,
    // The SDK defaults RootNamespace to the project name with spaces as `_`.
    rootNamespace: rootNamespace === undefined ? undefined : (rootNamespace.value ?? path.basename(fileName, path.extname(fileName)).replace(/ /g, '_')),
    targetFrameworks,
    ...(nullable !== undefined && NULLABLE_CONTEXTS[nullable] === true ? { nullable: nullable as NullableContext } : {}),
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
