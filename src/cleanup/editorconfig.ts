import * as fs from 'node:fs';
import * as path from 'node:path';
import { ProjectAnalysis, loadProjectAnalyzerConfig } from './analyzerConfig';
import { memoizeBySource } from './sourceCache';

export type EditorConfigSeverity = 'none' | 'silent' | 'suggestion' | 'warning' | 'error';

/** The properties that apply to one file after every matching `.editorconfig` section is folded in. */
export interface EditorConfigProperties {
  /** Looks up a property by (case-insensitive) key; the nearest file and the later section win. */
  get(key: string): string | undefined;
  readonly entries: ReadonlyMap<string, string>;
  /** The severity settings of the file's project (MSBuild properties); absent without a project. */
  readonly analysis?: ProjectAnalysis;
}

export interface EditorConfigFile {
  /** Directory containing the `.editorconfig` file; section globs are relative to it. */
  readonly directory: string;
  readonly text: string;
}

/**
 * Resolves the analyzer configuration for `filePath` from the files on disk: every `.editorconfig`
 * from the file's directory up to (and including) the first one declaring `root = true`, over the
 * global AnalyzerConfig files (`.globalconfig`, `<GlobalAnalyzerConfigFiles>`) of its project, plus
 * the project's severity settings (see {@link loadProjectAnalyzerConfig}). An unreadable file is
 * skipped; it must never fail the cleanup.
 */
export function loadEditorConfigProperties(filePath: string): EditorConfigProperties {
  if (!filePath || !filePath.trim()) {
    return new PropertyMap(new Map());
  }

  const files: EditorConfigFile[] = [];
  let directory = path.dirname(path.resolve(filePath));

  for (;;) {
    const configPath = path.join(directory, '.editorconfig');
    const text = tryReadFile(configPath);
    if (text !== undefined) {
      files.unshift({ directory, text });
      if (parseEditorConfig(text).isRoot) {
        break;
      }
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      break;
    }

    directory = parent;
  }

  const editorConfig = resolveEditorConfigProperties(files, filePath);
  const project = loadProjectAnalyzerConfig(filePath);
  if (!project) {
    return editorConfig;
  }

  // An `.editorconfig` entry wins over a global one for the same key.
  const entries = new Map(project.entries);
  for (const [key, value] of editorConfig.entries) {
    entries.set(key, value);
  }

  return new PropertyMap(entries, project.analysis);
}

/**
 * Pure resolver: folds `files` (ordered root-most first) into the properties applying to
 * `filePath`, following the EditorConfig specification. Files above the nearest one declaring
 * `root = true` are ignored, properties in the preamble (before the first section) other than
 * `root` are ignored, a nearer file overrides a farther one and a later section overrides an
 * earlier one. The value `unset` removes a property.
 */
export function resolveEditorConfigProperties(
  files: readonly EditorConfigFile[],
  filePath: string
): EditorConfigProperties {
  const entries = new Map<string, string>();
  if (!filePath || !filePath.trim()) {
    return new PropertyMap(entries);
  }

  const parsedFiles = files.map((file) => ({ directory: file.directory, parsed: parseEditorConfig(file.text) }));
  let first = 0;
  for (let index = parsedFiles.length - 1; index >= 0; index--) {
    if (parsedFiles[index].parsed.isRoot) {
      first = index;
      break;
    }
  }

  const absoluteFile = path.resolve(filePath);
  for (const { directory, parsed } of parsedFiles.slice(first)) {
    const relative = relativeUnixPath(path.resolve(directory), absoluteFile);
    if (relative === undefined) {
      continue;
    }

    for (const section of parsed.sections) {
      if (!section.matcher || !section.matcher(relative)) {
        continue;
      }

      for (const [key, value] of section.properties) {
        if (value.toLowerCase() === 'unset') {
          entries.delete(key);
        } else {
          entries.set(key, value);
        }
      }
    }
  }

  return new PropertyMap(entries);
}

// Severity names as Roslyn reads them from `.editorconfig`.
const severityByName: Record<string, EditorConfigSeverity> = {
  none: 'none',
  silent: 'silent',
  refactoring: 'silent',
  suggestion: 'suggestion',
  warn: 'warning',
  warning: 'warning',
  error: 'error',
};

