import * as path from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import * as vscode from 'vscode';
import { Baseline, readHeadVersion } from '../cleanup/gitBaseline';
import { countChangedRegions } from '../cleanup/lineDiff';
import { PreviewResult } from '../cleanup/pipeline';
import { loadEditorConfigProperties } from '../cleanup/editorconfig';
import { planOneTypePerFile, readOneTypePerFileRules } from '../cleanup/oneTypePerFile';
import { EditorConfigIssueListener, getCleanupPipeline } from '../cleanup/runCleanup';
import { parseErrorCount } from '../cleanup/transformations/editorConfigSupport';
import { CleanupSettings } from '../cleanup/types';
import { logError, logInfo } from '../logging';
import {
  cleanupChangedLines,
  createEditorConfigIssueLog,
  discoverDisqualifiedTypeNamesForFile,
  isCSharp,
  isPathCleanable,
} from './cleanupCore';
import { readCleanupSettings, readCleanupSettingsForUri } from './settings';

/**
 * The plan of a multi-file cleanup preview (the port of the Visual Studio "Preview C# Text
 * Changes"): every file's cleanup computed from its original text with the ordinary pipeline, but
 * not written anywhere. The plan is approved per file and per rule, then applied through one
 * `WorkspaceEdit` that refuses every file whose text changed since the plan.
 */

export type PreviewStatus = 'changes' | 'unchanged' | 'skipped' | 'error';

/** What a rule did to the original text of a file in the current selection of rules. */
export type RuleOutcome = 'Changed' | 'No change' | 'Excluded';

/** One rule of a file's preview: a step of the pipeline, or one rule of a step made of rules. */
export interface PreviewRule {
  readonly key: string;
  readonly name: string;
  /** For a rule of a step made of rules: the step's name. */
  readonly group?: string;
  include: boolean;
  outcome: RuleOutcome;
  /** The number of separate places the rule changed in the current selection. */
  changes: number;
  /** Index of the pipeline step. */
  readonly step: number;
  /** For a rule of a step made of rules: its diagnostic id. */
  readonly rule?: string;
}

/** How a file's updated text is computed from its original text and the rules left out. */
interface Computation {
  compute(original: string, excludedSteps: ReadonlySet<number>, excludedRules: ReadonlySet<string>): PreviewResult;
}

export class PreviewFile {
  /** Whether the file is part of the operation; only a file with changes can be included. */
  include = false;

  readonly rules: PreviewRule[] = [];

  /** Things the user should know that are not a status: a skipped type split, syntax problems. */
  readonly notes: string[] = [];

  /** Violations of `.editorconfig` rules cleanup could not fix safely. */
  unresolved = 0;

  private result: PreviewResult | undefined;

  private problem: { readonly status: 'skipped' | 'error'; readonly reason: string } | undefined;

  /** Why the current result must not be applied, though it is not an error. */
  private blocked: string | undefined;

  private constructor(
    readonly uri: vscode.Uri,
    readonly label: string,
    /** The text the plan was made from; `undefined` when the file was skipped or could not be read. */
    readonly original: string | undefined,
    private readonly computation?: Computation
  ) {}

  static skipped(uri: vscode.Uri, label: string, reason: string): PreviewFile {
    const file = new PreviewFile(uri, label, undefined);
    file.problem = { status: 'skipped', reason };

    return file;
  }

  static failed(uri: vscode.Uri, label: string, reason: string, original?: string): PreviewFile {
    const file = new PreviewFile(uri, label, original);
    file.problem = { status: 'error', reason };

    return file;
  }

  /** Runs the complete pipeline once: that result lists the rules, all included. */
  static planned(uri: vscode.Uri, label: string, original: string, computation: Computation): PreviewFile {
    const file = new PreviewFile(uri, label, original, computation);
    try {
      file.evaluate(computation.compute(original, new Set(), new Set()));
      file.listRules();
      file.updateOutcomes();
      const problems = parseErrorCount(original);
      if (problems > 0) {
        file.notes.push(`${problems} syntax ${problems === 1 ? 'problem' : 'problems'} in the file: code the parser does not understand is left unchanged.`);
      }
    } catch (err) {
      logError(`Cleanup preview of ${uri.fsPath}`, err);
      file.problem = { status: 'error', reason: (err as Error).message };
      file.result = undefined;
    }

    file.include = file.canApply;

    return file;
  }

  get status(): PreviewStatus {
    if (this.problem) {
      return this.problem.status;
    }

    if (this.blocked) {
      return 'error';
    }

    return this.result?.hasChanges ? 'changes' : 'unchanged';
  }

