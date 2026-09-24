import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A small, static reading of the MSBuild properties and items of a project, for the settings that
 * decide analyzer severities. It imports what the .NET SDK imports implicitly - the nearest
 * `Directory.Build.props` before the project file and the nearest `Directory.Build.targets` after
 * it - and evaluates unconditional `<PropertyGroup>`/`<ItemGroup>` entries in order, substituting
 * `$(Property)` references. Anything with a `Condition` is ignored: it cannot be decided without
 * MSBuild. No other imports are followed.
 */
export interface MSBuildProject {
  /** The project file. */
  readonly file: string;
  /** The project uses a project SDK (`<Project Sdk="...">`). */
  readonly sdkStyle: boolean;
  /** The evaluated value of a property (case-insensitive); `undefined` when never set. */
  property(name: string): string | undefined;
  /** Full paths of the `Include`s of an item type, in order. */
  items(type: string): readonly string[];
  /** Whether a `<PackageReference Include="...">` of this package id (case-insensitive) exists. */
  hasPackage(id: string): boolean;
}

/** The single `.csproj` in the nearest folder (from `filePath`'s folder up) that has project files. */
export function findProjectFile(filePath: string): string | undefined {
  let directory = path.dirname(path.resolve(filePath));
  for (;;) {
    let projects: string[];
    try {
      projects = fs.readdirSync(directory).filter((name) => name.toLowerCase().endsWith('.csproj'));
    } catch {
      return undefined;
    }

    if (projects.length > 0) {
      return projects.length === 1 ? path.join(directory, projects[0]) : undefined;
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      return undefined;
    }

    directory = parent;
  }
}

export function readMSBuildProject(projectFile: string): MSBuildProject | undefined {
  const projectText = readText(projectFile);
  if (projectText === undefined) {
    return undefined;
  }

  const projectDirectory = path.dirname(projectFile);
  const properties = new Map<string, string>([
    ['msbuildprojectdirectory', projectDirectory],
    ['msbuildprojectfullpath', projectFile],
    ['msbuildprojectname', path.basename(projectFile, path.extname(projectFile))],
  ]);
  const items = new Map<string, string[]>();
  const packages = new Set<string>();

  const sdkStyle = /<Project\s[^>]*\bSdk\s*=|<Sdk\s+Name\s*=|<Import\s[^>]*\bSdk\s*=/i.test(projectText);
  const files = [nearestAbove(projectDirectory, 'Directory.Build.props'), projectFile, nearestAbove(projectDirectory, 'Directory.Build.targets')];
  for (const file of files) {
    const text = file === projectFile ? projectText : file && readText(file);
    if (file && text !== undefined) {
      evaluate(text, file, properties, items, packages);
    }
  }

  return {
    file: projectFile,
    sdkStyle,
    property: (name) => properties.get(name.toLowerCase()),
    items: (type) => items.get(type.toLowerCase()) ?? [],
    hasPackage: (id) => packages.has(id.toLowerCase()),
  };
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** The nearest file of that name in `directory` or a folder above it. */
function nearestAbove(directory: string, name: string): string | undefined {
  for (let current = directory; ; ) {
    const candidate = path.join(current, name);
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }

    current = parent;
  }
}

const GROUP = /<(PropertyGroup|ItemGroup)(\s[^>]*)?>([\s\S]*?)<\/\1\s*>/gi;
const PROPERTY = /<([A-Za-z_][\w.-]*)(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/\1\s*>)/g;
const ITEM = /<([A-Za-z_][\w.-]*)\s([^>]*?)\/?>/g;

function evaluate(text: string, file: string, properties: Map<string, string>, items: Map<string, string[]>, packages: Set<string>): void {
  const directory = path.dirname(file);
  const expand = (value: string): string =>
    value.replace(/\$\(([\w.-]+)\)/g, (_, name: string) => {
      const lower = name.toLowerCase();
      if (lower === 'msbuildthisfiledirectory') {
        return directory + path.sep;
      }

      return lower === 'msbuildthisfilefullpath' ? file : (properties.get(lower) ?? '');
    });

  const withoutComments = text.replace(/<!--[\s\S]*?-->/g, '');
  for (const group of withoutComments.matchAll(GROUP)) {
    if (/\bCondition\s*=/i.test(group[2] ?? '')) {
      continue;
    }

    if (group[1].toLowerCase() === 'propertygroup') {
      for (const property of group[3].matchAll(PROPERTY)) {
        if (!/\bCondition\s*=/i.test(property[2] ?? '')) {
          properties.set(property[1].toLowerCase(), expand(decode(property[3] ?? '')).trim());
        }
      }

      continue;
    }

    for (const item of group[3].matchAll(ITEM)) {
      const attributes = item[2];
      const include = /\bInclude\s*=\s*"([^"]*)"/i.exec(attributes)?.[1];
      if (include === undefined || /\bCondition\s*=/i.test(attributes)) {
        continue;
      }

      const type = item[1].toLowerCase();
      if (type === 'packagereference') {
        packages.add(include.trim().toLowerCase());
        continue;
      }

      const list = items.get(type) ?? [];
      for (const part of expand(decode(include)).split(';').map((entry) => entry.trim()).filter(Boolean)) {
        list.push(path.resolve(directory, part.replace(/\\/g, path.sep)));
      }

      items.set(type, list);
    }
  }
}

function decode(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
