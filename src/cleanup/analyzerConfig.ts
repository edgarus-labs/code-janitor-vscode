import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AnalysisMode,
  FIRST_ANALYSIS_LEVEL,
  LATEST_ANALYSIS_LEVEL,
  PREVIEW_ANALYSIS_LEVEL,
  QUALITY_RULES_METADATA,
  qualityRuleSetSeverity,
  styleRuleSetSeverity,
} from './analyzerRules';
import { MSBuildProject, findProjectFile, readMSBuildProject } from './msbuildProperties';
import { ProjectSourceListing, listProjectSources } from './projectSources';
import { memoizeBySource } from './sourceCache';

/**
 * The project-level sources of analyzer severities, as the .NET SDK and the C# compiler apply them
 * (https://learn.microsoft.com/dotnet/fundamentals/code-analysis/configuration-files):
 *
 * - global AnalyzerConfig files: `.globalconfig` files in the folders above any compile item of the
 *   project (and above the source file and the project), one set for the whole project as in the
 *   SDK, unless `DiscoverGlobalAnalyzerConfigFiles` is `false`, and the
 *   `<GlobalAnalyzerConfigFiles>` items; for a key they disagree on, the higher `global_level` wins
 *   (`.globalconfig` files default to 100, others to 0) and equal levels drop the key. An
 *   `.editorconfig` entry wins over them.
 * - `AnalysisLevel`, `AnalysisMode` and their per-category variants (`AnalysisLevelPerformance`,
 *   `AnalysisModeStyle`, ...): the SDK's analysis-level rule sets, rule-specific entries that
 *   outrank bulk severities but not `dotnet_diagnostic.<id>.severity` entries.
 * - `NoWarn` turns a rule off whatever the configuration files say; `WarningsAsErrors`,
 *   `TreatWarningsAsErrors` (minus `WarningsNotAsErrors`) and `CodeAnalysisTreatWarningsAsErrors`
 *   report its warnings as errors.
 *
 * `EnforceCodeStyleInBuild` only decides whether `dotnet build` runs the code-style (IDE) rules;
 * the editor applies them either way, and so does cleanup.
 */
export interface ProjectAnalysis {
  /** Whether the project enables rules explicitly: an analysis mode of `Minimum`, `Recommended` or `All`. */
  readonly enablesRules: boolean;
  /** Whether `NoWarn` turns the rule off. */
  isSuppressed(diagnosticId: string): boolean;
  /** Whether a warning of this rule is reported as an error. */
  isWarningAsError(diagnosticId: string): boolean;
  /** The severity the analysis-level rule set of the project gives the rule, when it sets one. */
  ruleSetSeverity(diagnosticId: string): 'none' | 'warning' | 'error' | undefined;
  /**
   * The rule's own default severity, for the CA rules cleanup implements, when the .NET analyzers
   * run for the project; `undefined` otherwise.
   */
  defaultSeverity(diagnosticId: string): 'suggestion' | 'none' | undefined;
  /** Identifies the inputs of the methods above: two analyses with the same signature answer alike. */
  readonly signature: string;
}

export interface ProjectAnalyzerConfig {
  /** Global AnalyzerConfig entries (lower-cased keys), already resolved by `global_level`. */
  readonly entries: ReadonlyMap<string, string>;
  readonly analysis: ProjectAnalysis;
}

/** The analyzer configuration of the project `filePath` belongs to, or `undefined` without one. */
export function loadProjectAnalyzerConfig(filePath: string): ProjectAnalyzerConfig | undefined {
  const projectFile = findProjectFile(filePath);
  const project = projectFile ? readMSBuildProject(projectFile) : undefined;
  if (!project) {
    return undefined;
  }

  return { entries: globalConfigEntries(project, filePath), analysis: projectAnalysis(project) };
}

// ---------------------------------------------------------------------------------------------
// Global AnalyzerConfig files
// ---------------------------------------------------------------------------------------------

interface GlobalConfig {
  readonly isGlobal: boolean;
  readonly level: number | undefined;
  readonly entries: ReadonlyMap<string, string>;
}

