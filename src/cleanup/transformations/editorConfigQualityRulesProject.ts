import * as fs from 'node:fs';
import * as path from 'node:path';
import { baseTypeNames } from '../naming/sourceModel';
import { Node, findAll, parseCSharp } from '../parser';
import { listProjectSources } from '../projectSources';
import { ProjectInfo } from '../projectInfo';
import { memoizeBySource } from '../sourceCache';
import { Token, lex } from '../syntax/lexer';
import { interpolationHoles } from './interpolation';
import type { RuleContext } from './editorConfigCodeStyle';
import { GlobalSuppression, Suppressions, enclosingNames, globalSuppressionsOf } from './editorConfigQualityRulesSupport';
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
  /** Simple names inside the types of casts, `as`, `is` and `case` patterns and switch-expression arms (see `collectConversionTargetNames`). */
  readonly conversionTargetNames: ReadonlySet<string>;
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
  /** `Interface:Base` for every base type in the base list of a declared interface (simple names). */
  readonly interfaceBases: ReadonlySet<string>;
  /**
   * Full names of the namespaces declared inside another namespace, every level (`namespace
   * Acme.Tools.System` gives `Acme.Tools` and `Acme.Tools.System`): inside `Acme.Tools`, `System`
   * names that namespace instead of a type or global namespace of that name.
   */
  readonly nestedNamespaces: ReadonlySet<string>;
  /** Namespaces imported with `global using`. */
  readonly globalUsings: ReadonlySet<string>;
  /** Alias names declared with `global using Name = ...;` (in project facts, also `<Using Include="..." Alias="Name" />` items). */
  readonly globalUsingAliases: ReadonlySet<string>;
  /** The source applies `[assembly: InternalsVisibleTo(...)]`. */
  readonly internalsVisibleTo: boolean;
  /** Its `[assembly: SuppressMessage(...)]` and `[module: SuppressMessage(...)]` attributes (`GlobalSuppressions.cs`). */
  readonly globalSuppressions: readonly GlobalSuppression[];
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

const INTERNALS_VISIBLE_TO = /^InternalsVisibleTo(?:Attribute)?$/;

/**
 * Whether other assemblies may see the internals: the project exposes them, or `source` (the
 * current text of the file being cleaned, which the project facts leave out) applies the attribute.
 */
export function exposesInternals(project: ProjectFacts | undefined, source: string): boolean {
  if (project?.internalsVisibleTo) {
    return true;
  }

  const tokens = lex(source).tokens;

  return tokens.some((token) => token.type === 'identifier' && INTERNALS_VISIBLE_TO.test(source.slice(token.start, token.end)));
}

/** The suppressions of `source`, with the global ones of the project's other files (`GlobalSuppressions.cs`). */
export function suppressionsOf(source: string, context: RuleContext): Suppressions {
  return new Suppressions(source, context.project ? loadProjectFacts(context.project, context.filePath).others.globalSuppressions : []);
}

