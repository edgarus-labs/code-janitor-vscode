import * as path from 'node:path';
import * as vscode from 'vscode';
import { insertRegionAroundLines } from '../text/regionEdits';
import { PreprocessorPolicy } from '../cleanup/reorganizeSettings';
import { documentParams, engine, reportEngineUnavailable } from '../engine/vscodeEngine';
import { logError, logInfo } from '../logging';
import { CollectedFile, applyFileOutcome, collectFiles, expandToCSharpFiles, isCSharp, isPathCleanable, runEngineCommand } from './cleanupCore';
import { replaceChangedPart, selectedLines } from './editorText';
import { readReorganizeSettings } from './reorganizeSettings';
import { readCleanupSettingsForUri } from './settings';

/** Reorganize, and the region commands that belong to it. */
export function registerReorganizeCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('codeJanitor.reorganizeActiveFile', reorganizeActiveFile),
    vscode.commands.registerCommand('codeJanitor.reorganizeSelectedFiles', reorganizeSelectedFiles),
    vscode.commands.registerCommand('codeJanitor.insertRegion', insertRegion),
    vscode.commands.registerCommand('codeJanitor.removeRegion', removeRegion)
  );
}

/** The engine's dry run of `reorganize`: whether preprocessor conditionals stop it, and the types it leaves alone. */
interface ReorganizeReport {
  readonly blockedByPreprocessor: boolean;
  readonly skipped: readonly string[];
}

/** What reorganizing one file did. */
interface Reorganization {
  readonly file: CollectedFile;
  readonly report: ReorganizeReport;
  /** Whether the file was reorganized (preprocessor conditionals allowing). */
  readonly reorganized: boolean;
  readonly changed: boolean;
  readonly error?: string;
}

/**
 * Reorganizes the files. Files with preprocessor conditionals are reorganized only when the
 * policy says yes; on "ask" the user is asked once for all of them (`CodeReorganizationAvailabilityLogic`).
 */
async function reorganizeFiles(files: readonly CollectedFile[]): Promise<Reorganization[]> {
  const reports: { file: CollectedFile; report?: ReorganizeReport; error?: unknown }[] = [];
  for (const file of files) {
    try {
      reports.push({ file, report: await engine().query<ReorganizeReport>({ ...documentParams(file.uri, file.content), query: 'reorganizeReport' }) });
    } catch (error) {
      reports.push({ file, error });
    }
  }

  const policy = readReorganizeSettings().performWhenPreprocessorConditionals;
  const blocked = reports.filter((entry) => entry.report?.blockedByPreprocessor);
  const permitted: PreprocessorPolicy =
    blocked.length > 0 && policy === 'ask'
      ? (await askAboutPreprocessorConditionals(blocked.map((entry) => path.basename(entry.file.uri.fsPath))))
        ? 'yes'
        : 'no'
      : policy;

  const outcomes: Reorganization[] = [];
  for (const { file, report, error } of reports) {
    const name = path.basename(file.uri.fsPath);
    // An unavailable engine was already reported once: its files fail with an empty error, shown nowhere else.
    const failed = (err: unknown): Reorganization => {
      const unavailable = reportEngineUnavailable(err);
      if (!unavailable) {
        logError(`Reorganize ${file.uri.fsPath}`, err);
      }

      return {
        file,
        report: { blockedByPreprocessor: false, skipped: [] },
        reorganized: false,
        changed: false,
        error: unavailable ? '' : (err as Error).message,
      };
    };
    if (!report) {
      outcomes.push(failed(error));
      continue;
    }

    for (const line of report.skipped) {
      logInfo(`Reorganize ${name}: ${line}`);
    }

    if (report.blockedByPreprocessor && permitted !== 'yes') {
      outcomes.push({ file, report, reorganized: false, changed: false });
      continue;
    }

    try {
      const outcome = await runEngineCommand(file, 'reorganize', 'Reorganize', { performWhenPreprocessorConditionals: permitted });
      await applyFileOutcome(file, outcome);
      outcomes.push({ file, report, reorganized: true, changed: outcome.text !== file.content });
    } catch (err) {
      outcomes.push(failed(err));
    }
  }

  return outcomes;
}

const REORGANIZE = 'Reorganize';
const ALWAYS = 'Always Reorganize';
const NEVER = 'Never Reorganize';

/** True to reorganize the files; "Always" and "Never" are remembered in the setting. */
async function askAboutPreprocessorConditionals(names: readonly string[]): Promise<boolean> {
  const subject = names.length === 1 ? names[0] : `${names.length} files`;
  const choice = await vscode.window.showWarningMessage(
    `Code Janitor: ${subject} ${names.length === 1 ? 'has' : 'have'} preprocessor conditionals (#if, #pragma). ` +
      'Each conditional block moves as a whole with its member, but reorganizing around conditionals can change what compiles. Reorganize anyway?',
    { modal: true },
    REORGANIZE,
    ALWAYS,
    NEVER
  );

  if (choice === ALWAYS || choice === NEVER) {
    await vscode.workspace
      .getConfiguration('codeJanitor')
      .update('reorganize.performWhenPreprocessorConditionals', choice === ALWAYS ? 'yes' : 'no', vscode.ConfigurationTarget.Global);
  }

  return choice === REORGANIZE || choice === ALWAYS;
}

