import * as path from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import * as vscode from 'vscode';
import { countChangedRegions } from '../cleanup/lineDiff';
import { DocumentText, RuleResult } from '../engine/protocol';
import { reportEngineUnavailable } from '../engine/vscodeEngine';
import { logError, logInfo } from '../logging';
import {
  asDocumentText,
  cleanupCSharpResult,
  engineOutcome,
  externalFileCleanup,
  firstExistingFile,
  isCSharp,
  isOutsideWorkspaceFolders,
  isPathCleanable,
} from './cleanupCore';
import { readCleanupSettingsForUri } from './settings';

/**
 * The plan of a multi-file cleanup preview (the port of the Visual Studio "Preview C# Text
 * Changes"): every file's cleanup computed by the C# engine from its original text, but not written
 * anywhere. The plan is approved per file and per rule, then applied through one `WorkspaceEdit`
 * that refuses every file whose text changed since the plan.
 */

export type PreviewStatus = 'changes' | 'unchanged' | 'skipped' | 'error';

/** What a rule did to the original text of a file in the current selection of rules. */
export type RuleOutcome = 'Changed' | 'No change' | 'Excluded';

/** One rule (or Code Janitor step) of a file's preview. */
export interface PreviewRule {
  /** The rule id the engine leaves out when the rule is excluded. */
  readonly key: string;
  readonly name: string;
  /** The rule id, shown with the name when it differs. */
  readonly group?: string;
  include: boolean;
  outcome: RuleOutcome;
  /** The number of separate places the rule changed in the current selection. */
  changes: number;
}

/** A file's cleanup by the engine with some rules left out. */
export interface ComputedPreview {
  readonly updated: string;
  readonly rules: readonly RuleResult[];
  readonly otherFiles: readonly DocumentText[];
  readonly newFiles: readonly DocumentText[];
  readonly unresolved: number;
  readonly issues: readonly string[];
}

/** How a file's updated text is computed from its original text and the rules left out. */
interface Computation {
  compute(original: string, excludedRules: readonly string[]): Promise<ComputedPreview>;
}

export class PreviewFile {
  /** Whether the file is part of the operation; only a file with changes can be included. */
  include = false;

  readonly rules: PreviewRule[] = [];

  /** Things the user should know that are not a status: files a type split creates, the engine's messages. */
  readonly notes: string[] = [];

  /** Violations of `.editorconfig` rules cleanup could not fix safely. */
  unresolved = 0;

  private result: ComputedPreview | undefined;

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