export function computeSourceFacts(source: string): SourceFacts {
  const memberAccessNames = new Set<string>();
  const globalUsings = new Set<string>();
  const globalUsingAliases = new Set<string>();
  let internalsVisibleTo = false;
  const tokens = lex(source).tokens;
  const text = (index: number): string => source.slice(tokens[index].start, tokens[index].end);
  for (let i = 0; i < tokens.length - 1; i++) {
    const type = tokens[i].type;
    if (type === 'identifier' && INTERNALS_VISIBLE_TO.test(text(i))) {
      internalsVisibleTo = true;
    } else if (type === 'identifier' && text(i) === 'global' && tokens[i + 1].type === 'using') {
      let end = i + 2;
      while (end < tokens.length && tokens[end].type !== ';') {
        end++;
      }

      const imported = source.slice(tokens[i + 2]?.start ?? 0, tokens[end]?.start ?? 0).replace(/\s+/g, '');
      const alias = /^@?(\w+)=/.exec(imported)?.[1];
      if (alias) {
        globalUsingAliases.add(alias);
      } else if (/^[\w.]+$/.test(imported)) {
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
      conversionTargetNames: collectConversionTargetNames(source, tree.rootNode),
      memberAccessNames,
      typeNames: new Set(declarations.map(nameOf)),
      interfaceNames: new Set(interfaces.map(nameOf)),
      interfaceMemberNames: new Set(interfaceMembers.map((member) => member.childForFieldName('name')?.text.replace(/^@/, '') ?? '').filter(Boolean)),
      interfaceBases: new Set(interfaces.flatMap((declaration) => baseTypeNames(declaration).map((base) => `${nameOf(declaration)}:${base}`))),
      nestedNamespaces: collectNestedNamespaces(tree.rootNode),
      globalUsings,
      globalUsingAliases,
      internalsVisibleTo,
      globalSuppressions: globalSuppressionsOf(source),
    };
  } finally {
    tree.delete();
  }
}

function collectNestedNamespaces(root: Node): Set<string> {
  const names = new Set<string>();
  for (const namespace of findAll(root, ['namespace_declaration', 'file_scoped_namespace_declaration'])) {
    const segments = enclosingNames(namespace).namespaces.map((segment) => segment.replace(/^@/, ''));
    for (let length = 2; length <= segments.length; length++) {
      names.add(segments.slice(0, length).join('.'));
    }
  }

  return names;
}

/** Tokens that can be part of a type as written after `as`; `<` `>` and `,` are tracked separately. */
const TYPE_TOKENS: Record<string, true> = { identifier: true, predefined_type: true, '.': true, '::': true, '?': true, '[': true, ']': true };

/** Tokens ending a pattern outside brackets: `x is T f && ...`, `case T f:`, `T f => ...`, `is T ? a : b`. */
const PATTERN_ENDS: Record<string, true> = { ';': true, ':': true, '=>': true, '&&': true, '||': true, '?': true, '??': true, ',': true, '==': true, '!=': true };

/**
 * Simple names inside the types `source` explicitly converts to: cast and `as` types, and every
 * name of an `is` or `case` pattern or a switch-expression arm (constants and designations too,
 * which only makes the rules more careful). Sealing a class removes the explicit conversion from
 * an interface it does not implement, so such a conversion would stop compiling (CS0030, CS0039,
 * CS8121). Patterns are read from the tokens: the parser does not structure all of them.
 */
export function collectConversionTargetNames(source: string, root: Node): Set<string> {
  const names = new Set<string>();
  const addIdentifiers = (node: Node): void => {
    for (const identifier of [node, ...node.descendantsOfType('identifier')]) {
      if (identifier.type === 'identifier') {
        names.add(identifier.text.replace(/^@/, ''));
      }
    }
  };
  for (const cast of findAll(root, 'cast_expression')) {
    const type = cast.childForFieldName('type') ?? cast.namedChildren[0];
    if (type) {
      addIdentifiers(type);
    }
  }

  const tokens = lex(source).tokens;
  const text = (index: number): string => source.slice(tokens[index].start, tokens[index].end);
  const addType = (start: number): void => {
    let angles = 0;
    for (let i = start; i < tokens.length; i++) {
      const type = tokens[i].type;
      if (type === '<') {
        angles++;
      } else if (type === '>' && angles > 0) {
        angles--;
      } else if (type === ',' && angles > 0) {
        continue;
      } else if (TYPE_TOKENS[type] !== true) {
        return;
      } else if (type === 'identifier') {
        names.add(text(i).replace(/^@/, ''));
      }
    }
  };
  const addPattern = (start: number): void => {
    let depth = 0;
    for (let i = start; i < tokens.length && tokens[i].type !== 'end'; i++) {
      const type = tokens[i].type;
      if (type === '(' || type === '[' || type === '{') {
        depth++;
      } else if (type === ')' || type === ']' || type === '}') {
        if (--depth < 0) {
          return;
        }
      } else if (depth === 0 && (PATTERN_ENDS[type] === true || (type === 'identifier' && text(i) === 'when'))) {
        return;
      } else if (type === 'identifier') {
        names.add(text(i).replace(/^@/, ''));
      }
    }
  };

  for (let i = 0; i < tokens.length - 1; i++) {
    const type = tokens[i].type;
    if (type === 'as') {
      addType(i + 1);
    } else if (type === 'is' || type === 'case') {
      addPattern(i + 1);
    } else if (type === 'switch' && tokens[i + 1].type === '{') {
      // A switch expression: each arm starts after `{` or a `,` at the arms' level.
      let depth = 0;
      for (let j = i + 1; j < tokens.length && tokens[j].type !== 'end'; j++) {
        const inner = tokens[j].type;
        if ((inner === '{' && depth === 0) || (inner === ',' && depth === 1)) {
          addPattern(j + 1);
        }

        depth += inner === '(' || inner === '[' || inner === '{' ? 1 : inner === ')' || inner === ']' || inner === '}' ? -1 : 0;
        if (depth === 0) {
          break;
        }
      }
    }
  }

  return names;
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

/** An XML comment: MSBuild ignores what it holds. */
const XML_COMMENT = /<!--[\s\S]*?-->/g;

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
      const text = projectFiles.length === 1 ? fs.readFileSync(path.join(project.directory, projectFiles[0]), 'utf8').replace(XML_COMMENT, '') : '';
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
 * `<Compile Include>` items, read from their unsaved text where `project.unsavedSources` has it.
 * Computed once per project object (one cleanup). A batch cleanup asks with a new project object
 * per file: the project's scan is reused while the calls follow each other closely (see
 * `SCAN_REUSE_MS`), reading again only the files cleaned since. Later, only the files and folders
 * whose modification time changed are read again.
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
    facts = readProjectFacts(project.directory, key, project.unsavedSources);
    byFile.set(key, facts);
  }

  return facts;
}

