import * as path from 'node:path';
import { resolveEffectiveCleanupSettings } from './effectiveSettings';
import { diagnosticSeverity } from './editorConfigRegistry';
import { EditorConfigProperties, EditorConfigSeverity, loadEditorConfigProperties, parseSeverity } from './editorconfig';
import { LineHunk, applyLineHunks, diffLineHunks } from './lineDiff';
import { parseNamingRules } from './naming/namingRules';
import { planRename } from './naming/renamer';
import { buildSourceModel } from './naming/sourceModel';
import { planOneTypePerFile, readOneTypePerFileRules } from './oneTypePerFile';
import { applyEdits } from './parser';
import { getCleanupPipeline } from './runCleanup';
import { listTopLevelTypes } from './topLevelTypeSplit';
import { findNamingViolations } from './transformations/editorConfigNaming';
import { parseErrorCount } from './transformations/editorConfigSupport';
import { CleanupSettings, SourceTransformation } from './types';

/**
 * Cleanup in "analyze" mode: what cleanup would change in a file and which enforced
 * `.editorconfig` rules it cannot fix, located in the file (diagnostics, the check command), and
 * the fixes of one rule (quick fixes). Nothing here writes files.
 */

const NAMING_DIAGNOSTIC_ID = 'IDE1006';

export interface CleanupFinding {
  /** The rule's diagnostic id(s), `IDE0090` or `IDE0007/IDE0008`; none for a Code Janitor setting. */
  readonly ruleId?: string;
  /** The diagnostic id(s), or the name of the Code Janitor setting's step. */
  readonly rule: string;
  /** The rule's effective `.editorconfig` severity. */
  readonly severity?: EditorConfigSeverity;
  /** First and last line (0-based, inclusive) of the analyzed text. */
  readonly startLine: number;
  readonly endLine: number;
  /** Columns on the first/last line, when the finding is one name. */
  readonly startCharacter?: number;
  readonly endCharacter?: number;
  /** True when the finding concerns the whole file (a note without a line). */
  readonly fileLevel?: boolean;
  readonly message: string;
  /** Cleanup would change the file here. */
  readonly wouldChange: boolean;
  /** A quick fix can change it: the rule applies alone (a type moved to its own file needs a cleanup command). */
  readonly fixable: boolean;
  /** IDE1006: the symbol a fix of this occurrence renames. */
  readonly symbol?: { readonly name: string; readonly newName: string };
}

export interface CleanupAnalysis {
  readonly findings: readonly CleanupFinding[];
  /** The `.editorconfig` settings cleanup does not apply. */
  readonly unsupported: readonly string[];
  /** What the steps of Code Janitor settings left undone and why: notes, not `.editorconfig` violations. */
  readonly notes: readonly string[];
}

export interface AnalysisOptions {
  readonly disqualifiedTypeNames?: ReadonlySet<string>;
  /** The `.cs` file names of the file's folder: with them, the types one type per file would move are found too. */
  readonly siblingFileNames?: ReadonlySet<string>;
}

