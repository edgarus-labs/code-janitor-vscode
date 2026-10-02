import * as fs from 'node:fs';
import * as path from 'node:path';
import { readMSBuildProject } from '../msbuildProperties';
import { WorkspaceProject, readProject } from '../naming/workspaceScope';
import { DeclarationAggregate, DeclarationIndex, ExternalDeclarations, FileSummary, asConditional, summarizeDeclarations } from './declarations';

/** What the using-directive placement knows about the project a file belongs to. */
export interface ProjectContext {
  /** The declarations of the project and the projects it references, with the file itself as `source` now reads. */
  readonly index: DeclarationIndex;
  /** The project references assemblies other than the framework (packages, `<Reference>`), whose namespaces the index does not list. */
  readonly externalReferences: boolean;
  /** Why the index may miss declarations (files compiled from outside the project folder, unreadable files). */
  readonly incomplete?: string;
  /** Full path of the project file. */
  readonly projectFile: string;
}

interface CachedFile {
  readonly mtimeMs: number;
  readonly size: number;
  readonly summary: FileSummary;
}

interface CachedProject {
  checkedAt: number;
  aggregate: DeclarationAggregate;
  summaries: Map<string, FileSummary>;
  externalReferences: boolean;
  external: ExternalDeclarations;
  incomplete?: string;
}

/** How long the files of a project are trusted without looking at them again. */
const REFRESH_MS = 1500;
const MAX_REFERENCE_DEPTH = 16;

const fileCache = new Map<string, CachedFile>();
const projectCache = new Map<string, CachedProject>();

export function clearUsingIndexCache(): void {
  fileCache.clear();
  projectCache.clear();
}

/**
 * The project of `filePath` (the single `.csproj` in the nearest folder that has one) with the
 * declarations of its files and of the projects it references, or why there is none.
 */
export function projectContextOf(filePath: string, source: string): ProjectContext | { unavailable: string } {
  if (!filePath.trim()) {
    return { unavailable: 'the file is not part of a C# project' };
  }

  const file = path.resolve(filePath);
  const located = locateProjectFile(path.dirname(file));
  if ('unavailable' in located) {
    return located;
  }

  const cached = loadProject(located.projectFile);
  const own = cached.summaries.get(file);

  return {
    index: cached.aggregate.view(own, summarizeDeclarations(source), cached.external),
    externalReferences: cached.externalReferences,
    incomplete: cached.incomplete,
    projectFile: located.projectFile,
  };
}

function locateProjectFile(start: string): { projectFile: string } | { unavailable: string } {
  let directory = start;
  for (;;) {
    let projects: string[];
    try {
      projects = fs.readdirSync(directory).filter((name) => name.toLowerCase().endsWith('.csproj'));
    } catch {
      return { unavailable: 'the file is not part of a C# project' };
    }

    if (projects.length > 0) {
      return projects.length === 1
        ? { projectFile: path.join(directory, projects[0]) }
        : { unavailable: `${directory} holds several project files, so the project of the file is not known` };
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      return { unavailable: 'the file is not part of a C# project' };
    }

    directory = parent;
  }
}

