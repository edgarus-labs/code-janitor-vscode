import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A static reading of the MSBuild properties and items of a project, for what cleanup needs to
 * know about it (target frameworks, C# version, nullable context, analyzer severities). It reads
 * what the .NET SDK imports implicitly - the nearest `Directory.Build.props` before the project
 * file and the nearest `Directory.Build.targets` after it - and the imports it can resolve, and
 * evaluates `<PropertyGroup>`/`<ItemGroup>` entries in order, substituting `$(Property)`
 * references. What MSBuild alone can decide makes a property uncertain instead of guessing: a
 * `Condition` on its definition (or a `<Choose>`), a reference to an unknown or uncertain property
 * or a property function, and an import that cannot be resolved (which may set anything).
 */
export interface MSBuildProject {
  /** The project file. */
  readonly file: string;
  /** The project uses a project SDK (`<Project Sdk="...">`). */
  readonly sdkStyle: boolean;
  /** The value of a property (case-insensitive) from its unconditional definitions; `undefined` when never set. */
  property(name: string): string | undefined;
  /** Whether {@link property} is the value MSBuild evaluates (set or unset); false when a condition or unknown import may change it. */
  isCertain(name: string): boolean;
  /** Full paths of the unconditional `Include`s of an item type, in order; relative ones are relative to the project, wherever they are defined. */
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
  const state = new EvaluationState(projectFile);
  const sdkStyle = /<Project\s[^>]*\bSdk\s*=|<Sdk\s+Name\s*=|<Import\s[^>]*\bSdk\s*=/i.test(projectText);
  const props = nearestAbove(projectDirectory, 'Directory.Build.props');
  const targets = nearestAbove(projectDirectory, 'Directory.Build.targets');
  if (props) {
    state.evaluateFile(props);
  }

  state.evaluate(projectText, projectFile);
  if (targets) {
    state.evaluateFile(targets);
  }

  return {
    file: projectFile,
    sdkStyle,
    property: (name) => state.properties.get(name.toLowerCase()),
    isCertain: (name) => state.isCertain(name.toLowerCase()),
    items: (type) => state.items.get(type.toLowerCase()) ?? [],
    hasPackage: (id) => state.packages.has(id.toLowerCase()),
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
  for (let current = path.resolve(directory); ; ) {
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

/**
 * Top-level elements in document order: property and item groups, imports (alone or in an
 * `<ImportGroup>`), `<Choose>` blocks, and `<Target>` bodies (which run at build time, not at
 * evaluation, so they are skipped). An opening tag never ends in `/>`, so that a self-closing
 * element does not take the following elements as its body.
 */
const ELEMENT =
  /<(PropertyGroup|ItemGroup)(\s[^>]*)?(?<!\/)>([\s\S]*?)<\/\1\s*>|<(PropertyGroup|ItemGroup)(\s[^>]*)?\/>|<Import\s([^>]*?)\/?>|<(?:Choose|Target)\b[^>]*\/>|<Choose\b[\s\S]*?<\/Choose\s*>|<Target\b[\s\S]*?<\/Target\s*>|<ImportGroup(\s[^>]*)?(?<!\/)>([\s\S]*?)<\/ImportGroup\s*>/gi;
const PROPERTY = /<([A-Za-z_][\w.-]*)(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/\1\s*>)/g;
const ITEM = /<([A-Za-z_][\w.-]*)\s([^>]*?)\/?>/g;
const CONDITION = /\bCondition\s*=/i;
const MAX_IMPORT_DEPTH = 8;

class EvaluationState {
  readonly properties: Map<string, string>;
  readonly items = new Map<string, string[]>();
  readonly packages = new Set<string>();
  /** Properties a condition or an unknown value may change. */
  private readonly uncertain = new Set<string>();
  /** After an unresolvable import only properties set later are certain. */
  private unknownImport = false;
  private readonly setAfterUnknownImport = new Set<string>();
  private readonly importing = new Set<string>();
  /** Relative item paths are resolved here, even in imported files (only `<Import>` paths are relative to the importing file). */
  private readonly projectDirectory: string;

  constructor(projectFile: string) {
    this.projectDirectory = path.dirname(projectFile);
    this.properties = new Map([
      ['msbuildprojectdirectory', this.projectDirectory],
      ['msbuildprojectfullpath', projectFile],
      ['msbuildprojectfile', path.basename(projectFile)],
      ['msbuildprojectname', path.basename(projectFile, path.extname(projectFile))],
      ['msbuildprojectextension', path.extname(projectFile)],
    ]);
  }

  isCertain(name: string): boolean {
    return !this.uncertain.has(name) && (!this.unknownImport || this.setAfterUnknownImport.has(name));
  }

  evaluateFile(file: string): void {
    const text = readText(file);
    if (text === undefined) {
      this.markUnknownImport();
    } else {
      this.evaluate(text, file);
    }
  }

  evaluate(text: string, file: string): void {
    const resolved = path.resolve(file);
    if (this.importing.has(resolved) || this.importing.size >= MAX_IMPORT_DEPTH) {
      this.markUnknownImport();
      return;
    }

    this.importing.add(resolved);
    try {
      const directory = path.dirname(file);
      for (const element of text.replace(/<!--[\s\S]*?-->/g, '').matchAll(ELEMENT)) {
        if (/^<Target\b/i.test(element[0])) {
          continue;
        }

        if (element[8] !== undefined) {
          // An <ImportGroup> with a condition may import anything.
          if (CONDITION.test(element[7] ?? '')) {
            this.markUnknownImport();
          } else {
            for (const inner of element[8].matchAll(/<Import\s([^>]*?)\/?>/gi)) {
              this.import(inner[1], file, directory);
            }
          }
        } else if (/^<Choose\b/i.test(element[0])) {
          // Everything a <Choose> sets depends on its <When> conditions.
          for (const property of element[0].matchAll(/<PropertyGroup\b[^>]*>([\s\S]*?)<\/PropertyGroup\s*>/gi)) {
            for (const entry of property[1].matchAll(PROPERTY)) {
              this.uncertain.add(entry[1].toLowerCase());
            }
          }
        } else if (element[6] !== undefined) {
          this.import(element[6], file, directory);
        } else if (element[1] !== undefined) {
          this.group(element[1], element[2] ?? '', element[3], file);
        }
      }
    } finally {
      this.importing.delete(resolved);
    }
  }

  private markUnknownImport(): void {
    this.unknownImport = true;
    this.setAfterUnknownImport.clear();
  }

  private import(attributes: string, file: string, directory: string): void {
    if (/\bSdk\s*=/i.test(attributes)) {
      return;
    }

    const project = /\bProject\s*=\s*"([^"]*)"/i.exec(attributes)?.[1];
    const target = project === undefined ? undefined : this.expand(project, file).value;
    const resolved = target === undefined ? undefined : path.resolve(directory, target.replace(/\\/g, path.sep));
    const condition = /\bCondition\s*=\s*"([^"]*)"/i.exec(attributes)?.[1];
    if (!resolved || /[*?]/.test(resolved)) {
      this.markUnknownImport();
      return;
    }

    if (condition !== undefined) {
      const exists = /^\s*(!)?\s*Exists\s*\(\s*'([^']*)'\s*\)\s*$/i.exec(condition);
      const checked = exists ? this.expand(exists[2], file).value : undefined;
      if (checked === undefined) {
        this.markUnknownImport();
        return;
      }

      if (fs.existsSync(path.resolve(directory, checked.replace(/\\/g, path.sep))) === (exists?.[1] === '!')) {
        return;
      }
    }

    if (!fs.existsSync(resolved)) {
      this.markUnknownImport();
      return;
    }

    this.evaluateFile(resolved);
  }

  private group(kind: string, attributes: string, body: string, file: string): void {
    const conditionalGroup = CONDITION.test(attributes);
    if (kind.toLowerCase() === 'propertygroup') {
      for (const property of body.matchAll(PROPERTY)) {
        const name = property[1].toLowerCase();
        if (conditionalGroup || CONDITION.test(property[2] ?? '')) {
          this.uncertain.add(name);
          continue;
        }

        const { value, certain } = this.expand(decode(property[3] ?? ''), file, name);
        this.properties.set(name, value.trim());
        if (certain) {
          this.uncertain.delete(name);
        } else {
          this.uncertain.add(name);
        }

        this.setAfterUnknownImport.add(name);
      }

      return;
    }

    if (conditionalGroup) {
      return;
    }

    for (const item of body.matchAll(ITEM)) {
      const itemAttributes = item[2];
      const include = /\bInclude\s*=\s*"([^"]*)"/i.exec(itemAttributes)?.[1];
      if (include === undefined || CONDITION.test(itemAttributes)) {
        continue;
      }

      const type = item[1].toLowerCase();
      if (type === 'packagereference') {
        this.packages.add(include.trim().toLowerCase());
        continue;
      }

      const list = this.items.get(type) ?? [];
      for (const part of this.expand(decode(include), file).value.split(';').map((entry) => entry.trim()).filter(Boolean)) {
        list.push(path.resolve(this.projectDirectory, part.replace(/\\/g, path.sep)));
      }

      this.items.set(type, list);
    }
  }

  /**
   * Substitutes `$(Property)` references and the `GetPathOfFileAbove`/`GetDirectoryNameOfFileAbove`
   * property functions; any other function, item or metadata reference, and any reference to an
   * unset or uncertain property, makes the value uncertain. `self`, the property being defined, may
   * be unset (it reads as empty) but not uncertain.
   */
  private expand(value: string, file: string, self?: string): { value: string; certain: boolean } {
    const directory = path.dirname(file);
    let certain = !/[@%]\(/.test(value);
    const reference = (name: string): string => {
      const lower = name.toLowerCase();
      if (lower === 'msbuildthisfiledirectory') {
        return directory + path.sep;
      }

      if (lower === 'msbuildthisfilefullpath') {
        return file;
      }

      if (lower === 'msbuildthisfile') {
        return path.basename(file);
      }

      if (lower === self ? !this.isCertain(lower) : !this.properties.has(lower) || !this.isCertain(lower)) {
        certain = false;
      }

      return this.properties.get(lower) ?? '';
    };
    const functions = value.replace(
      /\$\(\[MSBuild\]::(GetPathOfFileAbove|GetDirectoryNameOfFileAbove)\(\s*'([^']*)'\s*,\s*'([^']*)'\s*\)\)/gi,
      (_, fn: string, first: string, second: string) => {
        const expandInner = (text: string): string => text.replace(/\$\(([\w.-]+)\)/g, (__, name: string) => reference(name));
        const [start, name] = fn.toLowerCase() === 'getpathoffileabove' ? [expandInner(second), expandInner(first)] : [expandInner(first), expandInner(second)];
        const found = nearestAbove(path.resolve(directory, start.replace(/\\/g, path.sep)), name);
        if (!found) {
          certain = false;
          return '';
        }

        return fn.toLowerCase() === 'getpathoffileabove' ? found : path.dirname(found);
      }
    );
    if (/\$\(\[/.test(functions)) {
      certain = false;
    }

    const expanded = functions.replace(/\$\(([\w.-]+)\)/g, (_, name: string) => reference(name));

    return { value: expanded, certain };
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
