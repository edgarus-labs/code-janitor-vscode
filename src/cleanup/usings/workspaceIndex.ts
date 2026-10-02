import * as fs from 'node:fs';
import * as path from 'node:path';
import { WorkspaceProject, discoverProjects } from '../naming/workspaceScope';
import { DeclarationAggregate, DeclarationIndex, FileSummary, summarizeDeclarations } from './declarations';

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
    index: cached.aggregate.view(own, summarizeDeclarations(source)),
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

  const projects = referencedProjects(projectFile);
  const aggregate = new DeclarationAggregate();
  const summaries = new Map<string, FileSummary>();
  const problems: string[] = [];
  let externalReferences = false;

  // The SDK writes the implicit usings of the project into a generated file; they are global usings like the written ones.
  const implicitUsings = implicitUsingsOf(projects[0]);
  if (implicitUsings.namespaces.length > 0) {
    aggregate.add({ keys: new Set(implicitUsings.namespaces.map((namespace) => `G:${namespace.split('.').join(' . ')}`)) });
  }

  if (implicitUsings.problem) {
    problems.push(implicitUsings.problem);
  }

  for (const project of projects) {
    if (project.problem) {
      problems.push(project.problem);
    }

    externalReferences ||= hasExternalReferences(project);
    for (const file of project.csharpFiles) {
      const summary = summaryOf(file);
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
    ...(problems.length > 0 ? { incomplete: problems.join('; ') } : {}),
  };
  projectCache.set(projectFile, project);

  return project;
}

/** `projectFile` and the projects it references, directly or through other projects. */
function referencedProjects(projectFile: string): WorkspaceProject[] {
  const result: WorkspaceProject[] = [];
  const seen = new Set<string>();
  const pending: { file: string; depth: number }[] = [{ file: projectFile, depth: 0 }];
  while (pending.length > 0) {
    const { file, depth } = pending.pop() as { file: string; depth: number };
    if (seen.has(file)) {
      continue;
    }

    seen.add(file);
    const project = discoverProjects([path.dirname(file)]).find((candidate) => candidate.projectFile === file);
    if (!project) {
      continue;
    }

    result.push(project);
    if (depth < MAX_REFERENCE_DEPTH) {
      for (const reference of project.references) {
        pending.push({ file: reference, depth: depth + 1 });
      }
    }
  }

  return result;
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

/** The namespaces the SDK imports for `<ImplicitUsings>enable</ImplicitUsings>` (project, `Directory.Build.props`/`.targets`), none when it is off. */
function implicitUsingsOf(project: WorkspaceProject | undefined): { namespaces: string[]; problem?: string } {
  if (!project) {
    return { namespaces: [] };
  }

  const texts: string[] = [];
  for (let directory = project.directory; ; directory = path.dirname(directory)) {
    for (const name of ['Directory.Build.props', 'Directory.Build.targets']) {
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

  let projectText = '';
  try {
    projectText = fs.readFileSync(project.projectFile, 'utf8');
  } catch {
    return { namespaces: [] };
  }

  texts.push(projectText);
  const values = texts.flatMap((text) => [...text.matchAll(/<ImplicitUsings>\s*([^<\s]*)\s*<\/ImplicitUsings>/gi)].map((match) => match[1].toLowerCase()));
  const enabled = values.length > 0 && (values[values.length - 1] === 'enable' || values[values.length - 1] === 'true');
  if (!enabled) {
    return { namespaces: [] };
  }

  const sdk = /<Project\s[^>]*\bSdk\s*=\s*"([^"]+)"/i.exec(projectText)?.[1] ?? 'Microsoft.NET.Sdk';
  const extra = IMPLICIT_USINGS[sdk];

  return {
    namespaces: [...IMPLICIT_USINGS['Microsoft.NET.Sdk'], ...(sdk === 'Microsoft.NET.Sdk' ? [] : (extra ?? []))],
    ...(extra === undefined ? { problem: `the implicit usings of the SDK ${sdk} are not known` } : {}),
  };
}

const EXTERNAL_REFERENCE = /<(?:PackageReference|Reference|FrameworkReference|COMReference|PackageVersion)\b/i;

/** True when the project, its `Directory.Build.*` files or its SDK add assemblies the index does not list. */
function hasExternalReferences(project: WorkspaceProject): boolean {
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

  return (
    texts.some((text) => EXTERNAL_REFERENCE.test(text)) ||
    // A project SDK other than the plain one brings its own references (web, Razor, MSTest, ...).
    /<Project\s[^>]*\bSdk\s*=\s*"(?!Microsoft\.NET\.Sdk")/i.test(texts[0] ?? '') ||
    fs.existsSync(path.join(project.directory, 'packages.config'))
  );
}