  get canApply(): boolean {
    return this.problem === undefined && this.blocked === undefined && this.result?.hasChanges === true;
  }

  /** The text cleanup would leave; the original when nothing applies. */
  get updated(): string {
    return this.result?.updatedSource ?? this.original ?? '';
  }

  /** A short, user-facing statement of the file's status. */
  get message(): string {
    if (this.problem) {
      return `${this.problem.status === 'skipped' ? 'Skipped' : 'Error'}: ${this.problem.reason}`;
    }

    if (this.blocked) {
      return `Not applied: ${this.blocked}`;
    }

    if (!this.result?.hasChanges) {
      return 'No changes';
    }

    const count = countChangedRegions(this.result.originalSource, this.result.updatedSource);

    return `${count} ${count === 1 ? 'change' : 'changes'}`;
  }

  /**
   * Replaces the included rules with exactly `keys` and recomputes the result from the original
   * text. A file left without changes drops out of the operation; one that regains them joins it.
   */
  setIncludedRules(keys: ReadonlySet<string>): void {
    const couldApply = this.canApply;
    this.rules.forEach((rule) => (rule.include = keys.has(rule.key)));
    this.recalculate();
    if (!this.canApply) {
      this.include = false;
    } else if (!couldApply) {
      this.include = true;
    }
  }

  /** Applies the result when `current` is still the text the plan was made from. */
  tryApply(current: string, replace: (updated: string) => void): boolean {
    return this.result !== undefined && this.result.tryApply(current, replace);
  }

  private listRules(): void {
    for (const step of this.result?.steps ?? []) {
      if (step.rules) {
        for (const rule of step.rules) {
          this.rules.push({
            key: `${step.index}:${rule.id}`,
            name: rule.id,
            group: step.name,
            include: true,
            outcome: 'No change',
            changes: 0,
            step: step.index,
            rule: rule.id,
          });
        }
      } else {
        this.rules.push({ key: `${step.index}`, name: step.name, include: true, outcome: 'No change', changes: 0, step: step.index });
      }
    }
  }

  /** Recomputes from the original text - never from an earlier result - with the rules left out. */
  private recalculate(): void {
    if (this.computation === undefined || this.original === undefined) {
      return;
    }

    const excludedSteps = new Set(this.rules.filter((rule) => !rule.include && rule.rule === undefined).map((rule) => rule.step));
    const excludedRules = new Set(this.rules.flatMap((rule) => (!rule.include && rule.rule !== undefined ? [rule.rule] : [])));
    try {
      this.evaluate(this.computation.compute(this.original, excludedSteps, excludedRules));
    } catch (err) {
      logError(`Cleanup preview of ${this.uri.fsPath}`, err);
      this.problem = { status: 'error', reason: (err as Error).message };
      this.result = undefined;

      return;
    }

    this.updateOutcomes();
  }

  private updateOutcomes(): void {
    for (const rule of this.rules) {
      const step = this.result?.steps.find((candidate) => candidate.index === rule.step);
      const ruled = step?.rules?.find((candidate) => candidate.id === rule.rule);
      rule.changes = rule.include ? (ruled ? ruled.changes : (step?.changes ?? 0)) : 0;
      rule.outcome = !rule.include ? 'Excluded' : (ruled ? ruled.changes > 0 : step?.changed === true) ? 'Changed' : 'No change';
    }
  }

  /**
   * Keeps a result and judges it: a rewrite with more syntax problems than the original may have
   * broken the code, so it is never offered for application (the same check the rules use).
   */
  private evaluate(result: PreviewResult): void {
    this.result = result;
    this.blocked = undefined;
    this.problem = undefined;
    if (result.hasChanges) {
      const added = parseErrorCount(result.updatedSource) - parseErrorCount(result.originalSource);
      if (added > 0) {
        this.blocked = `the result would add ${added} syntax ${added === 1 ? 'problem' : 'problems'}`;
      }
    }
  }
}

export class CleanupPreviewPlan {
  constructor(
    readonly id: string,
    readonly files: readonly PreviewFile[],
    /** `.editorconfig` rule violations cleanup could not fix safely, over all files. */
    readonly unresolved: number
  ) {}

  /** The files the operation would change: included, with a result that can be applied. */
  get selected(): PreviewFile[] {
    return this.files.filter((file) => file.include && file.canApply);
  }

  count(status: PreviewStatus): number {
    return this.files.filter((file) => file.status === status).length;
  }
}