/** Parses a severity name as Roslyn reads it from `.editorconfig`; unknown names yield `undefined`. */
export function parseSeverity(raw: string | undefined): EditorConfigSeverity | undefined {
  const name = raw?.trim().toLowerCase();

  return name !== undefined && Object.hasOwn(severityByName, name) ? severityByName[name] : undefined;
}

/**
 * Splits a code-style option value written as `value:severity`. The suffix is only treated as a
 * severity when it names one; otherwise the whole text is the value.
 */
export function splitOptionSeverity(raw: string): { value: string; severity?: EditorConfigSeverity } {
  const colon = raw.lastIndexOf(':');
  if (colon >= 0) {
    const severity = parseSeverity(raw.slice(colon + 1));
    if (severity) {
      return { value: raw.slice(0, colon).trim(), severity };
    }
  }

  return { value: raw.trim() };
}

/**
 * Effective severity of a diagnostic, with Roslyn's precedence:
 *
 * 1. `NoWarn` of the project turns it off;
 * 2. `dotnet_diagnostic.<id>.severity` (`.editorconfig`, then global config files; `default` keeps
 *    the option's own severity, else the rule's default);
 * 3. the analysis-level rule set of the project (`AnalysisLevel`/`AnalysisMode`);
 * 4. `dotnet_analyzer_diagnostic.category-<category>.severity`, then
 *    `dotnet_analyzer_diagnostic.severity`;
 * 5. the severity the option itself carries (`option = value:severity`, or a naming rule's);
 * 6. with `includeRuleDefault`, the rule's own default where the .NET analyzers run (CA rules).
 *
 * A resulting `warning` is an `error` under `WarningsAsErrors`/`TreatWarningsAsErrors`. IDE
 * code-style and naming diagnostics use the `Style` category, the default here. Cleanup passes
 * `includeRuleDefault = false`: an implicit default never triggers a rewrite by itself.
 */
export function resolveDiagnosticSeverity(
  props: EditorConfigProperties,
  diagnosticId: string,
  optionSeverity?: EditorConfigSeverity,
  category = 'Style',
  includeRuleDefault = true
): EditorConfigSeverity | undefined {
  const analysis = props.analysis;
  if (analysis?.isSuppressed(diagnosticId)) {
    return 'none';
  }

  const ruleDefault = includeRuleDefault ? analysis?.defaultSeverity(diagnosticId) : undefined;
  const severity = configuredSeverity(props, diagnosticId, optionSeverity, category) ?? ruleDefault;

  return severity === 'warning' && analysis?.isWarningAsError(diagnosticId) ? 'error' : severity;
}

function configuredSeverity(
  props: EditorConfigProperties,
  diagnosticId: string,
  optionSeverity: EditorConfigSeverity | undefined,
  category: string
): EditorConfigSeverity | undefined {
  const specific = props.get(`dotnet_diagnostic.${diagnosticId}.severity`);
  if (specific !== undefined) {
    if (specific.trim().toLowerCase() === 'default') {
      return optionSeverity ?? props.analysis?.defaultSeverity(diagnosticId);
    }

    const severity = parseSeverity(specific);
    if (severity) {
      return severity;
    }
  }

  const ruleSet = props.analysis?.ruleSetSeverity(diagnosticId);
  if (ruleSet) {
    return ruleSet;
  }

  const bulk =
    parseSeverity(props.get(`dotnet_analyzer_diagnostic.category-${category}.severity`)) ??
    parseSeverity(props.get('dotnet_analyzer_diagnostic.severity'));

  return bulk ?? optionSeverity;
}

/**
 * Whether analyzer configuration applies to the file: `.editorconfig` or global config entries, or
 * rule sets the project enables explicitly (`AnalysisMode` `Minimum`, `Recommended` or `All`).
 */
export function hasAnalyzerConfiguration(props: EditorConfigProperties): boolean {
  return props.entries.size > 0 || props.analysis?.enablesRules === true;
}

/** Only `suggestion`, `warning` and `error` rules are applied by cleanup. */
export function isEnforced(severity: EditorConfigSeverity | undefined): boolean {
  return severity === 'suggestion' || severity === 'warning' || severity === 'error';
}

class PropertyMap implements EditorConfigProperties {
  constructor(
    readonly entries: ReadonlyMap<string, string>,
    readonly analysis?: ProjectAnalysis
  ) {}