type NameKind =
  | 'derivedOrConstrainedNames'
  | 'conversionTargetNames'
  | 'memberAccessNames'
  | 'typeNames'
  | 'interfaceNames'
  | 'interfaceMemberNames'
  | 'interfaceBases'
  | 'nestedNamespaces'
  | 'globalUsings'
  | 'globalUsingAliases';

const NAME_KINDS: readonly NameKind[] = [
  'derivedOrConstrainedNames',
  'conversionTargetNames',
  'memberAccessNames',
  'typeNames',
  'interfaceNames',
  'interfaceMemberNames',
  'interfaceBases',
  'nestedNamespaces',
  'globalUsings',
  'globalUsingAliases',
];

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

/** What one scan of a project folder found, reused by the calls of one batch cleanup. */
interface ProjectScan {
  readonly settings: ProjectSettings;
  readonly markup: string | undefined;
  /** The C# files the project compiles. */
  readonly files: ReadonlySet<string>;
  readonly index: ProjectIndex;
  /** Problems of the project file and folder listing. */
  readonly problems: readonly string[];
  /** Why a file could not be read, by file. */
  readonly unreadable: Map<string, string>;
  /** The current files asked for since the scan, in a batch each file once; the last one the cleanup may since have rewritten. */
  readonly asked: Set<string>;
  lastAsked: string | undefined;
  lastUse: number;
  /** The files counted from their unsaved text instead of their disk copy. */
  readonly unsaved: Set<string>;
}

/**
 * How long after the previous call for a project its scan is still reused. A batch cleanup asks for
 * the facts file after file, each file once; a gap this long, a call for no file or for a file asked
 * for before ends the batch, and the call scans the project again.
 */
const SCAN_REUSE_MS = 1000;

const scanByDirectory = new Map<string, ProjectScan>();

