import * as fs from 'node:fs';
import * as path from 'node:path';
import { findAll, parseCSharp } from '../parser';
import { ProjectInfo } from '../projectInfo';
import { lex } from '../syntax/lexer';
import { collectDisqualifiedTypeNames } from './sealedClass';

/**
 * What the code-quality rules need to know about the other C# files of a project: the rules that
 * change a declaration other files may depend on (CA1852 sealing, CA1822 making a member static)
 * only do so when every file of the project was read and none of them needs the old declaration.
 */

/** Cross-file facts of one C# source. */
export interface SourceFacts {
  /** Simple names of types used as a base type or generic constraint. */
  readonly derivedOrConstrainedNames: ReadonlySet<string>;
  /** Names accessed on a receiver (`x.Name`, `x?.Name`, `x->Name`). */
  readonly memberAccessNames: ReadonlySet<string>;
  /** Simple names of the declared types. */
  readonly typeNames: ReadonlySet<string>;
  /** Simple names of the declared interfaces. */
  readonly interfaceNames: ReadonlySet<string>;
  /** Names of the members the declared interfaces declare. */
  readonly interfaceMemberNames: ReadonlySet<string>;
  /** Namespaces imported with `global using`. */
  readonly globalUsings: ReadonlySet<string>;
  /** The source applies `[assembly: InternalsVisibleTo(...)]`. */
  readonly internalsVisibleTo: boolean;
}

export interface ProjectFacts {
  /** Why the project's sources are not all known, if so: rules needing all of them report instead of fixing. */
  readonly incomplete?: string;
  /** The facts of every other C# file of the project, merged. */
  readonly others: SourceFacts;
  /** The assembly exposes its internals (`InternalsVisibleTo` attribute or MSBuild item). */
  readonly internalsVisibleTo: boolean;
  /** `System` is imported by every file (`ImplicitUsings`, `global using System;` or a `Using` item). */
  readonly importsSystem: boolean;
  /** The project uses the ASP.NET Core web SDK. */
  readonly webProject: boolean;
}

/** Folders never holding the project's own sources. */
const SKIPPED_FOLDERS: Record<string, true> = { bin: true, obj: true, node_modules: true };

/** More files than this and the project is not scanned (the rules report instead). */
const MAX_PROJECT_FILES = 20000;

export function computeSourceFacts(source: string): SourceFacts {
  const memberAccessNames = new Set<string>();
  const globalUsings = new Set<string>();
  let internalsVisibleTo = false;
  const tokens = lex(source).tokens;
  const text = (index: number): string => source.slice(tokens[index].start, tokens[index].end);
  for (let i = 0; i < tokens.length - 1; i++) {
    const type = tokens[i].type;
    if ((type === '.' || type === '?.' || type === '->') && tokens[i + 1].type === 'identifier') {
      memberAccessNames.add(text(i + 1).replace(/^@/, ''));
    } else if (type === 'identifier' && /^InternalsVisibleTo(?:Attribute)?$/.test(text(i))) {
      internalsVisibleTo = true;
    } else if (type === 'identifier' && text(i) === 'global' && tokens[i + 1].type === 'using') {
      let end = i + 2;
      while (end < tokens.length && tokens[end].type !== ';') {
        end++;
      }

      const imported = source.slice(tokens[i + 2]?.start ?? 0, tokens[end]?.start ?? 0).replace(/\s+/g, '');
      if (/^[\w.]+$/.test(imported)) {
        globalUsings.add(imported);
      }
    }
  }

  const tree = parseCSharp(source);
  try {
    const declarations = findAll(tree.rootNode, [
      'class_declaration',
      'struct_declaration',
      'record_declaration',
      'interface_declaration',
      'enum_declaration',
      'delegate_declaration',
    ]);
    const nameOf = (declaration: (typeof declarations)[number]): string => declaration.childForFieldName('name')?.text ?? '';
    const interfaces = declarations.filter((declaration) => declaration.type === 'interface_declaration');
    const interfaceMembers = interfaces.flatMap((declaration) => declaration.childForFieldName('body')?.namedChildren ?? []);

    return {
      derivedOrConstrainedNames: collectDisqualifiedTypeNames(tree.rootNode),
      memberAccessNames,
      typeNames: new Set(declarations.map(nameOf)),
      interfaceNames: new Set(interfaces.map(nameOf)),
      interfaceMemberNames: new Set(interfaceMembers.map((member) => member.childForFieldName('name')?.text.replace(/^@/, '') ?? '').filter(Boolean)),
      globalUsings,
      internalsVisibleTo,
    };
  } finally {
    tree.delete();
  }
}

