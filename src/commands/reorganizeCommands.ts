import * as path from 'node:path';
import * as vscode from 'vscode';
import { regionLinesAt, insertRegionAroundLines, removeRegionsInLines } from '../reorganize/regionEdits';
import { ReorganizeResult, reorganizeSourceDetailed } from '../reorganize/reorganize';
import { ReorganizeSettings } from '../reorganize/settings';
import { CleanupSettings } from '../cleanup/types';
import { logInfo } from '../logging';
import { CollectedFile, collectFiles, expandToCSharpFiles, isCSharp, isPathCleanable, writeFileContent } from './cleanupCore';
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

interface ReorganizeTarget {
  name: string;
  content: string;
  /** The cleanup settings of the file: its nearest `.codejanitor` applies. */
  cleanup: CleanupSettings;
}

interface Reorganization {
  file: ReorganizeTarget;
  result: ReorganizeResult;
}

/**
 * Reorganizes the files. Files with preprocessor conditionals are reorganized only when the
 * policy says yes; on "ask" the user is asked once for all of them (`CodeReorganizationAvailabilityLogic`).
 */
async function reorganizeFiles(files: readonly ReorganizeTarget[], settings: ReorganizeSettings): Promise<Reorganization[]> {
  let outcomes = files.map((file) => ({ file, result: reorganizeSourceDetailed(file.content, settings, file.cleanup) }));
  const blocked = outcomes.filter((outcome) => outcome.result.blockedByPreprocessor);

  if (blocked.length > 0 && settings.performWhenPreprocessorConditionals === 'ask' && (await askAboutPreprocessorConditionals(blocked.map((outcome) => outcome.file.name)))) {
    const permissive: ReorganizeSettings = { ...settings, performWhenPreprocessorConditionals: 'yes' };
    outcomes = outcomes.map((outcome) =>
      outcome.result.blockedByPreprocessor
        ? { file: outcome.file, result: reorganizeSourceDetailed(outcome.file.content, permissive, outcome.file.cleanup) }
        : outcome
    );
  }

  for (const { file, result } of outcomes) {
    for (const line of result.skipped) {
      logInfo(`Reorganize ${file.name}: ${line}`);
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

function leftAloneNote(result: ReorganizeResult): string {
  return result.skipped.length > 0 ? ` ${result.skipped.length} type(s) left alone (see the Code Janitor output).` : '';
}

async function reorganizeActiveFile(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'csharp') {
    void vscode.window.showInformationMessage('Code Janitor: open a C# file to reorganize it.');

    return;
  }

  const name = path.basename(editor.document.uri.fsPath);
  const source = editor.document.getText();
  const [{ result }] = await reorganizeFiles([{ name, content: source, cleanup: readCleanupSettingsForUri(editor.document.uri) }], readReorganizeSettings());

  if (result.blockedByPreprocessor) {
    void vscode.window.showInformationMessage(`Code Janitor: ${name} has preprocessor conditionals, so it was not reorganized.`);

    return;
  }

  if (result.output === source) {
    void vscode.window.showInformationMessage(`Code Janitor: nothing to reorganize.${leftAloneNote(result)}`);

    return;
  }

  if (!(await replaceChangedPart(editor, result.output))) {
    void vscode.window.showWarningMessage(`Code Janitor: VS Code did not apply the reorganization of ${name}.`);

    return;
  }

  if (result.skipped.length > 0) {
    void vscode.window.showInformationMessage(`Code Janitor: reorganized.${leftAloneNote(result)}`);
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

  const summary = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Reorganizing selected files...' },
    () => reorganizeUris(expanded)
  );

  const parts = [`${summary.changed} file(s) changed`];
  if (summary.failed > 0) {
    parts.push(`${summary.failed} failed`);
  }
  if (summary.blocked > 0) {
    parts.push(`${summary.blocked} skipped because of preprocessor conditionals`);
  }
  if (summary.leftAlone > 0) {
    parts.push(`${summary.leftAlone} type(s) left alone (see the Code Janitor output)`);
  }

  void vscode.window.showInformationMessage(`Code Janitor: reorganize complete - ${parts.join(', ')}.`);
}

async function reorganizeUris(uris: vscode.Uri[]): Promise<{ changed: number; failed: number; blocked: number; leftAlone: number }> {
  const collected = await collectFiles(uris);
  const outcomes = await reorganizeFiles(
    collected.map((file) => ({ name: path.basename(file.uri.fsPath), content: file.content, cleanup: readCleanupSettingsForUri(file.uri) })),
    readReorganizeSettings()
  );

  let changed = 0;
  let failed = 0;
  let blocked = 0;
  let leftAlone = 0;

  for (const [index, { result }] of outcomes.entries()) {
    const file: CollectedFile = collected[index];
    leftAlone += result.skipped.length;
    blocked += result.blockedByPreprocessor ? 1 : 0;

    if (result.output === file.content) {
      continue;
    }

    try {
      await writeFileContent(file, result.output);
      changed++;
    } catch (error) {
      failed++;
      void vscode.window.showWarningMessage(`Code Janitor: ${file.uri.fsPath} - ${(error as Error).message}`);
    }
  }

  return { changed, failed, blocked, leftAlone };
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
    editor.selection = new vscode.Selection(new vscode.Position(inserted.nameLine, inserted.nameStart), new vscode.Position(inserted.nameLine, inserted.nameEnd));
  }
}

/** Removes the regions in the selection, or the region whose directive is under the cursor. */
async function removeRegion(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'csharp') {
    void vscode.window.showInformationMessage('Code Janitor: open a C# file to remove a region.');

    return;
  }

  const source = editor.document.getText();
  let lines: { firstLine: number; lastLine: number } | undefined;

  if (!editor.selection.isEmpty) {
    lines = selectedLines(editor.selection);
  } else {
    const region = regionLinesAt(source, editor.selection.active.line);
    lines = region && { firstLine: region.startLine, lastLine: region.endLine };
  }

  const output = lines ? removeRegionsInLines(source, lines.firstLine, lines.lastLine) : source;
  if (output === source) {
    void vscode.window.showInformationMessage(
      'Code Janitor: there is no region under the cursor or in the selection. Use Remove Regions to remove all the regions of the file.'
    );

    return;
  }

  await replaceChangedPart(editor, output);
}