function readProjectFacts(directory: string, currentFile: string, unsavedSources: ReadonlyMap<string, string> | undefined): ProjectFacts {
  const now = Date.now();
  let scan = scanByDirectory.get(directory);
  if (!scan || !currentFile || scan.asked.has(currentFile) || now - scan.lastUse > SCAN_REUSE_MS) {
    scan = scanProject(directory);
    scanByDirectory.set(directory, scan);
  } else if (scan.lastAsked !== undefined && scan.files.has(scan.lastAsked)) {
    readIntoScan(scan, scan.lastAsked);
  }

  // The disk copy again for files no longer unsaved (saved or reverted since), the text of those that are.
  for (const file of [...scan.unsaved].filter((file) => !unsavedSources?.has(file))) {
    scan.unsaved.delete(file);
    readIntoScan(scan, file);
  }

  for (const [file, text] of unsavedSources ?? []) {
    if (scan.files.has(file)) {
      scan.unsaved.add(file);
      scan.unreadable.delete(file);
      updateIndex(scan.index, file, unsavedSourceFacts(text));
    }
  }

  if (currentFile) {
    scan.asked.add(currentFile);
  }

  scan.lastAsked = currentFile || undefined;
  scan.lastUse = now;
  const { index, settings } = scan;
  // The current file is counted from disk like the others and left out here; the rules read its
  // current text themselves, so it not being on disk (yet) is no problem.
  const problems = [...scan.problems, ...[...scan.unreadable].filter(([file]) => file !== currentFile).map(([, problem]) => problem)];
  const own = index.facts.get(currentFile);
  const others = Object.fromEntries(
    NAME_KINDS.map((kind): [NameKind, ReadonlySet<string>] => [kind, new OtherFilesNames(index.counts[kind], own?.[kind])])
  ) as Record<NameKind, ReadonlySet<string>>;
  const internalsVisibleTo = index.internalsVisibleToFiles - (own?.internalsVisibleTo ? 1 : 0) > 0;
  const globalSuppressions = [...index.facts].flatMap(([file, facts]) => (file === currentFile ? [] : facts.globalSuppressions));

  return {
    incomplete: problems.length > 0 ? problems.join('; ') : undefined,
    markup: scan.markup,
    others: {
      ...others,
      globalUsingAliases: settings.usingAliases.length > 0 ? new Set([...others.globalUsingAliases, ...settings.usingAliases]) : others.globalUsingAliases,
      internalsVisibleTo,
      globalSuppressions,
    },
    internalsVisibleTo: settings.internalsVisibleTo || internalsVisibleTo,
    importsSystem: settings.importsSystem || others.globalUsings.has('System'),
    webProject: settings.webProject,
  };
}

/** Reads the project settings and every source of the project folder into its index. */
function scanProject(directory: string): ProjectScan {
  const problems: string[] = [];
  const settings = readProjectSettings(directory, problems);
  // Markup default items (Razor components, pages, XAML) follow EnableDefaultItems, not EnableDefaultCompileItems.
  const listing = settings.defaultItems ? listProjectSources(directory, settings.excludesNodeModules) : undefined;
  problems.push(...(listing?.problems ?? []));
  const files = new Set([...(settings.defaultCompileItems ? (listing?.files ?? []) : []), ...settings.compileIncludes]);
  const components = new Set(listing?.markup.filter((file) => RAZOR_COMPONENT.test(file)));
  let index = indexByDirectory.get(directory);
  if (!index) {
    index = { facts: new Map(), counts: Object.fromEntries(NAME_KINDS.map((kind) => [kind, new Map()])) as ProjectIndex['counts'], internalsVisibleToFiles: 0 };
    indexByDirectory.set(directory, index);
  }

  const scan: ProjectScan = {
    settings,
    markup: listing?.markup[0] ?? settings.markupItem,
    files,
    index,
    problems,
    unreadable: new Map(),
    asked: new Set(),
    lastAsked: undefined,
    lastUse: 0,
    unsaved: new Set(),
  };
  for (const file of files) {
    readIntoScan(scan, file);
  }

  for (const file of components) {
    updateIndex(index, file, componentFacts(file));
  }

  for (const file of [...index.facts.keys()].filter((known) => !files.has(known) && !components.has(known))) {
    updateIndex(index, file, undefined);
  }

  return scan;
}

/** Counts the facts of `file` as on disk now (read again only when its size or time changed). */
function readIntoScan(scan: ProjectScan, file: string): void {
  const problems: string[] = [];
  updateIndex(scan.index, file, readSourceFacts(file, problems));
  if (problems.length > 0) {
    scan.unreadable.set(file, problems.join('; '));
  } else {
    scan.unreadable.delete(file);
  }
}

/**
 * The facts of an unsaved text: the same object for the same text, so counting it again changes
 * nothing. Each call counts every unsaved file again, so the cache holds more than a few editors.
 */