/** Runs cleanup on `source` step by step and records, per rule, where it changes the text or what it cannot fix. */
export function analyzeCleanup(source: string, filePath: string, settings: CleanupSettings, options: AnalysisOptions = {}): CleanupAnalysis {
  // With the enabled Code Style rules layered on top, so their findings carry the `suggestion` severity they apply with.
  const props = resolveEffectiveCleanupSettings(filePath, settings).properties;
  const unsupported: string[] = [];
  const notes: string[] = [];
  const issues: string[] = [];
  let collecting = false;
  const pipeline = getCleanupPipeline(source, filePath, settings, options.disqualifiedTypeNames, (issue) => {
    if (issue.kind === 'unsupported') {
      unsupported.push(issue.detail);
    } else if (collecting) {
      issues.push(issue.detail);
    }
  });

  const findings: CleanupFinding[] = options.siblingFileNames ? oneTypePerFileFindings(source, filePath, props, options.siblingFileNames) : [];
  const lastLine = source.split('\n').length - 1;
  let current = source;
  for (const step of pipeline.transformations) {
    issues.length = 0;
    collecting = true;
    const full = step.applyRules?.(current, new Set());
    const output = full ? full.output : step.apply(current);
    collecting = false;
    const stepIssues = [...issues];
    const toSource = lineMapper(source, current);
    const at = (start: number, end: number) => {
      const [first] = toSource(start);
      const [, last] = toSource(end);

      return { startLine: Math.min(first, lastLine), endLine: Math.min(Math.max(first, last), lastLine) };
    };

    if (output !== current) {
      if (full) {
        for (const rule of full.rules.filter((candidate) => candidate.included && candidate.changes > 0)) {
          const ruleOutput = full.rules.length === 1 ? output : applyStepRule(step, current, rule.id);
          findings.push(...changeFindings(current, ruleOutput, rule.id, diagnosticSeverity(props, rule.id), at));
        }
      } else if (step.diagnosticId === NAMING_DIAGNOSTIC_ID) {
        findings.push(...namingFindings(current, props, stepIssues, at));
      } else {
        const severity = step.diagnosticId ? diagnosticSeverity(props, step.diagnosticId) : undefined;
        findings.push(...changeFindings(current, output, step.diagnosticId, severity, at, step.name));
      }
    }

    // Only the `.editorconfig` steps (one diagnostic, or rules) enforce rules; other steps are Code Janitor settings.
    if (step.diagnosticId || step.applyRules) {
      findings.push(...stepIssues.map((detail) => issueFinding(detail, props, at)));
    } else {
      notes.push(...stepIssues);
    }

    current = output;
  }

  return { findings, unsupported, notes };
}

/**
 * `source` with only the rule `ruleId` applied (a step's diagnostic id, or one rule of a step made
 * of rules), as its quick fix "Fix all in file" does. `source` when no step has the rule.
 */
export function applyRuleOnly(
  source: string,
  filePath: string,
  settings: CleanupSettings,
  ruleId: string,
  disqualifiedTypeNames?: ReadonlySet<string>
): string {
  for (const step of getCleanupPipeline(source, filePath, settings, disqualifiedTypeNames).transformations) {
    if (step.diagnosticId === ruleId) {
      return step.apply(source);
    }

    if (step.applyRules?.(source, new Set()).rules.some((rule) => rule.id === ruleId)) {
      return applyStepRule(step, source, ruleId);
    }
  }

  return source;
}

/**
 * `source` with only the occurrence `finding` fixed, or `undefined` when that cannot be proven safe:
 * a rename of the one symbol, or the changes of the rule's fix at the finding's lines, kept only when
 * the code parses as well as before and fixing the rest of the file afterwards gives exactly the
 * rule's fix of the whole file (so the occurrence does not depend on changes left out).
 */
export function fixFindingOccurrence(
  source: string,
  filePath: string,
  settings: CleanupSettings,
  finding: CleanupFinding,
  disqualifiedTypeNames?: ReadonlySet<string>
): string | undefined {
  if (!finding.fixable || !finding.ruleId) {
    return undefined;
  }

  if (finding.symbol) {
    return renameOccurrence(source, filePath, finding.startLine, finding.symbol);
  }

  const fixed = applyRuleOnly(source, filePath, settings, finding.ruleId, disqualifiedTypeNames);
  const hunks = diffLineHunks(source, fixed);
  const lastLine = source.split('\n').length - 1;
  const selected = hunks.filter((hunk) => {
    const [start, end] = anchorLines(hunk, lastLine);

    return start <= finding.endLine && end >= finding.startLine;
  });
  if (selected.length === 0) {
    return undefined;
  }

  if (selected.length === hunks.length) {
    return fixed;
  }

  const partial = applyLineHunks(source, fixed, selected);
  if (parseErrorCount(partial) > parseErrorCount(source)) {
    return undefined;
  }

  return applyRuleOnly(partial, filePath, settings, finding.ruleId, disqualifiedTypeNames) === fixed ? partial : undefined;
}