interface CachedFacts {
  readonly mtimeMs: number;
  readonly size: number;
  readonly facts: SourceFacts;
}

const factsByFile = new Map<string, CachedFacts>();
const factsByProject = new WeakMap<ProjectInfo, Map<string, ProjectFacts>>();

const frameworksByProject = new WeakMap<ProjectInfo, readonly string[] | undefined>();

/**
 * The project's target frameworks: `<TargetFramework(s)>` (see `projectInfo.ts`), else an old-style
 * project's `<TargetFrameworkVersion>` (`v4.7.2` -> `net472`). `undefined` when unknown, which
 * the rules depending on it report.
 */
export function targetFrameworksOf(project: ProjectInfo | undefined): readonly string[] | undefined {
  if (!project || project.targetFrameworks) {
    return project?.targetFrameworks;
  }

  if (!frameworksByProject.has(project)) {
    let frameworks: string[] | undefined;
    try {
      const projectFiles = fs.readdirSync(project.directory).filter((name) => name.toLowerCase().endsWith('.csproj'));
      const text = projectFiles.length === 1 ? fs.readFileSync(path.join(project.directory, projectFiles[0]), 'utf8') : '';
      const version = /<TargetFrameworkVersion>\s*v(\d+)\.(\d+)(?:\.(\d+))?\s*</i.exec(text);
      frameworks = version ? [`net${version[1]}${version[2]}${version[3] ?? ''}`] : undefined;
    } catch {
      // An unreadable project leaves the frameworks unknown; the rules report that.
      frameworks = undefined;
    }

    frameworksByProject.set(project, frameworks);
  }

  return frameworksByProject.get(project);
}

/**
 * The facts of every C# file of `project` except `currentFile` (whose current text the rules read
 * themselves). Files are the `.cs` files under the project folder, outside `bin`, `obj`, hidden
 * folders and folders of other projects, as the .NET SDK's default compile items, plus explicit
 * `<Compile Include>` items. Computed once per project object (one cleanup) and file version.
 */
export function loadProjectFacts(project: ProjectInfo, currentFile: string | undefined): ProjectFacts {
  const key = currentFile ? path.resolve(currentFile) : '';
  let byFile = factsByProject.get(project);
  if (!byFile) {
    byFile = new Map();
    factsByProject.set(project, byFile);
  }

  let facts = byFile.get(key);
  if (!facts) {
    facts = readProjectFacts(project.directory, key);
    byFile.set(key, facts);
  }

  return facts;
}

function readProjectFacts(directory: string, currentFile: string): ProjectFacts {
  const problems: string[] = [];
  const settings = readProjectSettings(directory, problems);
  const files = new Set([...(settings.defaultCompileItems ? listProjectSources(directory, problems) : []), ...settings.compileIncludes]);
  const merged = {
    derivedOrConstrainedNames: new Set<string>(),
    memberAccessNames: new Set<string>(),
    typeNames: new Set<string>(),
    interfaceNames: new Set<string>(),
    interfaceMemberNames: new Set<string>(),
    globalUsings: new Set<string>(),
    internalsVisibleTo: false,
  };

  for (const file of files) {
    if (file === currentFile) {
      continue;
    }

    const facts = readSourceFacts(file, problems);
    if (!facts) {
      continue;
    }

    for (const name of facts.derivedOrConstrainedNames) merged.derivedOrConstrainedNames.add(name);
    for (const name of facts.memberAccessNames) merged.memberAccessNames.add(name);
    for (const name of facts.typeNames) merged.typeNames.add(name);
    for (const name of facts.interfaceNames) merged.interfaceNames.add(name);
    for (const name of facts.interfaceMemberNames) merged.interfaceMemberNames.add(name);
    for (const name of facts.globalUsings) merged.globalUsings.add(name);
    merged.internalsVisibleTo ||= facts.internalsVisibleTo;
  }

  return {
    incomplete: problems.length > 0 ? problems.join('; ') : undefined,
    others: merged,
    internalsVisibleTo: settings.internalsVisibleTo || merged.internalsVisibleTo,
    importsSystem: settings.importsSystem || merged.globalUsings.has('System'),
    webProject: settings.webProject,
  };
}