const unsavedSourceFacts = memoizeBySource(computeSourceFacts, 64);

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
    // The file is gone (or unreadable): a file created later at its path must be read, not matched by size and time.
    index.facts.delete(file);
    factsByFile.delete(file);
    factsByComponent.delete(file);
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
      conversionTargetNames: none,
      memberAccessNames: none,
      typeNames: new Set([path.basename(file).replace(RAZOR_COMPONENT, '')]),
      interfaceNames: none,
      interfaceMemberNames: none,
      interfaceBases: none,
      nestedNamespaces: none,
      globalUsings: none,
      globalUsingAliases: none,
      internalsVisibleTo: false,
      globalSuppressions: [],
    };
    factsByComponent.set(file, facts);
  }

  return facts;
}

interface ProjectSettings {
  /** The .NET SDK adds the files under the project folder as items (SDK-style project, default items on). */
  readonly defaultItems: boolean;
  /** The .NET SDK adds the `.cs` files under the project folder (default items and default compile items on). */
  readonly defaultCompileItems: boolean;
  /** Full paths of the `<Compile Include>` items. */
  readonly compileIncludes: readonly string[];
  readonly internalsVisibleTo: boolean;
  /** A markup file the project lists as an item (see `ProjectFacts.markup`). */
  readonly markupItem?: string;
  readonly importsSystem: boolean;
  /** Aliases of the `<Using Include="..." Alias="Name" />` items. */
  readonly usingAliases: readonly string[];
  readonly webProject: boolean;
  /** The Web and Razor SDKs (Blazor WebAssembly too) leave `node_modules` out of the default items. */
  readonly excludesNodeModules: boolean;
}

/** Reads the project file, what it imports and the `Directory.Build.props`/`.targets` files MSBuild imports for it. */
function readProjectSettings(directory: string, problems: string[]): ProjectSettings {
  let projectText = '';
  let projectParts: string[] = [];
  try {
    const projectFiles = fs.readdirSync(directory).filter((name) => name.toLowerCase().endsWith('.csproj'));
    if (projectFiles.length !== 1) {
      problems.push(`${directory} does not contain exactly one project file`);
    } else {
      const projectFile = path.join(directory, projectFiles[0]);
      projectText = fs.readFileSync(projectFile, 'utf8').replace(XML_COMMENT, '');
      projectParts = expandImports(projectFile, projectText, problems, new Set([projectFile]));
    }
  } catch (error) {
    problems.push(`the project file in ${directory} could not be read (${(error as Error).message})`);
  }

  const props = importedBuildFile(directory, 'Directory.Build.props', problems, new Set());
  const targets = importedBuildFile(directory, 'Directory.Build.targets', problems, new Set());
  // In evaluation order: a later property or item wins.
  const evaluated = [...props, ...projectParts, ...targets].join('\n');
  const compileInclude = /<Compile\s[^>]*?\bInclude\s*=\s*"([^"]*)"/gi;
  if ([...evaluated.matchAll(compileInclude)].length > [...projectText.matchAll(compileInclude)].length) {
    problems.push('a Directory.Build file or a file the project imports adds C# files with <Compile Include>');
  }

  // `<Compile Include="..\Shared\File.cs" />`: explicit files (old-style projects list all of them).
  const compileIncludes: string[] = [];
  for (const match of projectText.matchAll(compileInclude)) {
    const include = match[1].replace(/&amp;/g, '&');
    if (/[*?$%;]/.test(include)) {
      problems.push(`the project adds C# files with the pattern "${include}"`);
    } else if (include.toLowerCase().endsWith('.cs')) {
      compileIncludes.push(path.resolve(directory, include.replace(/\\/g, path.sep)));
    }
  }

  // Old-style projects list their markup (`<Page Include="MainWindow.xaml" />`) instead of finding it.
  const markupItem = /\bInclude\s*=\s*"([^"]*\.(?:razor|cshtml|xaml|axaml))"/i.exec(evaluated)?.[1];

  const sdkStyle = /<Project\s[^>]*\bSdk\s*=|<Sdk\s+Name\s*=|<Import\s[^>]*\bSdk\s*=/i.test(projectText);
  const defaultItems = sdkStyle && !/^false$/i.test(lastValue(evaluated, 'EnableDefaultItems') ?? '');
  const implicitUsings = /^(?:enable|true)$/i.test(lastValue(evaluated, 'ImplicitUsings') ?? '');
  const systemUsing = [...evaluated.matchAll(/<Using\s+(Include|Remove)\s*=\s*"System"/gi)].pop()?.[1];

  return {
    defaultItems,
    defaultCompileItems: defaultItems && !/^false$/i.test(lastValue(evaluated, 'EnableDefaultCompileItems') ?? ''),
    compileIncludes,
    // `<InternalsVisibleTo Include="..." />`, or the item the SDK turns into the attribute itself.
    internalsVisibleTo: /<InternalsVisibleTo\b/i.test(evaluated) || /<AssemblyAttribute\s[^>]*?\bInclude\s*=\s*["'][^"']*\bInternalsVisibleTo(?:Attribute)?["']/i.test(evaluated),
    markupItem,
    importsSystem: systemUsing === undefined ? implicitUsings : /^include$/i.test(systemUsing),
    usingAliases: [...evaluated.matchAll(/<Using\s[^>]*?\bAlias\s*=\s*"([^"]+)"/gi)].map((match) => match[1].trim()),
    webProject: /Sdk\s*=\s*"Microsoft\.NET\.Sdk\.Web"/i.test(projectText) || /<Sdk\s+Name\s*=\s*"Microsoft\.NET\.Sdk\.Web"/i.test(projectText),
    excludesNodeModules: /(?:\bSdk\s*=|<Sdk\s+Name\s*=)\s*"Microsoft\.NET\.Sdk\.(?:Web|Razor|BlazorWebAssembly)\b/i.test(projectText),
  };
}