export interface PlanOptions {
  /** Cleanup Changed Files: with `codeJanitor.cleanup.onlyChangedLines`, only the lines changed since HEAD. */
  readonly honorOnlyChangedLines?: boolean;
  /** Files of a larger size (in KiB) are skipped. */
  readonly maxFileSizeKB?: number;
  readonly isCancelled?: () => boolean;
  /** Called after each file with the number of files prepared so far. */
  readonly onProgress?: (done: number, total: number) => void;
}

export const DEFAULT_MAX_FILE_SIZE_KB = 1024;

let planCounter = 0;

/** The label of a file in the preview: its path relative to its workspace folder. */
export function previewLabel(uri: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  const label = folder ? path.relative(folder.uri.fsPath, uri.fsPath) : uri.fsPath;

  return label.replace(/\\/g, '/');
}

type Source = { readonly text: string } | { readonly skip: string } | { readonly error: string };

/**
 * The text a cleanup would start from: the live editor buffer of an open file (unsaved changes
 * included), otherwise the file on disk. A closed file is not opened in an editor. The byte order
 * mark is not part of the text, as VS Code's own documents do not contain it.
 */
async function readSource(uri: vscode.Uri, maxBytes: number): Promise<Source> {
  const open = vscode.workspace.textDocuments.find((doc) => !doc.isClosed && doc.uri.toString() === uri.toString());
  if (open) {
    const text = open.getText();

    return text.length > maxBytes ? { skip: `too large (more than ${Math.round(maxBytes / 1024)} KiB)` } : { text };
  }

  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (typeof stat.size === 'number' && stat.size > maxBytes) {
      return { skip: `too large (${Math.ceil(stat.size / 1024)} KiB; the limit is ${Math.round(maxBytes / 1024)} KiB)` };
    }

    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.byteLength > maxBytes) {
      return { skip: `too large (${Math.ceil(bytes.byteLength / 1024)} KiB; the limit is ${Math.round(maxBytes / 1024)} KiB)` };
    }

    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
    } catch {
      return { skip: 'the file is not UTF-8 text, which the preview cannot apply safely' };
    }
  } catch (err) {
    return { error: `the file could not be read (${(err as Error).message})` };
  }
}

/**
 * Builds the plan for `uris` - deduplicated, in the given order - without writing a file and
 * without AI: every C# file gets the cleanup result the ordinary cleanup of the same files would
 * give, and every other file an explicit status saying why it is not part of the preview.
 */
export async function buildCleanupPreviewPlan(uris: readonly vscode.Uri[], options: PlanOptions = {}): Promise<CleanupPreviewPlan> {
  const unique = [...new Map(uris.map((uri) => [uri.toString(), uri])).values()];
  const maxBytes =
    Math.max(1, options.maxFileSizeKB ?? vscode.workspace.getConfiguration('codeJanitor').get<number>('preview.maxFileSizeKB', DEFAULT_MAX_FILE_SIZE_KB)) * 1024;

  const entries: { readonly uri: vscode.Uri; readonly label: string; readonly source?: Source; readonly file?: PreviewFile }[] = [];
  const pending: { readonly uri: vscode.Uri; readonly label: string; readonly text: string }[] = [];
  for (const uri of unique) {
    const label = previewLabel(uri);
    if (!isPathCleanable(uri)) {
      entries.push({ uri, label, file: PreviewFile.skipped(uri, label, 'excluded by the codeJanitor.cleanup.include / exclude settings') });
    } else if (!isCSharp(uri)) {
      entries.push({ uri, label, file: PreviewFile.skipped(uri, label, 'not a C# file (the preview covers C# text cleanup)') });
    } else {
      const source = await readSource(uri, maxBytes);
      if ('text' in source) {
        pending.push({ uri, label, text: source.text });
        entries.push({ uri, label, source });
      } else {
        entries.push({
          uri,
          label,
          file: 'skip' in source ? PreviewFile.skipped(uri, label, source.skip) : PreviewFile.failed(uri, label, source.error),
        });
      }
    }

    if (options.isCancelled?.()) {
      break;
    }
  }

  const first = pending[0];
  // Like the batch cleanup: batch-wide flags come from the first file; each file is planned with the `.codejanitor` nearest to it.
  const settings = first ? readCleanupSettingsForUri(first.uri) : readCleanupSettings();
  // Like the batch cleanup: a subclass or generic constraint in one file of the batch keeps a class of another unsealed.
  const covered = new Set(pending.map((item) => item.uri.toString()));
  const disqualified = new Set<string>();
  for (const item of pending) {
    if (options.isCancelled?.()) {
      break;
    }

    for (const name of await discoverDisqualifiedTypeNamesForFile(item.uri, item.text, covered)) {
      disqualified.add(name);
    }
  }

  const issues = createEditorConfigIssueLog(false);
  const onlyChangedLines = options.honorOnlyChangedLines === true && settings.onlyChangedLines;
  const planned = new Map<string, PreviewFile>();
  let done = 0;
  for (const item of pending) {
    if (options.isCancelled?.()) {
      break;
    }

    planned.set(
      item.uri.toString(),
      await planFile(item.uri, item.label, item.text, readCleanupSettingsForUri(item.uri), disqualified, issues.report, onlyChangedLines)
    );
    options.onProgress?.(++done, pending.length);
    await yieldToEventLoop();
  }

  const files = entries.flatMap((entry) => {
    const file = entry.file ?? planned.get(entry.uri.toString());

    return file ? [file] : [];
  });
  const { unresolved } = issues.finish();
  logInfo(`Cleanup preview: ${files.length} file(s) planned, ${files.filter((file) => file.canApply).length} with changes.`);

  return new CleanupPreviewPlan(`plan${++planCounter}`, files, unresolved);
}