function readSourceFacts(file: string, problems: string[]): SourceFacts | undefined {
  let stat: fs.Stats;
  let text: string;
  try {
    stat = fs.statSync(file);
    const cached = factsByFile.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.facts;
    }

    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    problems.push(`${file} could not be read (${(error as Error).message})`);
    return undefined;
  }

  const facts = computeSourceFacts(text.startsWith('\uFEFF') ? text.slice(1) : text);
  factsByFile.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, facts });

  return facts;
}

function listProjectSources(root: string, problems: string[]): string[] {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      problems.push(`folder ${directory} could not be read (${(error as Error).message})`);
      continue;
    }

    // A nested folder with its own project file belongs to that project.
    if (directory !== root && entries.some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.csproj'))) {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && SKIPPED_FOLDERS[entry.name.toLowerCase()] !== true) {
          pending.push(full);
        }
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.cs')) {
        files.push(path.resolve(full));
      }
    }

    if (files.length > MAX_PROJECT_FILES) {
      problems.push(`the project has more than ${MAX_PROJECT_FILES} C# files`);
      break;
    }
  }

  return files;
}

interface ProjectSettings {
  /** The .NET SDK adds the `.cs` files under the project folder (SDK-style project, default items on). */
  readonly defaultCompileItems: boolean;
  /** Full paths of the `<Compile Include>` items. */
  readonly compileIncludes: readonly string[];
  readonly internalsVisibleTo: boolean;
  readonly importsSystem: boolean;
  readonly webProject: boolean;
}

/** Reads the project file and the `Directory.Build.props`/`.targets` files above it. */
function readProjectSettings(directory: string, problems: string[]): ProjectSettings {
  let projectText = '';
  try {
    const projectFiles = fs.readdirSync(directory).filter((name) => name.toLowerCase().endsWith('.csproj'));
    if (projectFiles.length !== 1) {
      problems.push(`${directory} does not contain exactly one project file`);
    } else {
      projectText = fs.readFileSync(path.join(directory, projectFiles[0]), 'utf8');
    }
  } catch (error) {
    problems.push(`the project file in ${directory} could not be read (${(error as Error).message})`);
  }

  const buildFiles: string[] = [];
  for (let current = directory; ; ) {
    for (const name of ['Directory.Build.props', 'Directory.Build.targets']) {
      const file = path.join(current, name);
      try {
        buildFiles.push(fs.readFileSync(file, 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          problems.push(`${file} could not be read (${(error as Error).message})`);
        }
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }

    current = parent;
  }

  const msbuild = [projectText, ...buildFiles];
  if (buildFiles.some((text) => /<Compile\s[^>]*\bInclude\s*=/i.test(text))) {
    problems.push('a Directory.Build file adds C# files with <Compile Include>');
  }

  // `<Compile Include="..\Shared\File.cs" />`: explicit files (old-style projects list all of them).
  const compileIncludes: string[] = [];
  for (const match of projectText.matchAll(/<Compile\s[^>]*?\bInclude\s*=\s*"([^"]*)"/gi)) {
    const include = match[1].replace(/&amp;/g, '&');
    if (/[*?$%;]/.test(include)) {
      problems.push(`the project adds C# files with the pattern "${include}"`);
    } else if (include.toLowerCase().endsWith('.cs')) {
      compileIncludes.push(path.resolve(directory, include.replace(/\\/g, path.sep)));
    }
  }

  if (msbuild.some((text) => /\.projitems\b/i.test(text))) {
    problems.push('the project imports a shared project');
  }

  const sdkStyle = /<Project\s[^>]*\bSdk\s*=|<Sdk\s+Name\s*=|<Import\s[^>]*\bSdk\s*=/i.test(projectText);
  const defaultItemsOff = msbuild.some((text) => /<EnableDefault(?:Compile)?Items>\s*false\s*</i.test(text));

  const implicitUsings = /<ImplicitUsings>\s*(?:enable|true)\s*</i.test(projectText) ||
    (!/<ImplicitUsings>/i.test(projectText) && buildFiles.some((text) => /<ImplicitUsings>\s*(?:enable|true)\s*</i.test(text)));

  return {
    defaultCompileItems: sdkStyle && !defaultItemsOff,
    compileIncludes,
    internalsVisibleTo: msbuild.some((text) => /<InternalsVisibleTo\b/i.test(text)),
    importsSystem: implicitUsings || msbuild.some((text) => /<Using\s+Include\s*=\s*"System"/i.test(text)),
    webProject: /Sdk\s*=\s*"Microsoft\.NET\.Sdk\.Web"/i.test(projectText) || /<Sdk\s+Name\s*=\s*"Microsoft\.NET\.Sdk\.Web"/i.test(projectText),
  };
}