/** A step's output with only the rule `ruleId` of it: the other rules are left out until none changes anything. */
export function applyStepRule(step: SourceTransformation, source: string, ruleId: string): string {
  if (!step.applyRules) {
    return step.apply(source);
  }

  const excluded = new Set<string>();
  for (;;) {
    const { output, rules } = step.applyRules(source, excluded);
    const others = rules.filter((rule) => rule.id !== ruleId && rule.included && rule.changes > 0);
    if (others.length === 0) {
      return output;
    }

    others.forEach((rule) => excluded.add(rule.id));
  }
}

type Locate = (start: number, end: number) => { readonly startLine: number; readonly endLine: number };

/** One finding per place (adjacent changed lines together) where `after` differs from `before`. */
function changeFindings(
  before: string,
  after: string,
  ruleId: string | undefined,
  severity: EditorConfigSeverity | undefined,
  at: Locate,
  stepName?: string
): CleanupFinding[] {
  const afterLines = after.split('\n');
  const lastLine = before.split('\n').length - 1;
  const places: { start: number; end: number; hunks: LineHunk[] }[] = [];
  for (const hunk of diffLineHunks(before, after)) {
    const [start, end] = anchorLines(hunk, lastLine);
    const previous = places[places.length - 1];
    if (previous && start <= previous.end + 1) {
      previous.end = Math.max(previous.end, end);
      previous.hunks.push(hunk);
    } else {
      places.push({ start, end, hunks: [hunk] });
    }
  }

  return places.map(({ start, end, hunks }) => {
    const writtenLines = hunks.flatMap((hunk) => afterLines.slice(hunk.afterStart, hunk.afterEnd));
    const written = writtenLines.find((line) => line.trim() !== '');
    const removed = hunks.reduce((count, hunk) => count + hunk.beforeEnd - hunk.beforeStart, 0);
    const change =
      written !== undefined
        ? `would change this to: ${abbreviate(written.trim())}`
        : removed === 0
          ? `would insert ${writtenLines.length} blank line(s)`
          : `would remove ${removed} line(s)`;

    return {
      ruleId,
      rule: ruleId ?? stepName ?? 'Cleanup',
      severity,
      ...at(start, end),
      // `rule` names the step already.
      message: `Code Janitor ${change}`,
      wouldChange: true,
      fixable: ruleId !== undefined,
    };
  });
}

/** IDE1006: the violations the naming step renames, at the declared name; the others are reported as issues. */
function namingFindings(before: string, props: EditorConfigProperties, stepIssues: readonly string[], at: Locate): CleanupFinding[] {
  const unresolved = new Set(
    stepIssues.flatMap((detail) => {
      const match = / line (\d+): .*?'([^']+)' should be named/.exec(detail);

      return match ? [`${Number(match[1]) - 1}:${match[2]}`] : [];
    })
  );

  return findNamingViolations(buildSourceModel(before), parseNamingRules(props), props).flatMap((violation): CleanupFinding[] => {
    const { symbol, newName, severity, rule } = violation;
    const start = symbol.nameNode.startPosition;
    if (unresolved.has(`${start.row}:${symbol.name}`)) {
      return [];
    }

    return [
      {
        ruleId: NAMING_DIAGNOSTIC_ID,
        rule: NAMING_DIAGNOSTIC_ID,
        severity,
        ...at(start.row, start.row),
        startCharacter: start.column,
        endCharacter: symbol.nameNode.endPosition.column,
        message: `${symbol.kind.replace('_', ' ')} '${symbol.name}' should be named '${newName}' (naming rule '${rule.title}').`,
        wouldChange: true,
        fixable: true,
        symbol: { name: symbol.name, newName },
      },
    ];
  });
}

/**
 * A violation cleanup reports instead of fixing: `ID (option or severity) line N: message`,
 * `ID line N: message`, or `rule: message` without a line.
 */