/** The global part of a config file: the `key = value` lines before any section header. */
const parseGlobalConfig = memoizeBySource((text: string): GlobalConfig => {
  const entries = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      break;
    }

    const match = /^\s*([\w.\-]+)\s*[=:]\s*(.*?)\s*(?:[#;].*)?$/.exec(line);
    if (match && !/^\s*[#;]/.test(line)) {
      entries.set(match[1].toLowerCase(), match[2]);
    }
  }

  const level = entries.get('global_level');

  return {
    isGlobal: entries.get('is_global')?.toLowerCase() === 'true',
    level: level !== undefined && /^-?\d+$/.test(level) ? Number(level) : undefined,
    entries,
  };
}, 32);

function globalConfigEntries(project: MSBuildProject, filePath: string): Map<string, string> {
  const files = new Set<string>();
  if (project.property('DiscoverGlobalAnalyzerConfigFiles')?.toLowerCase() !== 'false') {
    // The SDK looks above every compile item (`@(Compile->GetPathsOfAllDirectoriesAbove())`). The folders
    // of a source listing are known per listing; only the folders above the file, the project and each
    // listing's root are looked at for every file.
    const starts = [path.dirname(path.resolve(filePath)), path.dirname(project.file)];
    for (const compile of compileFolders(project)) {
      if (typeof compile === 'string') {
        starts.push(compile);
      } else {
        globalConfigsInListing(compile).forEach((file) => files.add(file));
        starts.push(compile.root);
      }
    }

    const above = new Set<string>();
    for (const start of starts) {
      for (let directory = start; !above.has(directory); ) {
        above.add(directory);
        const parent = path.dirname(directory);
        if (parent === directory) {
          break;
        }

        directory = parent;
      }
    }

    for (const directory of above) {
      const candidate = path.join(directory, '.globalconfig');
      if (fs.existsSync(candidate)) {
        files.add(candidate);
      }
    }
  }

  project.items('GlobalAnalyzerConfigFiles').forEach((file) => files.add(file));

  // Per key: the value of the highest global_level; different values at the same level drop it.
  const best = new Map<string, { level: number; value: string | undefined }>();
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    const config = parseGlobalConfig(text);
    const conventional = path.basename(file).toLowerCase() === '.globalconfig';
    if (!config.isGlobal && !conventional) {
      continue;
    }

    const level = config.level ?? (conventional ? 100 : 0);
    for (const [key, value] of config.entries) {
      if (key === 'is_global' || key === 'global_level') {
        continue;
      }

      const current = best.get(key);
      if (!current || level > current.level) {
        best.set(key, { level, value });
      } else if (level === current.level && current.value !== value) {
        best.set(key, { level, value: undefined });
      }
    }
  }

  const entries = new Map<string, string>();
  for (const [key, { value }] of best) {
    if (value !== undefined) {
      entries.set(key, value);
    }
  }

  return entries;
}

/** The `.cs` files of a source listing that are compile items: all of them, or only those directly in `root`. */
interface CompileListing {
  readonly listing: ProjectSourceListing;
  readonly root: string;
  readonly recursive: boolean;
}

/**
 * Where the project's compile items are: a source listing for the default `.cs` items under the folder
 * of an SDK project and for each wildcard `<Compile Include>`, the folder of every other `<Compile Include>`.
 */
function compileFolders(project: MSBuildProject): (CompileListing | string)[] {
  const folders: (CompileListing | string)[] = [];
  const defaultItems = project.property('EnableDefaultItems')?.toLowerCase() !== 'false';
  if (project.sdkStyle && defaultItems && project.property('EnableDefaultCompileItems')?.toLowerCase() !== 'false') {
    const root = path.dirname(project.file);
    folders.push({ listing: listProjectSources(root), root, recursive: true });
  }

  for (const include of project.items('Compile')) {
    const segments = include.split(path.sep);
    const wildcard = segments.findIndex((segment) => /[*?]/.test(segment));
    if (wildcard < 0) {
      folders.push(path.dirname(include));
    } else {
      // `Shared\*.cs` reads one folder, `Shared\**\*.cs` (a wildcard in a folder segment) the whole tree.
      const root = path.resolve(segments.slice(0, wildcard).join(path.sep));
      folders.push({ listing: listProjectSources(root), root, recursive: wildcard < segments.length - 1 });
    }
  }

  return folders;
}

/**
 * The `.globalconfig` files in the folders of a listing that hold compile items or are above one. Adding
 * one changes its folder, which makes `listProjectSources` list again, so a listing's answer never changes.
 */
const globalConfigsByListing = new WeakMap<ProjectSourceListing, Map<string, readonly string[]>>();

function globalConfigsInListing({ listing, root, recursive }: CompileListing): readonly string[] {
  const key = `${recursive ? 'r' : 'f'}:${root}`;
  let byRoot = globalConfigsByListing.get(listing);
  const known = byRoot?.get(key);
  if (known) {
    return known;
  }

  const resolvedRoot = path.resolve(root);
  const folders = new Set<string>();
  for (const file of listing.files) {
    const folder = path.dirname(file);
    if (!recursive && folder !== resolvedRoot) {
      continue;
    }

    // Up to the listing's root: the folders above it are looked at for every file.
    for (let directory = folder; directory !== resolvedRoot && !folders.has(directory); directory = path.dirname(directory)) {
      folders.add(directory);
    }
  }

  const found = [...folders].map((folder) => path.join(folder, '.globalconfig')).filter((candidate) => fs.existsSync(candidate));
  byRoot ??= new Map();
  byRoot.set(key, found);
  globalConfigsByListing.set(listing, byRoot);

  return found;
}