function leftAloneNote(report: ReorganizeReport): string {
  return report.skipped.length > 0 ? ` ${report.skipped.length} type(s) left alone (see the Code Janitor output).` : '';
}

async function reorganizeActiveFile(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'csharp') {
    void vscode.window.showInformationMessage('Code Janitor: open a C# file to reorganize it.');

    return;
  }

  const name = path.basename(editor.document.uri.fsPath);
  const [outcome] = await reorganizeFiles([{ uri: editor.document.uri, content: editor.document.getText(), isOpen: true }]);
  if (outcome.error !== undefined) {
    if (outcome.error) {
      void vscode.window.showWarningMessage(`Code Janitor: ${name} was not reorganized - ${outcome.error}`);
    }

    return;
  }

  if (!outcome.reorganized) {
    void vscode.window.showInformationMessage(`Code Janitor: ${name} has preprocessor conditionals, so it was not reorganized.`);

    return;
  }

  if (!outcome.changed) {
    void vscode.window.showInformationMessage(`Code Janitor: nothing to reorganize.${leftAloneNote(outcome.report)}`);

    return;
  }

  if (outcome.report.skipped.length > 0) {
    void vscode.window.showInformationMessage(`Code Janitor: reorganized.${leftAloneNote(outcome.report)}`);
  }
}

async function reorganizeSelectedFiles(clicked?: vscode.Uri, selected?: vscode.Uri[]): Promise<void> {
  const targets = selected && selected.length > 0 ? selected : clicked ? [clicked] : [];
  if (targets.length === 0) {
    void vscode.window.showInformationMessage('Code Janitor: no files selected.');

    return;
  }

  const expanded = (await Promise.all(targets.map((target) => expandToCSharpFiles(target)))).flat().filter((uri) => isCSharp(uri) && isPathCleanable(uri));
  if (expanded.length === 0) {
    void vscode.window.showInformationMessage('Code Janitor: no C# files to reorganize.');

    return;
  }

  const outcomes = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Reorganizing selected files...' }, async () =>
    reorganizeFiles(await collectFiles(expanded))
  );

  const failed = outcomes.filter((outcome) => outcome.error !== undefined);
  for (const outcome of failed.filter((candidate) => candidate.error)) {
    void vscode.window.showWarningMessage(`Code Janitor: ${outcome.file.uri.fsPath} - ${outcome.error}`);
  }

  const blocked = outcomes.filter((outcome) => outcome.error === undefined && !outcome.reorganized).length;
  const leftAlone = outcomes.reduce((total, outcome) => total + outcome.report.skipped.length, 0);
  const parts = [`${outcomes.filter((outcome) => outcome.changed).length} file(s) changed`];
  if (failed.length > 0) {
    parts.push(`${failed.length} failed`);
  }
  if (blocked > 0) {
    parts.push(`${blocked} skipped because of preprocessor conditionals`);
  }
  if (leftAlone > 0) {
    parts.push(`${leftAlone} type(s) left alone (see the Code Janitor output)`);
  }

  void vscode.window.showInformationMessage(`Code Janitor: reorganize complete - ${parts.join(', ')}.`);
}

async function insertRegion(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'csharp') {
    void vscode.window.showInformationMessage('Code Janitor: open a C# file to insert a region.');

    return;
  }

  if (editor.selection.isEmpty) {
    void vscode.window.showInformationMessage('Code Janitor: select the lines to put in a region.');

    return;
  }

  const { firstLine, lastLine } = selectedLines(editor.selection);
  const inserted = insertRegionAroundLines(editor.document.getText(), firstLine, lastLine, readCleanupSettingsForUri(editor.document.uri));

  if (await replaceChangedPart(editor, inserted.text)) {
    // The name is selected, ready to be typed over.
    editor.selection = new vscode.Selection(
      new vscode.Position(inserted.nameLine, inserted.nameStart),
      new vscode.Position(inserted.nameLine, inserted.nameEnd)
    );
  }
}

/** Removes the regions in the selection, or the region whose directive is under the cursor. */
async function removeRegion(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'csharp') {
    void vscode.window.showInformationMessage('Code Janitor: open a C# file to remove a region.');

    return;
  }

  const file = { uri: editor.document.uri, content: editor.document.getText(), isOpen: true };
  const selected = editor.selection.isEmpty ? undefined : selectedLines(editor.selection);
  // The selection's regions, or only the region whose `#region` or `#endregion` is under the cursor (not the regions nested in it).
  const lines = selected ? { startLine: selected.firstLine, endLine: selected.lastLine } : { line: editor.selection.active.line };
  try {
    const outcome = await runEngineCommand(file, 'removeRegions', 'Remove Region', lines);
    if (outcome.text === file.content) {
      void vscode.window.showInformationMessage(
        'Code Janitor: there is no region under the cursor or in the selection. Use Remove Regions to remove all the regions of the file.'
      );

      return;
    }

    await applyFileOutcome(file, outcome);
  } catch (err) {
    if (!reportEngineUnavailable(err)) {
      logError(`Remove Region of ${file.uri.fsPath}`, err);
      void vscode.window.showWarningMessage(`Code Janitor: ${(err as Error).message}`);
    }
  }
}