async function planFile(
  uri: vscode.Uri,
  label: string,
  text: string,
  settings: CleanupSettings,
  disqualified: ReadonlySet<string>,
  report: EditorConfigIssueListener,
  onlyChangedLines: boolean
): Promise<PreviewFile> {
  let unresolved = 0;
  // Only the complete first preview reports: the previews without some rules repeat its issues.
  let reporting = true;
  const listen: EditorConfigIssueListener = (issue) => {
    if (reporting) {
      if (issue.kind === 'unresolved') {
        unresolved++;
      }

      report(issue);
    }
  };

  let file: PreviewFile;
  try {
    if (onlyChangedLines) {
      file = await planChangedLines(uri, label, text, settings, disqualified, listen);
    } else {
      const pipeline = getCleanupPipeline(text, uri.fsPath, settings, disqualified, listen);
      file = PreviewFile.planned(uri, label, text, {
        compute: (original, excludedSteps, excludedRules) => pipeline.preview(original, excludedSteps, excludedRules),
      });
    }
  } catch (err) {
    logError(`Cleanup preview of ${uri.fsPath}`, err);
    file = PreviewFile.failed(uri, label, (err as Error).message, text);
  }

  reporting = false;
  file.unresolved = unresolved;
  addTypeSplitNote(file, uri, text);

  return file;
}

/** Only the lines changed since HEAD: a single result, as the lines are not cleaned rule by rule. */
async function planChangedLines(
  uri: vscode.Uri,
  label: string,
  text: string,
  settings: CleanupSettings,
  disqualified: ReadonlySet<string>,
  report: EditorConfigIssueListener
): Promise<PreviewFile> {
  const baseline: Baseline = await readHeadVersion(uri.fsPath).catch((err: unknown): Baseline => ({ kind: 'unavailable', reason: String(err) }));
  try {
    const updated = cleanupChangedLines(text, uri.fsPath, settings, baseline, disqualified, report);
    const file = PreviewFile.planned(uri, label, text, {
      compute: (original) => new PreviewResult(original, updated, []),
    });
    file.notes.push('Only the lines changed since the last commit are cleaned; rules cannot be chosen one by one.');

    return file;
  } catch (err) {
    return PreviewFile.failed(uri, label, (err as Error).message, text);
  }
}

/** The one-type-per-file split creates files; the preview shows only the cleanup of the file itself. */
function addTypeSplitNote(file: PreviewFile, uri: vscode.Uri, text: string): void {
  try {
    const rules = readOneTypePerFileRules(loadEditorConfigProperties(uri.fsPath));
    if (rules && planOneTypePerFile(text, uri.fsPath, rules, new Set()).plan.hasChanges) {
      file.notes.push('The .editorconfig asks for one type per file: Cleanup splits this file into several; the preview does not show the split.');
    }
  } catch {
    // A note only: the plan of the file itself stands.
  }
}

// ---------------------------------------------------------------- virtual documents for the diff

export const PREVIEW_SCHEME = 'codejanitor-preview';