function loadProject(projectFile: string): CachedProject {
  const now = Date.now();
  const existing = projectCache.get(projectFile);
  if (existing && now - existing.checkedAt < REFRESH_MS) {
    return existing;
  }

  const { projects, problems } = referencedProjects(projectFile);
  const aggregate = new DeclarationAggregate();
  const summaries = new Map<string, FileSummary>();
  let externalReferences = false;
  let namespaceRoots: Set<string> | 'any' = new Set();

  // The SDK writes the `<Using>` items of the project (`<ImplicitUsings>` adds some) into a generated file; they are global usings like the written ones.
  const msbuildUsings = msbuildGlobalUsingsOf(projects[0]);
  if (msbuildUsings.usings.length > 0) {
    aggregate.add({ keys: new Set(msbuildUsings.usings.map((words) => `G:${words}`)) });
  }

  problems.push(...msbuildUsings.problems);

  for (const [position, project] of projects.entries()) {
    if (project.problem) {
      problems.push(project.problem);
    }

    const references = referencesOf(project);
    externalReferences ||= references.external;
    namespaceRoots = namespaceRoots === 'any' || references.namespaceRoots === 'any' ? 'any' : new Set([...namespaceRoots, ...references.namespaceRoots]);
    const removals = compileRemovalsOf(project);
    problems.push(...removals.problems);
    for (const file of project.csharpFiles) {
      const read = summaryOf(file);
      // A `global using` applies only in the compilation that declares it: those of referenced projects do not reach this one.
      const compiled = read && position > 0 ? withoutGlobalUsings(read) : read;
      // A file a `<Compile Remove>` may take out of the compilation declares what it declares only in some builds.
      const summary = compiled && removals.patterns.some((pattern) => pattern.test(file.replace(/\\/g, '/'))) ? asConditional(compiled) : compiled;
      if (summary) {
        aggregate.add(summary);
        summaries.set(file, summary);
      } else {
        problems.push(`${file} could not be read`);
      }
    }
  }

  const project: CachedProject = {
    checkedAt: now,
    aggregate,
    summaries,
    externalReferences,
    external: {
      // Packages and frameworks other than the indexed ones add to the framework namespaces, and so do the
      // reference assemblies of other target frameworks (.NET Framework, .NET Standard, platforms).
      frameworkNamespacesOpen: externalReferences || projects[0] === undefined || !targetsIndexedFramework(projects[0]),
      namespaceRoots,
    },
    ...(problems.length > 0 ? { incomplete: problems.join('; ') } : {}),
  };
  projectCache.set(projectFile, project);

  return project;
}

/** True when every target framework of `project` is a .NET (5 or later) one without a platform, whose namespaces the index lists. */
function targetsIndexedFramework(project: WorkspaceProject): boolean {
  const msbuild = readMSBuildProject(project.projectFile);
  const name = msbuild?.property('TargetFrameworks') !== undefined ? 'TargetFrameworks' : 'TargetFramework';
  const value = msbuild?.isCertain(name) ? msbuild.property(name) : undefined;
  const frameworks = (value ?? '')
    .split(';')
    .map((framework) => framework.trim())
    .filter((framework) => framework !== '');

  return frameworks.length > 0 && frameworks.every((framework) => /^net\d+\.\d+$/i.test(framework));
}

/**
 * The files the `<Compile Remove>` items of `project` or its `Directory.Build.*` files may take out of the compilation, as
 * patterns of full paths with `/` separators, and the items whose paths MSBuild has to evaluate.
 */
function compileRemovalsOf(project: WorkspaceProject): { patterns: RegExp[]; problems: string[] } {
  const files = buildFilesOf(project);
  const patterns: RegExp[] = [];
  const problems: string[] = [];
  for (const text of [...files.props, files.projectText ?? '', ...files.targets]) {
    for (const element of text.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<Compile\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
      const remove = /\bRemove\s*=\s*(["'])(.*?)\1/i.exec(element[1])?.[2];
      for (const include of (remove ?? '').split(';').map((part) => part.trim()).filter((part) => part !== '')) {
        if (/[$@%]\(/.test(include)) {
          problems.push(`the <Compile Remove> item '${include}' needs MSBuild to be evaluated`);
        } else {
          patterns.push(globPattern(path.resolve(project.directory, include.replace(/\\/g, '/')).replace(/\\/g, '/')));
        }
      }
    }
  }

  return { patterns, problems };
}

/** An MSBuild wildcard path: `**` any number of folders, `*` and `?` characters within one name. */
function globPattern(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith('**/', i)) {
      source += '(?:.*/)?';
      i += 2;
    } else if (glob.startsWith('**', i)) {
      source += '.*';
      i++;
    } else {
      source += glob[i] === '*' ? '[^/]*' : glob[i] === '?' ? '[^/]' : glob[i].replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }

  return new RegExp(`^${source}$`, process.platform === 'win32' ? 'i' : '');
}

/**
 * `projectFile` and the projects it references, directly or through other projects, with why a reference
 * contributes no declarations: MSBuild has to evaluate its path, or the project is not there.
 */
function referencedProjects(projectFile: string): { projects: WorkspaceProject[]; problems: string[] } {
  const projects: WorkspaceProject[] = [];
  const problems: string[] = [];
  const seen: string[] = [];
  const pending: { file: string; depth: number; from?: string }[] = [{ file: projectFile, depth: 0 }];
  while (pending.length > 0) {
    const { file, depth, from } = pending.pop() as { file: string; depth: number; from?: string };
    if (seen.some((other) => samePath(other, file))) {
      continue;
    }

    seen.push(file);
    // Only this project is read: listing the projects of its folder would read every project nested below it as well.
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
      problems.push(`the project ${file} referenced by ${from ?? projectFile} could not be found`);
      continue;
    }

    const project = readProject(file);
    projects.push(project);
    for (const unresolved of project.unresolvedReferences) {
      problems.push(`${project.projectFile} references '${unresolved}', which MSBuild has to resolve`);
    }

    if (depth < MAX_REFERENCE_DEPTH) {
      for (const reference of project.references) {
        pending.push({ file: reference, depth: depth + 1, from: project.projectFile });
      }
    }
  }

  return { projects, problems };
}

/** Windows paths are case-insensitive: `..\lib\Lib.csproj` names `Lib/Lib.csproj`. */
function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function summaryOf(file: string): FileSummary | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return undefined;
  }

  const cached = fileCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.summary;
  }

  try {
    const summary = summarizeDeclarations(fs.readFileSync(file, 'utf8'));
    fileCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, summary });

    return summary;
  } catch {
    return undefined;
  }
}

