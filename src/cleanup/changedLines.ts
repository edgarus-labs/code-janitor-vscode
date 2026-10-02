import { applyStepRule } from './analysis';
import { loadEditorConfigProperties } from './editorconfig';
import { LineHunk, applyLineHunks, diffLineHunks } from './lineDiff';
import { parseNamingRules } from './naming/namingRules';
import { buildSourceModel } from './naming/sourceModel';
import { EditorConfigIssueListener, getCleanupPipeline } from './runCleanup';
import { describeNamingViolation, findNamingViolations } from './transformations/editorConfigNaming';
import { parseErrorCount } from './transformations/editorConfigSupport';
import { CleanupSettings } from './types';

/**
 * Cleanup of only the lines changed since the last commit (`codeJanitor.cleanup.onlyChangedLines`):
 * each step's changes are kept on changed lines and dropped elsewhere; a step (or rule) whose
 * change covers both changed and unchanged lines is skipped and reported. Renames are not made.
 */

const NAMING_DIAGNOSTIC_ID = 'IDE1006';
const SETTING = 'codeJanitor.cleanup.onlyChangedLines';

/**
 * The lines (0-based) of `current` added or modified since `base`; every line when there is no base.
 * A byte order mark is not line content: `git show` keeps it, the editor's text does not.
 */
export function changedLinesSince(base: string | undefined, current: string): ReadonlySet<number> {
  const normalize = (text: string) => text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const normalized = normalize(current);
  if (base === undefined) {
    return new Set(normalized.split('\n').keys());
  }

  const changed = new Set<number>();
  for (const hunk of diffLineHunks(normalize(base), normalized)) {
    for (let line = hunk.afterStart; line < hunk.afterEnd; line++) {
      changed.add(line);
    }
  }

  return changed;
}

export interface ChangedLinesOutcome {
  readonly output: string;
  /** Code Janitor settings skipped because their changes span unchanged lines (the `.editorconfig` rules go to the listener). */
  readonly skippedSettings: readonly string[];
}

/**
 * Runs cleanup on `source` keeping only the changes on the `changed` lines. Violations reported on
 * unchanged lines are left out; `.editorconfig` rules skipped because their change spans unchanged
 * lines are reported as unresolved.
 */
export function runCleanupOnChangedLines(
  source: string,
  filePath: string,
  settings: CleanupSettings,
  changed: ReadonlySet<number>,
  disqualifiedTypeNames?: ReadonlySet<string>,
  onIssue?: EditorConfigIssueListener
): ChangedLinesOutcome {
  // Issues reported while the pipeline is built (unresolved Code Style rules) are forwarded too.
  let collecting = true;
  let lines = changed;
  const onLine = (detail: string) => {
    const line = / line (\d+):/.exec(detail)?.[1];

    return line === undefined || lines.has(Number(line) - 1);
  };
  const pipeline = getCleanupPipeline(source, filePath, settings, disqualifiedTypeNames, (issue) => {
    if (issue.kind === 'unsupported' || (collecting && onLine(issue.detail))) {
      onIssue?.(issue);
    }
  });
  collecting = false;
  const skip = (ruleId: string) =>
    onIssue?.({ kind: 'unresolved', filePath, detail: `${ruleId}: not applied, its changes span lines not changed since the last commit (${SETTING}).` });
  const skippedSettings: string[] = [];

  let current = source;
  for (const step of pipeline.transformations) {
    if (step.diagnosticId === NAMING_DIAGNOSTIC_ID) {
      reportNamingViolations(current, filePath, lines, onIssue);
      continue;
    }

    collecting = true;
    const full = step.applyRules?.(current, new Set());
    const output = full ? full.output : step.apply(current);
    collecting = false;
    if (output === current) {
      continue;
    }

    const kept = keepChangedLines(current, output, lines, (text) => (full ? step.applyRules!(text, new Set()).output : step.apply(text)));
    if (kept) {
      [current, lines] = kept;
      continue;
    }

    const rules = full?.rules.filter((rule) => rule.included && rule.changes > 0) ?? [];
    if (rules.length === 0) {
      if (step.diagnosticId) {
        skip(step.diagnosticId);
      } else {
        skippedSettings.push(step.name);
      }

      continue;
    }

    // Rule by rule, in the step's order: the rules whose changes stay on changed lines still apply.
    for (const rule of rules) {
      const ruleKept = keepChangedLines(current, applyStepRule(step, current, rule.id), lines, (text) => applyStepRule(step, text, rule.id));
      if (ruleKept) {
        [current, lines] = ruleKept;
      } else {
        skip(rule.id);
      }
    }
  }

  return { output: current, skippedSettings };
}

/**
 * `after` restricted to the changed lines of `before`, with the changed lines renumbered for it, or
 * `undefined` when a change covers changed and unchanged lines or the changes left out cannot be
 * left out safely: the result must parse as well and `redo` of it must give `after` again.
 */
function keepChangedLines(
  before: string,
  after: string,
  changed: ReadonlySet<number>,
  redo: (text: string) => string
): [string, ReadonlySet<number>] | undefined {
  const hunks = diffLineHunks(before, after);
  const kept: LineHunk[] = [];
  for (const hunk of hunks) {
    const touched = hunk.beforeEnd > hunk.beforeStart ? range(hunk.beforeStart, hunk.beforeEnd) : [hunk.beforeStart - 1, hunk.beforeStart];
    const onChanged = touched.filter((line) => changed.has(line)).length;
    if (onChanged > 0 && onChanged < touched.length && hunk.beforeEnd > hunk.beforeStart) {
      return undefined;
    }

    if (onChanged > 0) {
      kept.push(hunk);
    }
  }

  if (kept.length === 0) {
    return [before, changed];
  }

  const text = kept.length === hunks.length ? after : applyLineHunks(before, after, kept);
  if (text !== after && (parseErrorCount(text) > parseErrorCount(before) || redo(text) !== after)) {
    return undefined;
  }

  return [text, renumber(changed, kept)];
}

/** The changed lines after applying `kept`: the lines the hunks wrote are changed too. */
function renumber(changed: ReadonlySet<number>, kept: readonly LineHunk[]): ReadonlySet<number> {
  const sorted = [...changed].sort((a, b) => a - b);
  const next = new Set<number>();
  let shift = 0;
  let index = 0;
  for (const hunk of kept) {
    for (; index < sorted.length && sorted[index] < hunk.beforeStart; index++) {
      next.add(sorted[index] + shift);
    }

    for (; index < sorted.length && sorted[index] < hunk.beforeEnd; index++);
    for (let line = 0; line < hunk.afterEnd - hunk.afterStart; line++) {
      next.add(hunk.beforeStart + shift + line);
    }

    shift += hunk.afterEnd - hunk.afterStart - (hunk.beforeEnd - hunk.beforeStart);
  }

  for (; index < sorted.length; index++) {
    next.add(sorted[index] + shift);
  }

  return next;
}

/** IDE1006 violations declared on changed lines, reported as not renamed. */
function reportNamingViolations(source: string, filePath: string, lines: ReadonlySet<number>, onIssue?: EditorConfigIssueListener): void {
  const props = loadEditorConfigProperties(filePath);
  const rules = parseNamingRules(props);
  if (rules.length === 0 || !onIssue) {
    return;
  }

  for (const violation of findNamingViolations(buildSourceModel(source), rules, props)) {
    if (lines.has(violation.symbol.nameNode.startPosition.row)) {
      onIssue({
        kind: 'unresolved',
        filePath,
        detail: describeNamingViolation(violation, 'renames are not made when only changed lines are cleaned'),
      });
    }
  }
}

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start }, (_, index) => start + index);
}
