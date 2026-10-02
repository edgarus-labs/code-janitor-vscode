import * as fs from 'node:fs';
import * as path from 'node:path';
import { findAll, parseCSharp } from '../parser';
import { ProjectInfo } from '../projectInfo';
import { Token, lex } from '../syntax/lexer';
import { interpolationHoles } from './interpolation';
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
  /**
   * Names used on an instance from outside its type: accessed on a receiver (`x.Name`, `x?.Name`,
   * `x->Name`, also inside interpolation holes) or read by a property pattern (`{ Name: 1 }`,
   * `{ Name.Inner: 1 }`).
   */
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
  /**
   * A Razor or XAML file the project compiles into the assembly, if any. The facts do not read
   * markup, which may use any internal member or derive from any internal type; it declares no type
   * whose name could clash (a Razor component's name, its file name, is in `others.typeNames`).
   */
  readonly markup?: string;
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
    if (type === 'identifier' && /^InternalsVisibleTo(?:Attribute)?$/.test(text(i))) {
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

  collectMemberUses(source, tokens, memberAccessNames);

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

/** Tokens or contextual keywords after which `Name :` declares a base list or a constraint, not a pattern. */
const DECLARING_KEYWORDS: Record<string, true> = { class: true, struct: true, interface: true, enum: true, record: true, where: true };

/**
 * Adds the names `source` uses on an instance (see `SourceFacts.memberAccessNames`). A name read by
 * a property pattern is any `Name:` or `Name.Inner:` after `{` or `,`, which also matches named
 * arguments: an extra name only makes a rule report.
 */
function collectMemberUses(source: string, tokens: readonly Token[], names: Set<string>): void {
  const text = (index: number): string => source.slice(tokens[index].start, tokens[index].end);
  for (let i = 0; i < tokens.length; i++) {
    const type = tokens[i].type;
    if (type === 'interpolated_string_expression') {
      for (const hole of interpolationHoles(text(i))) {
        collectMemberUses(hole, lex(hole).tokens, names);
      }
    } else if (type === 'identifier') {
      const previous = i > 0 ? tokens[i - 1].type : '';
      const accessed = previous === '.' || previous === '?.' || previous === '->';
      const labeled = tokens[i + 1]?.type === ':' && (i === 0 || DECLARING_KEYWORDS[text(i - 1)] !== true);
      if (accessed || labeled || ((previous === '{' || previous === ',') && startsPropertySubpattern(tokens, i))) {
        names.add(text(i).replace(/^@/, ''));
      }
    }
  }
}

/** True when the identifier at `index` starts `Name:` or `Name.Inner...:` (a property subpattern). */
function startsPropertySubpattern(tokens: readonly Token[], index: number): boolean {
  let end = index + 1;
  while (tokens[end]?.type === '.' && tokens[end + 1]?.type === 'identifier') {
    end += 2;
  }

  return tokens[end]?.type === ':';
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
 * `<Compile Include>` items. Computed once per project object (one cleanup); across cleanups only
 * the files and folders whose modification time changed are read again.
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

type NameKind = 'derivedOrConstrainedNames' | 'memberAccessNames' | 'typeNames' | 'interfaceNames' | 'interfaceMemberNames' | 'globalUsings';

const NAME_KINDS: readonly NameKind[] = ['derivedOrConstrainedNames', 'memberAccessNames', 'typeNames', 'interfaceNames', 'interfaceMemberNames', 'globalUsings'];

/**
 * The facts of every file of a project folder, merged as how many files hold each name. Kept per
 * folder and updated for the files that changed, so cleaning many files of a project does not merge
 * all of them again for each file.
 */
interface ProjectIndex {
  readonly facts: Map<string, SourceFacts>;
  readonly counts: Readonly<Record<NameKind, Map<string, number>>>;
  internalsVisibleToFiles: number;
}

const indexByDirectory = new Map<string, ProjectIndex>();

function readProjectFacts(directory: string, currentFile: string): ProjectFacts {
  const problems: string[] = [];
  const settings = readProjectSettings(directory, problems);
  const listing = settings.defaultCompileItems ? listProjectSources(directory, problems) : undefined;
  const files = new Set([...(listing?.files ?? []), ...settings.compileIncludes]);
  const components = new Set(listing?.markup.filter((file) => RAZOR_COMPONENT.test(file)));
  let index = indexByDirectory.get(directory);
  if (!index) {
    index = { facts: new Map(), counts: Object.fromEntries(NAME_KINDS.map((kind) => [kind, new Map()])) as ProjectIndex['counts'], internalsVisibleToFiles: 0 };
    indexByDirectory.set(directory, index);
  }

  for (const file of files) {
    // The current file is counted from disk like the others and left out below; the rules read its
    // current text themselves, so it not being on disk (yet) is no problem.
    updateIndex(index, file, readSourceFacts(file, file === currentFile ? [] : problems));
  }

  for (const file of components) {
    updateIndex(index, file, componentFacts(file));
  }

  for (const file of [...index.facts.keys()].filter((known) => !files.has(known) && !components.has(known))) {
    updateIndex(index, file, undefined);
  }

  const own = index.facts.get(currentFile);
  const others = Object.fromEntries(
    NAME_KINDS.map((kind): [NameKind, ReadonlySet<string>] => [kind, new OtherFilesNames(index.counts[kind], own?.[kind])])
  ) as Record<NameKind, ReadonlySet<string>>;
  const internalsVisibleTo = index.internalsVisibleToFiles - (own?.internalsVisibleTo ? 1 : 0) > 0;

  return {
    incomplete: problems.length > 0 ? problems.join('; ') : undefined,
    markup: listing?.markup[0] ?? settings.markupItem,
    others: { ...others, internalsVisibleTo },
    internalsVisibleTo: settings.internalsVisibleTo || internalsVisibleTo,
    importsSystem: settings.importsSystem || others.globalUsings.has('System'),
    webProject: settings.webProject,
  };
}

/** Counts `facts` for `file` in place of what was counted for it before (`undefined`: the file is gone). */
function updateIndex(index: ProjectIndex, file: string, facts: SourceFacts | undefined): void {
  const old = index.facts.get(file);
  if (old === facts) {
    return;
  }

  for (const [counted, step] of [[old, -1], [facts, 1]] as const) {
    if (!counted) {
      continue;
    }

    for (const kind of NAME_KINDS) {
      const counts = index.counts[kind];
      for (const name of counted[kind]) {
        const count = (counts.get(name) ?? 0) + step;
        if (count > 0) {
          counts.set(name, count);
        } else {
          counts.delete(name);
        }
      }
    }

    index.internalsVisibleToFiles += counted.internalsVisibleTo ? step : 0;
  }

  if (facts) {
    index.facts.set(file, facts);
  } else {
    index.facts.delete(file);
  }
}

/** The names of a project index held by a file other than the current one (whose names are `own`). */
class OtherFilesNames implements ReadonlySet<string> {
  constructor(
    private readonly counts: ReadonlyMap<string, number>,
    private readonly own: ReadonlySet<string> | undefined
  ) {}

  has(name: string): boolean {
    return (this.counts.get(name) ?? 0) > (this.own?.has(name) ? 1 : 0);
  }

  get size(): number {
    return [...this.keys()].length;
  }

  *keys(): IterableIterator<string> {
    for (const [name, count] of this.counts) {
      if (count > (this.own?.has(name) ? 1 : 0)) {
        yield name;
      }
    }
  }

  values(): IterableIterator<string> {
    return this.keys();
  }

  [Symbol.iterator](): IterableIterator<string> {
    return this.keys();
  }

  *entries(): IterableIterator<[string, string]> {
    for (const name of this.keys()) {
      yield [name, name];
    }
  }

  forEach(callback: (value: string, key: string, set: ReadonlySet<string>) => void, thisArg?: unknown): void {
    for (const name of this.keys()) {
      callback.call(thisArg, name, name, this);
    }
  }
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

/** Markup the SDK compiles into classes of the assembly (Razor components and pages, XAML), which the facts do not read. */
const MARKUP_SOURCE = /\.(?:razor|cshtml|xaml)$/i;

/** A Razor component, compiled into a class named like the file. */
const RAZOR_COMPONENT = /\.razor$/i;

const factsByComponent = new Map<string, SourceFacts>();

/** The facts of a Razor component: the class it compiles into, `Counter` for `Counter.razor`. */
function componentFacts(file: string): SourceFacts {
  let facts = factsByComponent.get(file);
  if (!facts) {
    const none = new Set<string>();
    facts = {
      derivedOrConstrainedNames: none,
      memberAccessNames: none,
      typeNames: new Set([path.basename(file).replace(RAZOR_COMPONENT, '')]),
      interfaceNames: none,
      interfaceMemberNames: none,
      globalUsings: none,
      internalsVisibleTo: false,
    };
    factsByComponent.set(file, facts);
  }

  return facts;
}

interface CachedListing {
  /** Every folder read, with its modification time: adding, removing or renaming an entry changes it. */
  readonly folders: ReadonlyMap<string, number>;
  readonly files: readonly string[];
  /** The markup files (see `MARKUP_SOURCE`). */
  readonly markup: readonly string[];
  readonly problems: readonly string[];
  /** No folder failed to read or changed too recently for its modification time to tell a later change. */
  readonly reusable: boolean;
}

/** Modification times this close to the listing may not change again for an entry added right after (coarse file system clocks). */
const RECENT_CHANGE_MS = 2000;

const listingByRoot = new Map<string, CachedListing>();

/** The `.cs` and markup files the SDK compiles by default; listed again only when one of the folders read changed. */
function listProjectSources(root: string, problems: string[]): CachedListing {
  let listing = listingByRoot.get(root);
  if (!listing?.reusable || [...listing.folders].some(([folder, mtimeMs]) => fs.statSync(folder, { throwIfNoEntry: false })?.mtimeMs !== mtimeMs)) {
    listing = walkProjectSources(root);
    listingByRoot.set(root, listing);
  }

  problems.push(...listing.problems);

  return listing;
}

function walkProjectSources(root: string): CachedListing {
  const folders = new Map<string, number>();
  const files: string[] = [];
  const problems: string[] = [];
  const now = Date.now();
  let reusable = true;
  const markup: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop() as string;
    let entries: fs.Dirent[];
    try {
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
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && SKIPPED_FOLDERS[entry.name.toLowerCase()] !== true) {
          pending.push(full);
        }
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.cs')) {
        files.push(path.resolve(full));
      } else if (entry.isFile() && MARKUP_SOURCE.test(entry.name)) {
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

interface ProjectSettings {
  /** The .NET SDK adds the `.cs` files under the project folder (SDK-style project, default items on). */
  readonly defaultCompileItems: boolean;
  /** Full paths of the `<Compile Include>` items. */
  readonly compileIncludes: readonly string[];
  readonly internalsVisibleTo: boolean;
  /** A markup file the project lists as an item (see `ProjectFacts.markup`). */
  readonly markupItem?: string;
  readonly importsSystem: boolean;
  readonly webProject: boolean;
}

/** Reads the project file and the `Directory.Build.props`/`.targets` files MSBuild imports for it. */
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

  const props = importedBuildFile(directory, 'Directory.Build.props', problems);
  const targets = importedBuildFile(directory, 'Directory.Build.targets', problems);
  const buildFiles = [...props, ...targets];
  // In evaluation order: a later property or item wins.
  const msbuild = [...props, projectText, ...targets];
  const evaluated = msbuild.join('\n');
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

  // Old-style projects list their markup (`<Page Include="MainWindow.xaml" />`) instead of finding it.
  const markupItem = /\bInclude\s*=\s*"([^"]*\.(?:razor|cshtml|xaml))"/i.exec(evaluated)?.[1];

  const sdkStyle = /<Project\s[^>]*\bSdk\s*=|<Sdk\s+Name\s*=|<Import\s[^>]*\bSdk\s*=/i.test(projectText);
  const defaultItemsOff = ['EnableDefaultItems', 'EnableDefaultCompileItems'].some((property) => /^false$/i.test(lastValue(evaluated, property) ?? ''));
  const implicitUsings = /^(?:enable|true)$/i.test(lastValue(evaluated, 'ImplicitUsings') ?? '');
  const systemUsing = [...evaluated.matchAll(/<Using\s+(Include|Remove)\s*=\s*"System"/gi)].pop()?.[1];

  return {
    defaultCompileItems: sdkStyle && !defaultItemsOff,
    compileIncludes,
    internalsVisibleTo: msbuild.some((text) => /<InternalsVisibleTo\b/i.test(text)),
    markupItem,
    importsSystem: systemUsing === undefined ? implicitUsings : /^include$/i.test(systemUsing),
    webProject: /Sdk\s*=\s*"Microsoft\.NET\.Sdk\.Web"/i.test(projectText) || /<Sdk\s+Name\s*=\s*"Microsoft\.NET\.Sdk\.Web"/i.test(projectText),
  };
}

/** The last value `msbuild` assigns to `property`. */
function lastValue(msbuild: string, property: string): string | undefined {
  return [...msbuild.matchAll(new RegExp(`<${property}>\\s*([^<]*?)\\s*</${property}>`, 'gi'))].pop()?.[1];
}

/**
 * The texts MSBuild evaluates for the `name` file (`Directory.Build.props` or `.targets`) of a
 * project in `directory`: the nearest one at or above it, with what it imports spliced in (see
 * `expandImports`).
 */
function importedBuildFile(directory: string, name: string, problems: string[]): string[] {
  for (let current = directory; ; ) {
    const file = path.join(current, name);
    let text: string | undefined;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        problems.push(`${file} could not be read (${(error as Error).message})`);
        return [];
      }
    }

    if (text !== undefined) {
      return expandImports(file, text, problems, new Set([file]));
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return [];
    }

    current = parent;
  }
}