  /** Runs the complete cleanup once: that result lists the rules, all included. */
  static async planned(uri: vscode.Uri, label: string, original: string, computation: Computation): Promise<PreviewFile> {
    const file = new PreviewFile(uri, label, original, computation);
    try {
      const result = await computation.compute(original, []);
      file.evaluate(result);
      file.rules.push(
        ...result.rules.map((rule) => ({
          key: rule.id,
          name: rule.name,
          group: rule.id !== rule.name ? rule.id : undefined,
          include: true,
          outcome: 'No change' as RuleOutcome,
          changes: 0,
        }))
      );
      file.updateOutcomes();
      file.unresolved = result.unresolved;
      file.notes.push(...result.issues);
    } catch (err) {
      if (!reportEngineUnavailable(err)) {
        logError(`Cleanup preview of ${uri.fsPath}`, err);
      }

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

    return this.hasChanges ? 'changes' : 'unchanged';
  }

  get canApply(): boolean {
    return this.problem === undefined && this.blocked === undefined && this.hasChanges;
  }

  /** The text cleanup would leave; the original when nothing applies. */
  get updated(): string {
    return this.result?.updated ?? this.original ?? '';
  }

  /** The files the current result creates (a type split), written with the file. */
  get newFiles(): readonly DocumentText[] {
    return this.result?.newFiles ?? [];
  }

  /** A short, user-facing statement of the file's status. */
  get message(): string {
    if (this.problem) {
      return `${this.problem.status === 'skipped' ? 'Skipped' : 'Error'}: ${this.problem.reason}`;
    }

    if (this.blocked) {
      return `Not applied: ${this.blocked}`;
    }

    if (!this.hasChanges) {
      return 'No changes';
    }

    const count = countChangedRegions(this.original ?? '', this.updated);
    const created = this.newFiles.length > 0 ? `, ${this.newFiles.length} new ${this.newFiles.length === 1 ? 'file' : 'files'}` : '';

    return `${count} ${count === 1 ? 'change' : 'changes'}${created}`;
  }

  /**
   * Replaces the included rules with exactly `keys` and recomputes the result from the original
   * text. A file left without changes drops out of the operation; one that regains them joins it.
   */
  async setIncludedRules(keys: ReadonlySet<string>): Promise<void> {
    const couldApply = this.canApply;
    this.rules.forEach((rule) => (rule.include = keys.has(rule.key)));
    await this.recalculate();
    if (!this.canApply) {
      this.include = false;
    } else if (!couldApply) {
      this.include = true;
    }
  }

  /** Applies the result when `current` is still the text the plan was made from. */
  tryApply(current: string, replace: (updated: string) => void): boolean {
    if (this.result === undefined || current !== this.original) {
      return false;
    }

    replace(this.updated);

    return true;
  }

  private get hasChanges(): boolean {
    return this.result !== undefined && (this.result.updated !== this.original || this.result.newFiles.length > 0);
  }

  /** Recomputes from the original text - never from an earlier result - with the rules left out. */
  private async recalculate(): Promise<void> {
    if (this.computation === undefined || this.original === undefined) {
      return;
    }

    try {
      this.evaluate(
        await this.computation.compute(
          this.original,
          this.rules.filter((rule) => !rule.include).map((rule) => rule.key)
        )
      );
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
      const ruled = this.result?.rules.find((candidate) => candidate.id === rule.key);
      rule.changes = rule.include ? (ruled?.changes ?? 0) : 0;
      rule.outcome = !rule.include ? 'Excluded' : rule.changes > 0 ? 'Changed' : 'No change';
    }
  }

  /** Keeps a result and judges it: a result changing other files is applied by Cleanup, never by the preview. */
  private evaluate(result: ComputedPreview): void {
    this.result = result;
    this.blocked = undefined;
    this.problem = undefined;
    if (result.otherFiles.length > 0) {
      this.blocked = `it would also change ${result.otherFiles.map((other) => path.basename(other.path)).join(', ')}; run Cleanup instead`;
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
  /** Consulted between the files and once more after the last one, so a cancel pressed at any point is seen. */
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
 * included), otherwise the file on disk as VS Code loads it into a document, which the apply compares
 * with. A closed file is not opened in an editor. The byte order mark is not part of the text, as
 * VS Code's own documents do not contain it.
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
      return { text: asDocumentText(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
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
 * give (without renames in other files; partial for a file outside the workspace folders, skipped when
 * `codeJanitor.cleanup.performPartialCleanupOnExternal` is `never`), and every other file an explicit
 * status saying why it is not part of the preview.
 */
export async function buildCleanupPreviewPlan(uris: readonly vscode.Uri[], options: PlanOptions = {}): Promise<CleanupPreviewPlan> {
  const unique = [...new Map(uris.map((uri) => [uri.toString(), uri])).values()];
  const maxBytes =
    Math.max(1, options.maxFileSizeKB ?? vscode.workspace.getConfiguration('codeJanitor').get<number>('preview.maxFileSizeKB', DEFAULT_MAX_FILE_SIZE_KB)) *
    1024;

  const entries: { readonly uri: vscode.Uri; readonly label: string; readonly source?: Source; readonly file?: PreviewFile }[] = [];
  const pending: { readonly uri: vscode.Uri; readonly label: string; readonly text: string; readonly partial: boolean }[] = [];
  for (const uri of unique) {
    const label = previewLabel(uri);
    const partial = isOutsideWorkspaceFolders(uri);
    const skipBecause = partial ? (await externalFileCleanup(uri, false)).skipBecause : undefined;
    if (!isPathCleanable(uri)) {
      entries.push({ uri, label, file: PreviewFile.skipped(uri, label, 'excluded by the codeJanitor.cleanup.include / exclude settings') });
    } else if (!isCSharp(uri)) {
      entries.push({ uri, label, file: PreviewFile.skipped(uri, label, 'not a C# file (the preview covers C# text cleanup)') });
    } else if (skipBecause) {
      entries.push({ uri, label, file: PreviewFile.skipped(uri, label, skipBecause) });
    } else {
      const source = await readSource(uri, maxBytes);
      if ('text' in source) {
        pending.push({ uri, label, text: source.text, partial });
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

  const honorOnlyChangedLines = options.honorOnlyChangedLines === true;
  const planned = new Map<string, PreviewFile>();
  let done = 0;
  for (const item of pending) {
    if (options.isCancelled?.()) {
      break;
    }

    const file = await PreviewFile.planned(item.uri, item.label, item.text, {
      compute: async (original, excludedRules) => {
        const result = await cleanupCSharpResult(
          { uri: item.uri, content: original, isOpen: false },
          { renameAcrossWorkspace: false, honorOnlyChangedLines, partial: item.partial, excludedRules }
        );
        // Only the complete first preview logs: the previews without some rules repeat its messages.
        if (excludedRules.length === 0) {
          engineOutcome(item.uri, result, 'Cleanup preview');
        }

        return {
          updated: result.text,
          rules: result.rules,
          otherFiles: result.otherFiles,
          newFiles: result.newFiles,
          unresolved: result.unresolved.length,
          issues: result.issues,
        };
      },
    });
    if (honorOnlyChangedLines && readCleanupSettingsForUri(item.uri).onlyChangedLines) {
      file.notes.push('Only the lines changed since the last commit are cleaned.');
    }

    if (file.newFiles.length > 0) {
      file.notes.push(
        `The .editorconfig asks for one type per file: applying also creates ${file.newFiles.map((created) => path.basename(created.path)).join(', ')}.`
      );
    }

    planned.set(item.uri.toString(), file);
    options.onProgress?.(++done, pending.length);
    await yieldToEventLoop();
  }
  // A cancel pressed while the last file was planned: consulted once more so the caller sees it.
  options.isCancelled?.();

  const files = entries.flatMap((entry) => {
    const file = entry.file ?? planned.get(entry.uri.toString());

    return file ? [file] : [];
  });
  const unresolved = files.reduce((total, file) => total + file.unresolved, 0);
  logInfo(`Cleanup preview: ${files.length} file(s) planned, ${files.filter((file) => file.canApply).length} with changes.`);

  return new CleanupPreviewPlan(`plan${++planCounter}`, files, unresolved);
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

  return file.tryApply(current, (updated) => {
    for (const created of file.newFiles) {
      const uri = vscode.Uri.file(created.path);
      // Without options, creating a file that exists fails: a split never overwrites a file.
      edit.createFile(uri);
      edit.insert(uri, new vscode.Position(0, 0), created.text.replace(/^\uFEFF/, ''));
    }

    edit.replace(file.uri, range, updated.replace(/^\uFEFF/, ''));
  });
}

/**
 * Applies the included files of the plan without saving anything. A file is applied only when its
 * document - the editor buffer, or the file opened from disk - still holds the text the plan was
 * made from; otherwise it is refused. A file one of whose new files already exists fails before the
 * edit is built, as VS Code keeps the part of an edit it applied before a creation that fails. All
 * files go into one `WorkspaceEdit`, so one undo reverts the operation; when VS Code rejects that
 * edit, each file is checked again and applied on its own.
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
  const existing = new Map<PreviewFile, string>();
  for (const file of targets) {
    try {
      const found = await firstExistingFile(file.newFiles);
      if (found !== undefined) {
        existing.set(file, `${path.basename(found)} already exists`);
      }
    } catch (err) {
      existing.set(file, `its new files could not be checked (${(err as Error).message})`);
    }

    if (!existing.has(file)) {
      documents.set(file, await openTarget(file));
    }
  }

  const edit = new vscode.WorkspaceEdit();
  const planned: PreviewFile[] = [];
  for (const file of targets) {
    const blocked = existing.get(file);
    if (blocked !== undefined) {
      failed.push({ file, reason: blocked });
    } else if (addWhenUnchanged(file, documents.get(file), edit)) {
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