  get(key: string): string | undefined {
    return this.entries.get(key.toLowerCase());
  }
}

interface ParsedSection {
  readonly matcher: ((relativePath: string) => boolean) | undefined;
  readonly properties: [string, string][];
}

interface ParsedEditorConfig {
  readonly isRoot: boolean;
  readonly sections: ParsedSection[];
}

// Line grammar as Roslyn's AnalyzerConfig parses it: `#`/`;` start comments, including trailing
// ones; keys are lower-cased and separated from the value by `=` or `:`.
const sectionPattern = /^\s*\[((?:[^#;]|\\#|\\;)+)\]\s*(?:[#;].*)?$/;
const propertyPattern = /^\s*([\w.\-]+)\s*[=:]\s*(.*?)\s*(?:[#;].*)?$/;
const commentPattern = /^\s*[#;]/;

/**
 * The sections of one `.editorconfig` text, with their compiled globs. The files are read for every
 * cleaned file (so edits apply at once), but the same text is parsed only once.
 */
const parseEditorConfig: (text: string) => ParsedEditorConfig = memoizeBySource(parseEditorConfigText, 16);

function parseEditorConfigText(text: string): ParsedEditorConfig {
  const sections: ParsedSection[] = [];
  let isRoot = false;
  let current: ParsedSection | undefined;

  for (const line of text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
    if (!line.trim() || commentPattern.test(line)) {
      continue;
    }

    const section = sectionPattern.exec(line);
    if (section) {
      current = { matcher: compileSectionMatcher(section[1]), properties: [] };
      sections.push(current);
      continue;
    }

    const property = propertyPattern.exec(line);
    if (!property) {
      continue;
    }

    const key = property[1].toLowerCase();
    const value = property[2];
    if (current) {
      current.properties.push([key, value]);
    } else if (key === 'root') {
      isRoot = value.toLowerCase() === 'true';
    }
  }

  return { isRoot, sections };
}

function relativeUnixPath(directory: string, filePath: string): string | undefined {
  const relative = path.relative(directory, filePath);
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    return undefined;
  }

  return relative.split(path.sep).join('/');
}

/**
 * Compiles an EditorConfig section glob into a matcher over the file path relative to the
 * `.editorconfig` directory (with `/` separators). Supports `*`, `**`, `?`, `[set]`, `[!set]`,
 * `{a,b}` (nestable), `{n..m}` and `\` escapes. A glob without `/` matches the file name at any
 * depth; a glob with `/` is anchored at the `.editorconfig` directory. Matching is case-sensitive.
 */
export function compileSectionMatcher(glob: string): ((relativePath: string) => boolean) | undefined {
  const ranges: [number, number][] = [];
  let pattern: string;

  try {
    const hasSlash = containsSeparator(glob);
    const body = convertGlob(hasSlash && glob.startsWith('/') ? glob.slice(1) : glob, ranges);
    pattern = hasSlash ? `^${body}$` : `^(?:.*/)?${body}$`;
  } catch {
    return undefined;
  }

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, 's');
  } catch {
    return undefined;
  }

  return (relativePath) => {
    const match = regex.exec(relativePath);
    if (!match) {
      return false;
    }

    for (let group = 0; group < ranges.length; group++) {
      const captured = match[group + 1];
      if (captured === undefined) {
        continue;
      }

      const value = Number.parseInt(captured, 10);
      const [low, high] = ranges[group];
      if (value < low || value > high) {
        return false;
      }
    }

    return true;
  };
}

/** A glob with a `/` outside brackets is anchored at the `.editorconfig` directory. */
function containsSeparator(glob: string): boolean {
  let index = 0;
  while (index < glob.length) {
    const ch = glob[index];
    if (ch === '\\') {
      index += 2;
      continue;
    }

    if (ch === '[') {
      const close = findBracketEnd(glob, index);
      if (close > 0) {
        index = close + 1;
        continue;
      }
    }

    if (ch === '/') {
      return true;
    }

    index++;
  }

  return false;
}

function convertGlob(glob: string, ranges: [number, number][]): string {
  let result = '';
  let index = 0;

  while (index < glob.length) {
    const ch = glob[index];

    if (ch === '\\') {
      if (index + 1 < glob.length) {
        result += escapeRegex(glob[index + 1]);
        index += 2;
      } else {
        result += '\\\\';
        index++;
      }
      continue;
    }

    if (ch === '*') {
      if (glob[index + 1] === '*') {
        // `**/` at the start or `/**/` in the middle also match zero directories.
        const atSegmentStart = index === 0 || glob[index - 1] === '/';
        if (atSegmentStart && glob[index + 2] === '/') {
          result += '(?:.*/)?';
          index += 3;
        } else {
          result += '.*';
          index += 2;
        }
      } else {
        result += '[^/]*';
        index++;
      }
      continue;
    }

    if (ch === '?') {
      result += '[^/]';
      index++;
      continue;
    }

    if (ch === '[') {
      const close = findBracketEnd(glob, index);
      if (close < 0) {
        result += '\\[';
        index++;
        continue;
      }

      result += convertBracket(glob.slice(index + 1, close));
      index = close + 1;
      continue;
    }

    if (ch === '{') {
      const close = findBraceEnd(glob, index);
      if (close < 0) {
        result += '\\{';
        index++;
        continue;
      }

      const content = glob.slice(index + 1, close);
      const range = /^([+-]?\d+)\.\.([+-]?\d+)$/.exec(content);
      if (range) {
        const a = Number.parseInt(range[1], 10);
        const b = Number.parseInt(range[2], 10);
        ranges.push([Math.min(a, b), Math.max(a, b)]);
        result += '([+-]?\\d+)';
        index = close + 1;
        continue;
      }

      const alternatives = splitAlternatives(content);
      if (alternatives.length < 2) {
        // `{single}` is not a choice: the braces are literal.
        result += '\\{';
        index++;
        continue;
      }

      result += `(?:${alternatives.map((alternative) => convertGlob(alternative, ranges)).join('|')})`;
      index = close + 1;
      continue;
    }

    result += escapeRegex(ch);
    index++;
  }

  return result;
}

/** Index of the `]` closing the bracket expression opened at `open`, or -1 (then `[` is literal). */
function findBracketEnd(glob: string, open: number): number {
  let index = open + 1;
  if (glob[index] === '!' || glob[index] === '^') {
    index++;
  }

  if (glob[index] === ']') {
    index++;
  }

  for (; index < glob.length; index++) {
    const ch = glob[index];
    if (ch === '\\') {
      index++;
      continue;
    }

    if (ch === '/') {
      return -1;
    }

    if (ch === ']') {
      return index;
    }
  }

  return -1;
}

function convertBracket(content: string): string {
  let negate = false;
  let index = 0;
  if (content[0] === '!' || content[0] === '^') {
    negate = true;
    index = 1;
  }

  let body = '';
  for (; index < content.length; index++) {
    const ch = content[index];
    if (ch === '\\' && index + 1 < content.length) {
      body += `\\${content[++index]}`;
    } else if (ch === '-' && body && index + 1 < content.length) {
      body += '-';
    } else {
      body += /[\\\]\[^-]/.test(ch) ? `\\${ch}` : ch;
    }
  }

  return negate ? `[^/${body}]` : `[${body}]`;
}

function findBraceEnd(glob: string, open: number): number {
  let depth = 0;
  for (let index = open; index < glob.length; index++) {
    const ch = glob[index];
    if (ch === '\\') {
      index++;
      continue;
    }

    if (ch === '[') {
      const close = findBracketEnd(glob, index);
      if (close > 0) {
        index = close;
        continue;
      }
    }

    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function splitAlternatives(content: string): string[] {
  const alternatives: string[] = [];
  let depth = 0;
  let start = 0;

  for (let index = 0; index < content.length; index++) {
    const ch = content[index];
    if (ch === '\\') {
      index++;
      continue;
    }

    if (ch === '[') {
      const close = findBracketEnd(content, index);
      if (close > 0) {
        index = close;
        continue;
      }
    }

    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
    } else if (ch === ',' && depth === 0) {
      alternatives.push(content.slice(start, index));
      start = index + 1;
    }
  }

  alternatives.push(content.slice(start));

  return alternatives;
}

function escapeRegex(ch: string): string {
  return /[.*+?^${}()|[\]\\/]/.test(ch) ? `\\${ch}` : ch;
}

function tryReadFile(filePath: string): string | undefined {
  try {
    return fs.statSync(filePath).isFile() ? fs.readFileSync(filePath, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}