/** Imports of the .NET SDK or the MSBuild toolset, which set nothing the facts read. */
const TOOLSET_IMPORT = /^\$\((?:MSBuildToolsPath|MSBuildBinPath|MSBuildExtensionsPath(?:32|64)?|MSBuildSDKsPath|VSToolsPath)\)/i;

/**
 * `text` of the MSBuild file `file` with the texts of its `<Import>`s spliced in where they are:
 * the next file of the same name above for `GetPathOfFileAbove('<its name>', ...)` (also written
 * `$(MSBuildThisFile)`) or a computed path ending in its name, and the file a plain path names,
 * relative to `file`. SDK and toolset imports are left out; any other import, or a missing file
 * imported without a condition, is a problem.
 */
function expandImports(file: string, text: string, problems: string[], seen: ReadonlySet<string>): string[] {
  const folder = path.dirname(file);
  const name = path.basename(file);
  const extension = path.extname(name);
  const comments = [...text.matchAll(/<!--[\s\S]*?-->/g)].map((match) => [match.index, match.index + match[0].length]);
  const parts: string[] = [];
  let last = 0;
  for (const match of text.matchAll(/<Import\s[^>]*>/gi)) {
    const element = match[0];
    const project = /\bProject\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(element);
    const value = (project?.[1] ?? project?.[2] ?? '').replace(/&amp;/g, '&').trim();
    if (comments.some(([start, end]) => match.index >= start && match.index < end) || /\bSdk\s*=/i.test(element) || TOOLSET_IMPORT.test(value)) {
      continue;
    }

    parts.push(text.slice(last, match.index));
    last = match.index + element.length;
    const resolved = value
      .replace(/\$\(MSBuildThisFileName\)\$\(MSBuildThisFileExtension\)|\$\(MSBuildThisFile\)/gi, name)
      .replace(/\$\(MSBuildThisFileName\)/gi, path.basename(name, extension))
      .replace(/\$\(MSBuildThisFileExtension\)/gi, extension)
      .replace(/\$\(MSBuildThisFileDirectory\)/gi, `${folder}${path.sep}`)
      .replace(/\$\(MSBuildThisFileFullPath\)/gi, file);
    // The file a computed path finds above: the first argument of `GetPathOfFileAbove`, else the file name it ends in.
    const computed = /^\$\(\[MSBuild\]::GetPathOfFileAbove\(\s*'?([^',)]*?)'?\s*[,)]/i.exec(resolved)?.[1] ?? (resolved.includes('$(') ? /[^\\/]*$/.exec(resolved)?.[0] : undefined);
    if (computed?.toLowerCase() === name.toLowerCase()) {
      const parent = path.dirname(folder);
      parts.push(...(parent === folder ? [] : importedBuildFile(parent, name, problems)));
    } else if (computed !== undefined || /[$@%*?;]/.test(resolved)) {
      problems.push(`${file} imports "${value}", which the cleanup cannot resolve`);
    } else {
      parts.push(...importedFile(path.resolve(folder, resolved.replace(/\\/g, path.sep)), /\bCondition\s*=/i.test(element), problems, seen));
    }
  }

  parts.push(text.slice(last));

  return parts;
}

/** The texts of the file an `<Import>` names by its path (see `expandImports`). */
function importedFile(file: string, conditional: boolean, problems: string[], seen: ReadonlySet<string>): string[] {
  if (seen.has(file)) {
    return [];
  }

  try {
    return expandImports(file, fs.readFileSync(file, 'utf8'), problems, new Set([...seen, file]));
  } catch (error) {
    // A conditional import is usually `Condition="Exists(...)"`: a missing file is skipped.
    if (!conditional || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      problems.push(`${file} could not be read (${(error as Error).message})`);
    }

    return [];
  }
}