// ---------------------------------------------------------------------------------------------
// AnalysisLevel / AnalysisMode and compiler warning options
// ---------------------------------------------------------------------------------------------

interface RuleSet {
  /** The analysis level (`undefined`: no rule set applies). */
  readonly level: number | undefined;
  readonly mode: AnalysisMode;
}

function projectAnalysis(project: MSBuildProject): ProjectAnalysis {
  const list = (name: string): Set<string> =>
    new Set(
      (project.property(name) ?? '')
        .split(/[;,]/)
        .map((entry) => entry.trim().toUpperCase())
        .filter(Boolean)
    );
  const flag = (name: string): boolean | undefined => {
    const value = project.property(name)?.toLowerCase();

    return value === 'true' ? true : value === 'false' ? false : undefined;
  };

  const noWarn = list('NoWarn');
  const warningsAsErrors = list('WarningsAsErrors');
  const warningsNotAsErrors = list('WarningsNotAsErrors');
  const treatWarningsAsErrors = flag('TreatWarningsAsErrors') === true;
  const codeAnalysisWarningsAsErrors = flag('CodeAnalysisTreatWarningsAsErrors');

  const analysisLevel = analysisLevelOf(project);
  const analyzersEnabled = netAnalyzersEnabled(project, analysisLevel);
  const categoryRuleSets = new Map<string, RuleSet>();
  const qualityRuleSet = (category: string): RuleSet => {
    let set = categoryRuleSets.get(category);
    if (!set) {
      set = ruleSet(project.property(`AnalysisLevel${category}`) || analysisLevel, project.property(`AnalysisMode${category}`) || project.property('AnalysisMode'));
      categoryRuleSets.set(category, set);
    }

    return set;
  };
  const styleRuleSet = styleRuleSetOf(project, analysisLevel);

  const enabling = (mode: AnalysisMode | undefined): boolean => mode === 'minimum' || mode === 'recommended' || mode === 'all';
  const categoryModes = Object.values(QUALITY_RULES_METADATA).map((rule) => qualityRuleSet(rule.category));
  const enablesRules = (analyzersEnabled && categoryModes.some((set) => set.level !== undefined && enabling(set.mode))) || enabling(styleRuleSet);
  const sorted = (set: Set<string>) => [...set].sort().join(';');
  const signature = [
    `nowarn=${sorted(noWarn)}`,
    `warnaserror=${sorted(warningsAsErrors)}`,
    `warnnotaserror=${sorted(warningsNotAsErrors)}`,
    `treatwarningsaserrors=${treatWarningsAsErrors}`,
    `codeanalysistreatwarningsaserrors=${codeAnalysisWarningsAsErrors}`,
    `analyzers=${analyzersEnabled}`,
    ...[...categoryRuleSets].sort(([a], [b]) => a.localeCompare(b)).map(([category, set]) => `ruleset.${category}=${set.level}/${set.mode}`),
    `stylemode=${styleRuleSet}`,
  ].join('\n');

  return {
    enablesRules,
    signature,
    isSuppressed: (id) => noWarn.has(id.toUpperCase()),
    isWarningAsError: (id) => {
      const upper = id.toUpperCase();
      if (warningsNotAsErrors.has(upper)) {
        return false;
      }

      // `CodeAnalysisTreatWarningsAsErrors=false` keeps the CA rules out of TreatWarningsAsErrors.
      const exempt = codeAnalysisWarningsAsErrors === false && QUALITY_RULES_METADATA[upper] !== undefined;

      return warningsAsErrors.has(upper) || (treatWarningsAsErrors && !exempt);
    },
    ruleSetSeverity: (id) => {
      const upper = id.toUpperCase();
      const rule = QUALITY_RULES_METADATA[upper];
      if (rule) {
        const set = qualityRuleSet(rule.category);
        const severity = analyzersEnabled && set.level !== undefined ? qualityRuleSetSeverity(rule, set.level, set.mode) : undefined;

        // `CodeAnalysisTreatWarningsAsErrors` selects the `_warnaserror` rule sets.
        return severity === 'warning' && codeAnalysisWarningsAsErrors === true ? 'error' : severity;
      }

      return /^IDE\d+$/.test(upper) && styleRuleSet ? styleRuleSetSeverity(upper, styleRuleSet) : undefined;
    },
    defaultSeverity: (id) => {
      const rule = QUALITY_RULES_METADATA[id.toUpperCase()];

      return rule && analyzersEnabled ? rule.defaultSeverity : undefined;
    },
  };
}