function withoutGlobalUsings(summary: FileSummary): FileSummary {
  const keys = [...summary.keys];

  return keys.some((key) => key.startsWith('G:')) ? { keys: new Set(keys.filter((key) => !key.startsWith('G:'))) } : summary;
}

const IMPLICIT_USINGS: Readonly<Record<string, readonly string[]>> = {
  'Microsoft.NET.Sdk': ['System', 'System.Collections.Generic', 'System.IO', 'System.Linq', 'System.Net.Http', 'System.Threading', 'System.Threading.Tasks'],
  'Microsoft.NET.Sdk.Web': [
    'System.Net.Http.Json',
    'Microsoft.AspNetCore.Builder',
    'Microsoft.AspNetCore.Hosting',
    'Microsoft.AspNetCore.Http',
    'Microsoft.AspNetCore.Routing',
    'Microsoft.Extensions.Configuration',
    'Microsoft.Extensions.DependencyInjection',
    'Microsoft.Extensions.Hosting',
    'Microsoft.Extensions.Logging',
  ],
  'Microsoft.NET.Sdk.Worker': ['Microsoft.Extensions.Configuration', 'Microsoft.Extensions.DependencyInjection', 'Microsoft.Extensions.Hosting', 'Microsoft.Extensions.Logging'],
};

/** Text of the files of `project` in the order MSBuild reads them: `Directory.Build.props` (outermost first), the project, `Directory.Build.targets`. */
function buildFilesOf(project: WorkspaceProject): { props: string[]; projectText?: string; targets: string[] } {
  const props: string[] = [];
  const targets: string[] = [];
  for (let directory = project.directory; ; directory = path.dirname(directory)) {
    for (const [name, texts] of [['Directory.Build.props', props], ['Directory.Build.targets', targets]] as const) {
      try {
        texts.unshift(fs.readFileSync(path.join(directory, name), 'utf8'));
      } catch {
        // Not there.
      }
    }

    if (path.dirname(directory) === directory) {
      break;
    }
  }

  try {
    return { props, projectText: fs.readFileSync(project.projectFile, 'utf8'), targets };
  } catch {
    return { props, targets };
  }
}