function issueFinding(detail: string, props: EditorConfigProperties, at: Locate): CleanupFinding {
  const match = /^([A-Z]+\d+(?:\/[A-Z]+\d+)*)(?: \(([^)]*)\))? line (\d+): (.*)$/s.exec(detail);
  if (!match) {
    const [, rule, message] = /^([^:]+): (.*)$/s.exec(detail) ?? [undefined, 'Cleanup', detail];

    return { rule, startLine: 0, endLine: 0, fileLevel: true, message, wouldChange: false, fixable: false };
  }

  const [, ruleId, qualifier, line, message] = match;
  const stated = parseSeverity(/(?:^|, )(\w+)$/.exec(qualifier ?? '')?.[1]);
  const severity = stated ?? diagnosticSeverity(props, ruleId);

  return { ruleId, rule: ruleId, severity, ...at(Number(line) - 1, Number(line) - 1), message, wouldChange: false, fixable: false };
}

/** One type per file (`SA1402`/`MA0048`): the types a cleanup command would move, and the violations it leaves. */
function oneTypePerFileFindings(
  source: string,
  filePath: string,
  props: EditorConfigProperties,
  siblingFileNames: ReadonlySet<string>
): CleanupFinding[] {
  const rules = readOneTypePerFileRules(props);
  if (!rules) {
    return [];
  }

  const ruleId = rules.severities.has('MA0048') ? 'MA0048' : 'SA1402';
  const outcome = planOneTypePerFile(source, filePath, rules, siblingFileNames);
  const types = listTopLevelTypes(source);
  const identity: Locate = (start, end) => ({ startLine: start, endLine: end });
  const moved = outcome.plan.newFiles.map((planned): CleanupFinding => {
    const fileName = path.basename(planned.filePath);
    const line = (types.find((type) => type.fileName === fileName)?.line ?? 1) - 1;

    return {
      ruleId,
      rule: ruleId,
      severity: rules.severities.get(ruleId),
      startLine: line,
      endLine: line,
      message: `a cleanup command would move this type to its own file, ${fileName}.`,
      wouldChange: true,
      fixable: false,
    };
  });

  return [...moved, ...outcome.issues.map((detail) => issueFinding(detail, props, identity))];
}

/** IDE1006 fix of one occurrence: the rename of that one symbol, when the renamer proves it safe. */
function renameOccurrence(source: string, filePath: string, line: number, symbol: { readonly name: string; readonly newName: string }): string | undefined {
  const props = loadEditorConfigProperties(filePath);
  const model = buildSourceModel(source);
  const violation = findNamingViolations(model, parseNamingRules(props), props).find(
    (candidate) =>
      candidate.symbol.name === symbol.name && candidate.newName === symbol.newName && candidate.symbol.nameNode.startPosition.row === line
  );
  if (!violation || !violation.rule.style.isCompliant(violation.newName)) {
    return undefined;
  }

  const plan = planRename(model, violation.symbol, violation.newName, (candidate) => (candidate === violation.symbol ? violation.newName : undefined));

  return plan.ok ? applyEdits(source, plan.edits) : undefined;
}

/** The lines of the text before a hunk that it concerns: its changed lines, or the line an insertion follows. */
function anchorLines(hunk: LineHunk, lastLine: number): [number, number] {
  if (hunk.beforeEnd > hunk.beforeStart) {
    return [Math.min(hunk.beforeStart, lastLine), Math.min(hunk.beforeEnd - 1, lastLine)];
  }

  const line = Math.min(Math.max(hunk.beforeStart - 1, 0), lastLine);

  return [line, line];
}

/** Maps a line of `current` (a text cleanup derived from `source`) to the line range of `source` it comes from. */
function lineMapper(source: string, current: string): (line: number) => [number, number] {
  const hunks = diffLineHunks(source, current);

  return (line) => {
    let shift = 0;
    for (const hunk of hunks) {
      if (line < hunk.afterStart) {
        break;
      }

      if (line < hunk.afterEnd) {
        return [hunk.beforeStart, Math.max(hunk.beforeStart, hunk.beforeEnd - 1)];
      }

      shift = hunk.beforeEnd - hunk.afterEnd;
    }

    return [line + shift, line + shift];
  };
}

function abbreviate(text: string): string {
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}