/** `AnalysisLevel` as set, else as the SDK implies it from a .NET 5+ target framework. */
function analysisLevelOf(project: MSBuildProject): string | undefined {
  const explicit = project.property('AnalysisLevel');
  if (explicit || !project.sdkStyle) {
    return explicit || undefined;
  }

  const majors = (project.property('TargetFrameworks') || project.property('TargetFramework') || '')
    .split(';')
    .map((framework) => /^net(\d+)\.\d+/i.exec(framework.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]))
    .filter((major) => major >= FIRST_ANALYSIS_LEVEL);

  // Multi-targeting projects are analyzed once per framework; the lowest one is the strictest guess.
  return majors.length > 0 ? String(Math.min(...majors)) : undefined;
}

/** The number of an `AnalysisLevel` prefix: `latest`, `preview`, `none` or a version. */
function levelNumber(prefix: string | undefined): number | undefined {
  const lower = prefix?.trim().toLowerCase();
  if (!lower) {
    return undefined;
  }

  if (lower === 'latest') {
    return LATEST_ANALYSIS_LEVEL;
  }

  if (lower === 'preview') {
    return PREVIEW_ANALYSIS_LEVEL;
  }

  if (lower === 'none') {
    return 4;
  }

  const match = /^(\d+)(?:\.0)*$/.exec(lower);

  return match ? Number(match[1]) : undefined;
}

/** Splits `<level>-<mode>` compound `AnalysisLevel` values. */
function splitLevel(value: string | undefined): { prefix: string | undefined; suffix: string | undefined } {
  const dash = value?.indexOf('-') ?? -1;

  return dash < 0 ? { prefix: value, suffix: undefined } : { prefix: value?.slice(0, dash), suffix: value?.slice(dash + 1) };
}

function modeOf(raw: string | undefined): AnalysisMode {
  const lower = raw?.trim().toLowerCase();
  if (lower === 'allenabledbydefault') {
    return 'all';
  }

  if (lower === 'alldisabledbydefault') {
    return 'none';
  }

  return lower === 'none' || lower === 'minimum' || lower === 'recommended' || lower === 'all' ? lower : 'default';
}

/** The CA rule set of an `AnalysisLevel` value and `AnalysisMode`; the level's suffix wins. */
function ruleSet(levelValue: string | undefined, modeValue: string | undefined): RuleSet {
  const { prefix, suffix } = splitLevel(levelValue);

  return { level: levelNumber(prefix), mode: modeOf(suffix || modeValue) };
}

/**
 * The code-style rule set, which the SDK only applies when `AnalysisLevelStyle` or
 * `AnalysisModeStyle` differ from `AnalysisLevel`/`AnalysisMode`, or from analysis level 11.
 */
function styleRuleSetOf(project: MSBuildProject, analysisLevel: string | undefined): AnalysisMode | undefined {
  const levelStyle = project.property('AnalysisLevelStyle') || analysisLevel;
  const modeStyle = project.property('AnalysisModeStyle') || project.property('AnalysisMode');
  const applies =
    (levelStyle ?? '') !== (analysisLevel ?? '') ||
    (modeStyle ?? '') !== (project.property('AnalysisMode') ?? '') ||
    (levelNumber(splitLevel(levelStyle).prefix) ?? 0) >= PREVIEW_ANALYSIS_LEVEL;
  if (!applies) {
    return undefined;
  }

  return modeOf(modeStyle || splitLevel(levelStyle).suffix || splitLevel(analysisLevel).suffix);
}

/**
 * Whether the .NET analyzers run: `EnableNETAnalyzers` when set, else a reference to the
 * Microsoft.CodeAnalysis.NetAnalyzers package, else an analysis level of 5 or more.
 */
function netAnalyzersEnabled(project: MSBuildProject, analysisLevel: string | undefined): boolean {
  const explicit = project.property('EnableNETAnalyzers')?.toLowerCase();
  if (explicit === 'true' || explicit === 'false') {
    return explicit === 'true';
  }

  if (project.hasPackage('Microsoft.CodeAnalysis.NetAnalyzers')) {
    return true;
  }

  const level = levelNumber(splitLevel(analysisLevel).prefix);

  return project.sdkStyle && level !== undefined && level >= FIRST_ANALYSIS_LEVEL;
}