/** Where MSBuild may skip the elements of `text`: below a `Condition`, in a `<Choose>` or in a `<Target>` run at build time. */
function conditionalRanges(text: string): { start: number; end: number }[] {
  const conditional: { start: number; end: number }[] = [];
  const open: { name: string; start: number; conditioned: boolean }[] = [];
  for (const tag of text.matchAll(/<(\/?)([\w.:-]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g)) {
    const [, closing, name, attributes, selfClosing] = tag;
    if (closing) {
      const at = open.map((element) => element.name).lastIndexOf(name);
      if (at >= 0) {
        const [element] = open.splice(at);
        if (element.conditioned) {
          conditional.push({ start: element.start, end: tag.index + tag[0].length });
        }
      }
    } else if (!selfClosing) {
      open.push({ name, start: tag.index, conditioned: /^(?:Choose|Target)$/i.test(name) || /\bCondition\s*=/i.test(attributes) });
    }
  }

  conditional.push(...open.filter((element) => element.conditioned).map((element) => ({ start: element.start, end: text.length })));

  return conditional;
}

const isConditional = (ranges: readonly { start: number; end: number }[], at: number): boolean => ranges.some((range) => range.start <= at && at < range.end);

/**
 * The global usings MSBuild generates for the project, as `G:` key texts: its `<Using>` items (`Static`, `Alias`),
 * including those the SDK adds for `<ImplicitUsings>enable</ImplicitUsings>`, less the ones `<Using Remove>` takes out.
 */
function msbuildGlobalUsingsOf(project: WorkspaceProject | undefined): { usings: string[]; problems: string[] } {
  if (!project) {
    return { usings: [], problems: [] };
  }

  const files = buildFilesOf(project);
  if (files.projectText === undefined) {
    return { usings: [], problems: [] };
  }

  const uncommented = (text: string): string => text.replace(/<!--[\s\S]*?-->/g, '');
  const props = files.props.map(uncommented);
  const projectText = uncommented(files.projectText);
  const targets = files.targets.map(uncommented);

  const problems: string[] = [];
  // A value MSBuild may skip may still apply: implicit usings are there when the last unconditioned value or any
  // conditioned one after it enables them, which errs towards more global usings.
  const values = [...props, projectText, ...targets].flatMap((text) => {
    const conditional = conditionalRanges(text);

    return [...text.matchAll(/<ImplicitUsings\b(?:[^>"']|"[^"]*"|'[^']*')*>\s*([^<\s]*)\s*<\/ImplicitUsings\s*>/gi)].map((match) => ({
      enables: /^(?:enable|true)$/i.test(match[1]),
      conditioned: isConditional(conditional, match.index),
    }));
  });
  const lastUnconditioned = values.map((value) => value.conditioned).lastIndexOf(false);
  const enabled = values.slice(Math.max(lastUnconditioned, 0)).some((value) => value.enables);
  let implicit: readonly string[] = [];
  if (enabled) {
    const sdk = /<Project\s[^>]*\bSdk\s*=\s*(["'])([^"']+)\1/i.exec(projectText)?.[2] ?? 'Microsoft.NET.Sdk';
    const extra = IMPLICIT_USINGS[sdk];
    implicit = [...IMPLICIT_USINGS['Microsoft.NET.Sdk'], ...(sdk === 'Microsoft.NET.Sdk' ? [] : (extra ?? []))];
    if (extra === undefined) {
      problems.push(`the implicit usings of the SDK ${sdk} are not known`);
    }
  }

  // Item order: Directory.Build.props, the SDK's implicit usings (its props), the project, Directory.Build.targets.
  const items: { include: string; words: string }[] = [];
  const spaced = (name: string): string => name.split('.').map((segment) => segment.trim()).join(' . ');
  const apply = (text: string): void => {
    const conditional = conditionalRanges(text);

    for (const element of text.matchAll(/<Using\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Using\s*>)/gi)) {
      const attributes = new Map([...element[1].matchAll(/([\w.]+)\s*=\s*(["'])(.*?)\2/g)].map((match) => [match[1].toLowerCase(), match[3].trim()]));
      for (const metadata of (element[2] ?? '').matchAll(/<(\w+)>\s*([^<]*?)\s*<\/\1\s*>/g)) {
        attributes.set(metadata[1].toLowerCase(), metadata[2]);
      }

      const remove = attributes.get('remove');
      if (remove !== undefined) {
        // An unconditional removal only: keeping an item MSBuild may drop errs towards more global usings.
        const names = new Set(remove.split(';').map((name) => name.trim().toLowerCase()));
        if (!attributes.has('condition') && !isConditional(conditional, element.index)) {
          items.splice(0, items.length, ...items.filter((item) => !names.has(item.include.toLowerCase())));
        }

        continue;
      }

      const alias = attributes.get('alias');
      const isStatic = attributes.get('static')?.toLowerCase() === 'true';
      for (const include of (attributes.get('include') ?? '').split(';').map((name) => name.trim()).filter((name) => name.length > 0)) {
        if (/[$@%*?]/.test(include) || (alias !== undefined && /[$@%]/.test(alias))) {
          problems.push(`the <Using> item '${include}' needs MSBuild to be evaluated`);
          continue;
        }

        items.push({ include, words: alias ? `${alias} = ${spaced(include)}` : isStatic ? `static ${spaced(include)}` : spaced(include) });
      }
    }
  };

  props.forEach(apply);
  items.push(...implicit.map((namespace) => ({ include: namespace, words: spaced(namespace) })));
  [projectText, ...targets].forEach(apply);

  return { usings: [...new Set(items.map((item) => item.words))], problems };
}

const EXTERNAL_REFERENCE = /<(?:PackageReference|GlobalPackageReference|Reference|FrameworkReference|COMReference|PackageVersion)\b/i;
/** Windows Desktop (Windows Forms, WPF) or another shared framework than the two the index is generated from. */
const UNINDEXED_FRAMEWORK = /<(?:UseWPF|UseWindowsForms)>\s*true\s*<|<FrameworkReference\s[^>]*\bInclude\s*=\s*"(?!Microsoft\.(?:NETCore|AspNetCore)\.App")|\bSdk\s*=\s*"Microsoft\.NET\.Sdk\.WindowsDesktop"/i;

/**
 * What the project, its `Directory.Build.*` files or its SDK reference besides what the index lists: whether there are
 * such assemblies (`external`), and the first segments of the namespaces they may declare, taken from their names
 * (`Company.Shared.Logging` may declare `Company.*`). Packages often add to `System` and `Microsoft`, whatever their name.
 */
function referencesOf(project: WorkspaceProject): { external: boolean; namespaceRoots: ReadonlySet<string> | 'any' } {
  const texts: string[] = [];
  const read = (file: string): void => {
    try {
      texts.push(fs.readFileSync(file, 'utf8'));
    } catch {
      // A file that is not there adds nothing.
    }
  };

  read(project.projectFile);
  for (let directory = project.directory; ; directory = path.dirname(directory)) {
    for (const name of ['Directory.Build.props', 'Directory.Build.targets', 'Directory.Packages.props']) {
      read(path.join(directory, name));
    }

    if (path.dirname(directory) === directory) {
      break;
    }
  }

  const projectText = texts[0] ?? '';
  const packagesConfig = path.join(project.directory, 'packages.config');
  const external =
    texts.some((text) => UNINDEXED_FRAMEWORK.test(text) || EXTERNAL_REFERENCE.test(text)) ||
    // A project SDK other than the plain one brings its own references (web, Razor, MSTest, ...).
    /<Project\s[^>]*\bSdk\s*=\s*"(?!Microsoft\.NET\.Sdk")/i.test(projectText) ||
    fs.existsSync(packagesConfig);
  if (!external) {
    return { external, namespaceRoots: new Set() };
  }

  const names: string[] = [];
  for (const text of texts.map((candidate) => candidate.replace(/<!--[\s\S]*?-->/g, ''))) {
    for (const [, kind, attributes] of text.matchAll(/<(\w*Reference|PackageVersion)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
      if (/^COMReference$/i.test(kind)) {
        // A type library names its own namespaces.
        return { external, namespaceRoots: 'any' };
      }

      if (/^(?:PackageReference|GlobalPackageReference|PackageVersion|Reference|FrameworkReference)$/i.test(kind)) {
        names.push(...(/\bInclude\s*=\s*(["'])(.*?)\1/i.exec(attributes)?.[2] ?? '').split(';'));
      }
    }
  }

  for (const sdk of [/<Project\s[^>]*\bSdk\s*=\s*(["'])(.*?)\1/i.exec(projectText)?.[2] ?? '', ...[...projectText.matchAll(/<Sdk\s[^>]*\bName\s*=\s*(["'])(.*?)\1/gi)].map((match) => match[2])]) {
    names.push(...sdk.split(';').map((name) => name.split('/')[0]));
  }

  try {
    names.push(...[...fs.readFileSync(packagesConfig, 'utf8').matchAll(/<package\s[^>]*\bid\s*=\s*(["'])(.*?)\1/gi)].map((match) => match[2]));
  } catch {
    // No packages.config.
  }

  const roots = new Set(['system', 'microsoft']);
  for (const name of names.map((candidate) => candidate.split(',')[0].trim()).filter((candidate) => candidate !== '')) {
    if (/[$@%*?]/.test(name)) {
      return { external, namespaceRoots: 'any' };
    }

    roots.add(name.split('.')[0].toLowerCase());
  }

  return { external, namespaceRoots: roots };
}