/** Serves the before and after text of the diffs of a plan - no temporary files are written. */
export class PreviewContentProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();

  private version = 0;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }

  /** Publishes the current before/after texts of a file under new addresses, so an open diff never shows stale text. */
  publish(plan: CleanupPreviewPlan, file: PreviewFile): { before: vscode.Uri; after: vscode.Uri } {
    const name = encodeURIComponent(path.basename(file.uri.fsPath));
    const index = plan.files.indexOf(file);
    const address = (side: string) => vscode.Uri.parse(`${PREVIEW_SCHEME}://${plan.id}/${index}/${++this.version}/${side}/${name}`);
    const before = address('before');
    const after = address('after');
    this.contents.set(before.toString(), file.original ?? '');
    this.contents.set(after.toString(), file.updated);

    return { before, after };
  }

  release(plan: CleanupPreviewPlan): void {
    for (const key of [...this.contents.keys()]) {
      if (key.startsWith(`${PREVIEW_SCHEME}://${plan.id}/`)) {
        this.contents.delete(key);
      }
    }
  }
}

// ---------------------------------------------------------------- applying

export interface ApplyOutcome {
  readonly applied: PreviewFile[];
  /** Files whose text changed since the plan: left as they are. */
  readonly stale: PreviewFile[];
  readonly failed: { readonly file: PreviewFile; readonly reason: string }[];
  /** VS Code rejected the combined edit, so the files were applied one by one: each is its own undo step. */
  readonly appliedSeparately: boolean;
}

/** The document of a target: its open buffer, or the file opened from disk without showing an editor. */
async function openTarget(file: PreviewFile): Promise<vscode.TextDocument | undefined> {
  try {
    return await vscode.workspace.openTextDocument(file.uri);
  } catch (err) {
    logInfo(`Cleanup preview: ${file.uri.fsPath} could not be opened (${(err as Error).message}).`);

    return undefined;
  }
}

/**
 * Adds the result of `file` to `edit` when `document` still holds the text the plan was made from;
 * the range is taken from that same text, so VS Code applies it only to that version of the document.
 */
function addWhenUnchanged(file: PreviewFile, document: vscode.TextDocument | undefined, edit: vscode.WorkspaceEdit): boolean {
  if (!document || document.isClosed) {
    return false;
  }

  const current = document.getText();
  const range = new vscode.Range(document.positionAt(0), document.positionAt(current.length));

  return file.tryApply(current, (updated) => edit.replace(file.uri, range, updated));
}

/**
 * Applies the included files of the plan without saving anything. A file is applied only when its
 * document - the editor buffer, or the file opened from disk - still holds the text the plan was
 * made from; otherwise it is refused. All files go into one `WorkspaceEdit`, so one undo reverts the
 * operation; when VS Code rejects that edit, each file is checked again and applied on its own.
 */
export async function applyCleanupPreviewPlan(plan: CleanupPreviewPlan): Promise<ApplyOutcome> {
  const targets = plan.selected;
  const applied: PreviewFile[] = [];
  const stale: PreviewFile[] = [];
  const failed: { file: PreviewFile; reason: string }[] = [];
  const refuse = (file: PreviewFile) => {
    stale.push(file);
    logInfo(`Cleanup preview: ${file.uri.fsPath} changed since the preview and was not modified.`);
  };

  // All documents are opened first (asynchronously); their texts are compared as late as possible.
  const documents = new Map<PreviewFile, vscode.TextDocument | undefined>();
  for (const file of targets) {
    documents.set(file, await openTarget(file));
  }

  const edit = new vscode.WorkspaceEdit();
  const planned: PreviewFile[] = [];
  for (const file of targets) {
    if (addWhenUnchanged(file, documents.get(file), edit)) {
      planned.push(file);
    } else {
      refuse(file);
    }
  }

  const appliedSeparately = planned.length > 0 && !(await tryApplyEdit(edit));
  if (!appliedSeparately) {
    applied.push(...planned);
  } else {
    // A file may have changed since the combined edit was built: each one is checked again against its document.
    for (const file of planned) {
      const own = new vscode.WorkspaceEdit();
      if (!addWhenUnchanged(file, await openTarget(file), own)) {
        refuse(file);
      } else if (await tryApplyEdit(own)) {
        applied.push(file);
      } else {
        failed.push({ file, reason: 'VS Code did not apply the edit (the file may be read-only)' });
      }
    }
  }

  logInfo(`Cleanup preview: applied to ${applied.length} file(s), ${stale.length} changed since the preview, ${failed.length} failed.`);

  return { applied, stale, failed, appliedSeparately };
}

async function tryApplyEdit(edit: vscode.WorkspaceEdit): Promise<boolean> {
  try {
    return await vscode.workspace.applyEdit(edit);
  } catch (err) {
    logError('Cleanup preview: applying the edit', err);

    return false;
  }
}