/** The last value `msbuild` assigns to `property`. */
function lastValue(msbuild: string, property: string): string | undefined {
  return [...msbuild.matchAll(new RegExp(`<${property}>\\s*([^<]*?)\\s*</${property}>`, 'gi'))].pop()?.[1];
}

/**
 * The texts MSBuild evaluates for the `name` file (`Directory.Build.props` or `.targets`) of a
 * project in `directory`: the nearest one at or above it, with what it imports spliced in (see
 * `expandImports`), or nothing when it is one of the files `seen` already imports (MSBuild skips a
 * repeated import).
 */
function importedBuildFile(directory: string, name: string, problems: string[], seen: ReadonlySet<string>): string[] {
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
      return seen.has(file) ? [] : expandImports(file, text, problems, new Set([...seen, file]));
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
 * `text` of the MSBuild file `file` without its XML comments, with the texts of its `<Import>`s
 * spliced in where they are: the next file of the same name above for `GetPathOfFileAbove('<its
 * name>', ...)` (also written `$(MSBuildThisFile)`) or a computed path ending in its name, and the
 * file a plain path names, relative to `file`. SDK and toolset imports are left out; a shared
 * project, any other import, or a missing file imported without a condition, is a problem.
 */
function expandImports(file: string, text: string, problems: string[], seen: ReadonlySet<string>): string[] {
  const folder = path.dirname(file);
  const name = path.basename(file);
  const extension = path.extname(name);
  const evaluated = text.replace(XML_COMMENT, '');
  const parts: string[] = [];
  let last = 0;
  for (const match of evaluated.matchAll(/<Import\s[^>]*>/gi)) {
    const element = match[0];
    const project = /\bProject\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(element);
    const value = (project?.[1] ?? project?.[2] ?? '').replace(/&amp;/g, '&').trim();
    if (/\bSdk\s*=/i.test(element) || TOOLSET_IMPORT.test(value)) {
      continue;
    }

    parts.push(evaluated.slice(last, match.index));
    last = match.index + element.length;
    if (/\.projitems$/i.test(value)) {
      problems.push('the project imports a shared project');
      continue;
    }

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
      parts.push(...(parent === folder ? [] : importedBuildFile(parent, name, problems, seen)));
    } else if (computed !== undefined || /[$@%*?;]/.test(resolved)) {
      problems.push(`${file} imports "${value}", which the cleanup cannot resolve`);
    } else {
      parts.push(...importedFile(path.resolve(folder, resolved.replace(/\\/g, path.sep)), /\bCondition\s*=/i.test(element), problems, seen));
    }
  }

  parts.push(evaluated.slice(last));

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
