import * as vscode from 'vscode';
import {
  BatchResult,
  FileOutcome,
  applyFileOutcome,
  cleanupCSharpResult,
  cleanupFileGlob,
  cleanupOtherLanguage,
  engineOutcome,
  expandToCSharpFiles,
  expandToCleanableFiles,
  expandToCommentFiles,
  externalFileCleanup,
  isCSharp,
  isCleanupTarget,
  isOutsideWorkspaceFolders,
  isSupportedFile,
  openDocumentVersions,
  runCleanupOnUris,
  runFixNamespaceOnUris,
  runFormatCommentsOnUris,
  runRemoveRegionsOnUris,
  runRemoveXmlDocOnUris,
  runSplitTopLevelTypesOnUris,
} from './cleanupCore';
import { runCleanupPreview } from './cleanupPreviewUi';
import { RuleResult } from '../engine/protocol';
import { reportEngineUnavailable } from '../engine/vscodeEngine';
import { logDiagnostic, logError } from '../logging';

const NO_FILES_MESSAGE = 'Code Janitor: no C# files to preview in the selection.';
const WORKSPACE_EXCLUDE = '**/{bin,obj,node_modules,.git}/**';

/** The files a menu command acts on: the multi-selection when there is one, otherwise the clicked file. */
function selectedTargets(clicked?: vscode.Uri, selected?: vscode.Uri[]): vscode.Uri[] {
  return selected && selected.length > 0 ? selected : clicked ? [clicked] : [];
}

/** The open files cleanup acts on (Razor files included while they are formatted). */
function openFileUris(): vscode.Uri[] {
  return vscode.workspace.textDocuments.filter((doc) => !doc.isClosed && doc.uri.scheme === 'file' && isCleanupTarget(doc.uri)).map((doc) => doc.uri);
}

/** Folders expand to their C# files; a file the user selected stays in the preview, which says why it is skipped. */
async function expandSelectedForPreview(targets: readonly vscode.Uri[]): Promise<vscode.Uri[]> {
  return (await Promise.all(targets.map((uri) => expandToCSharpFiles(uri)))).flat();
}

const START_CLEANUP = 'Start Cleanup';
const PREVIEW_CLEANUP = 'Preview C# Text Changes';

/**
 * The one-time options dialog of Cleanup Selected Code (`codeJanitor.cleanup.showOptionsDialog`):
 * start the cleanup, or preview its C# text changes first. Off by default - the command then
 * starts the cleanup at once. `undefined` when the user cancels.
 */
async function chooseSelectedScopeAction(fileCount: number): Promise<'start' | 'preview' | undefined> {
  if (!vscode.workspace.getConfiguration('codeJanitor').get<boolean>('cleanup.showOptionsDialog', false)) {
    return 'start';
  }

  const choice = await vscode.window.showQuickPick(
    [
      { label: START_CLEANUP, description: 'Clean the selected files now', detail: `${fileCount} file(s) in the selection` },
      {
        label: PREVIEW_CLEANUP,
        description: 'Review the changes per file and rule before applying them',
        detail: 'Nothing is written and no AI is used; C# files only',
      },
    ],
    { title: 'Code Janitor: Cleanup Selected Code', placeHolder: 'Start the cleanup, or preview the changes first', ignoreFocusOut: true }
  );

  return choice === undefined ? undefined : choice.label === PREVIEW_CLEANUP ? 'preview' : 'start';
}

export function registerCleanupCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('codeJanitor.cleanupActiveFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showInformationMessage('Code Janitor: no active editor.');

        return;
      }

      await runWithProgress('Cleaning up active file...', (token) => runCleanupOnUris(context, [editor.document.uri], { token }));
    }),

    vscode.commands.registerCommand('codeJanitor.previewCleanupActiveFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showInformationMessage('Code Janitor: no active editor.');

        return;
      }

      await previewCleanupActiveDocument(context, editor);
    }),

    vscode.commands.registerCommand('codeJanitor.cleanupSelectedFiles', async (clicked?: vscode.Uri, selected?: vscode.Uri[]) => {
      const targets = selectedTargets(clicked, selected);
      if (targets.length === 0) {
        void vscode.window.showInformationMessage('Code Janitor: no files selected.');

        return;
      }

      const expanded = (await Promise.all(targets.map((u) => expandToCleanableFiles(u)))).flat();
      const choice = await chooseSelectedScopeAction(expanded.length);
      if (choice === 'start') {
        await runWithProgress('Cleaning up selected files...', (token) => runCleanupOnUris(context, expanded, { renameAcrossWorkspace: true, token }));
      } else if (choice === 'preview') {
        await runCleanupPreview(context, { uris: await expandSelectedForPreview(targets), emptyMessage: NO_FILES_MESSAGE });
      }
    }),

    vscode.commands.registerCommand('codeJanitor.previewCleanupSelectedFiles', async (clicked?: vscode.Uri, selected?: vscode.Uri[]) => {
      const targets = selectedTargets(clicked, selected);
      if (targets.length === 0) {
        void vscode.window.showInformationMessage('Code Janitor: no files selected.');

        return;
      }

      await runCleanupPreview(context, { uris: await expandSelectedForPreview(targets), emptyMessage: NO_FILES_MESSAGE });
    }),

    vscode.commands.registerCommand('codeJanitor.previewCleanupOpenFiles', async () => {
      await runCleanupPreview(context, {
        uris: openFileUris().filter(isCSharp),
        emptyMessage: 'Code Janitor: no open C# files to preview.',
      });
    }),

    vscode.commands.registerCommand('codeJanitor.previewCleanupChangedFiles', async () => {
      const changed = await collectSourceControlChanges();
      if (changed === undefined) {
        void vscode.window.showWarningMessage('Code Janitor: the built-in Git extension is not available.');

        return;
      }

      await runCleanupPreview(context, {
        uris: changed.filter(isCSharp),
        emptyMessage: 'Code Janitor: no changed C# files to preview.',
        honorOnlyChangedLines: true,
      });
    }),

    vscode.commands.registerCommand('codeJanitor.previewCleanupWorkspace', async () => {
      await runCleanupPreview(context, {
        uris: await vscode.workspace.findFiles('**/*.cs', WORKSPACE_EXCLUDE),
        emptyMessage: 'Code Janitor: no C# files found in the workspace.',
      });
    }),

    vscode.commands.registerCommand('codeJanitor.removeXmlDocSelectedFiles', async (clicked?: vscode.Uri, selected?: vscode.Uri[]) => {
      const targets = selected && selected.length > 0 ? selected : clicked ? [clicked] : [];
      if (targets.length === 0) {
        void vscode.window.showInformationMessage('Code Janitor: no files selected.');

        return;
      }

      const expanded = (await Promise.all(targets.map((u) => expandToCSharpFiles(u)))).flat();

      await runWithProgress(
        'Removing XML documentation from selected files...',
        (token) => runRemoveXmlDocOnUris(expanded, token),
        'XML documentation removed'
      );
    }),

    vscode.commands.registerCommand('codeJanitor.fixNamespaceSelectedFiles', async (clicked?: vscode.Uri, selected?: vscode.Uri[]) => {
      const targets = selected && selected.length > 0 ? selected : clicked ? [clicked] : [];
      if (targets.length === 0) {
        void vscode.window.showInformationMessage('Code Janitor: no files selected.');

        return;
      }

      const expanded = (await Promise.all(targets.map((u) => expandToCSharpFiles(u)))).flat();

      await runWithProgress('Fixing namespaces in selected files...', (token) => runFixNamespaceOnUris(expanded, token), 'namespaces fixed');
    }),

    vscode.commands.registerCommand('codeJanitor.removeRegionsSelectedFiles', async (clicked?: vscode.Uri, selected?: vscode.Uri[]) => {
      const targets = selected && selected.length > 0 ? selected : clicked ? [clicked] : [];
      if (targets.length === 0) {
        void vscode.window.showInformationMessage('Code Janitor: no files selected.');

        return;
      }

      const expanded = (await Promise.all(targets.map((u) => expandToCSharpFiles(u)))).flat();

      await runWithProgress('Removing regions from selected files...', (token) => runRemoveRegionsOnUris(expanded, token), 'regions removed');
    }),

    vscode.commands.registerCommand('codeJanitor.formatCommentsSelectedFiles', async (clicked?: vscode.Uri, selected?: vscode.Uri[]) => {
      const targets = selected && selected.length > 0 ? selected : clicked ? [clicked] : [];
      if (targets.length === 0) {
        void vscode.window.showInformationMessage('Code Janitor: no files selected.');

        return;
      }

      const expanded = (await Promise.all(targets.map((u) => expandToCommentFiles(u)))).flat();

      await runWithProgress('Formatting comments in selected files...', (token) => runFormatCommentsOnUris(expanded, token), 'comments formatted');
    }),

    vscode.commands.registerCommand('codeJanitor.cleanupOpenFiles', async () => {
      const open = openFileUris();

      if (open.length === 0) {
        void vscode.window.showInformationMessage('Code Janitor: no open files to clean up.');

        return;
      }

      await runWithProgress(`Cleaning up ${open.length} open file(s)...`, (token) => runCleanupOnUris(context, open, { token }));
    }),

    vscode.commands.registerCommand('codeJanitor.cleanupChangedFiles', async () => {
      const changed = await collectSourceControlChanges();
      if (changed === undefined) {
        void vscode.window.showWarningMessage('Code Janitor: the built-in Git extension is not available.');

        return;
      }

      if (changed.length === 0) {
        void vscode.window.showInformationMessage('Code Janitor: no changed files to clean up.');

        return;
      }

      await runWithProgress(`Cleaning up ${changed.length} changed file(s)...`, (token) =>
        runCleanupOnUris(context, changed, { honorOnlyChangedLines: true, token })
      );
    }),

    vscode.commands.registerCommand('codeJanitor.cleanupWorkspace', async () => {
      const files = await vscode.workspace.findFiles(cleanupFileGlob(), WORKSPACE_EXCLUDE);

      if (files.length === 0) {
        void vscode.window.showInformationMessage('Code Janitor: no files found in the workspace.');

        return;
      }

      await runWithProgress(`Cleaning up ${files.length} file(s)...`, (token) => runCleanupOnUris(context, files, { renameAcrossWorkspace: true, token }));
    }),

    vscode.commands.registerCommand('codeJanitor.removeXmlDocWorkspace', async () => {
      const files = await vscode.workspace.findFiles('**/*.cs', '**/{bin,obj,node_modules,.git}/**');

      if (files.length === 0) {
        void vscode.window.showInformationMessage('Code Janitor: no C# files found in the workspace.');

        return;
      }

      await runWithProgress(
        `Removing XML documentation from ${files.length} file(s)...`,
        (token) => runRemoveXmlDocOnUris(files, token),
        'XML documentation removed'
      );
    }),

    vscode.commands.registerCommand('codeJanitor.toggleCleanupOnSave', async () => {
      const config = vscode.workspace.getConfiguration('codeJanitor');
      const enabled = !config.get<boolean>('cleanup.onSave', false);
      await config.update('cleanup.onSave', enabled, vscode.ConfigurationTarget.Workspace);

      void vscode.window.showInformationMessage(`Code Janitor: cleanup on save ${enabled ? 'enabled' : 'disabled'}.`);
    }),

    vscode.commands.registerCommand('codeJanitor.splitTopLevelTypes', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showInformationMessage('Code Janitor: no active editor.');

        return;
      }

      await runWithProgress('Splitting top-level types...', (token) => runSplitTopLevelTypesOnUris([editor.document.uri], token), 'top-level types split');
    }),

    vscode.commands.registerCommand('codeJanitor.splitTopLevelTypesSelectedFiles', async (clicked?: vscode.Uri, selected?: vscode.Uri[]) => {
      const targets = selected && selected.length > 0 ? selected : clicked ? [clicked] : [];
      if (targets.length === 0) {
        void vscode.window.showInformationMessage('Code Janitor: no files selected.');

        return;
      }

      const expanded = (await Promise.all(targets.map((u) => expandToCSharpFiles(u)))).flat();

      await runWithProgress('Splitting top-level types in selected files...', (token) => runSplitTopLevelTypesOnUris(expanded, token), 'top-level types split');
    })
  );
}

/** The Git extension's `Status` numbers before `IGNORED`, the same in every version of its API. */
const INDEX_DELETED = 2;
const DELETED = 6;

/**
 * The changed files that still exist: a file deleted from the working tree is left out, and so is one
 * deleted from the index unless the working tree has it again. Uses the built-in Git extension;
 * returns `undefined` when it is not installed.
 */
async function collectSourceControlChanges(): Promise<vscode.Uri[] | undefined> {
  const gitExtension = vscode.extensions.getExtension('vscode.git');
  if (!gitExtension) {
    return undefined;
  }

  const api = (await gitExtension.activate())?.getAPI?.(1);
  if (!api) {
    return undefined;
  }

  const seen = new Map<string, vscode.Uri>();
  const deleted = new Set<string>();

  for (const repository of api.repositories ?? []) {
    for (const change of repository.state.workingTreeChanges ?? []) {
      if (change.status === DELETED) {
        deleted.add(change.uri.toString());
      }
    }

    const changes = [...(repository.state.workingTreeChanges ?? []), ...(repository.state.indexChanges ?? []), ...(repository.state.mergeChanges ?? [])];

    for (const change of changes) {
      const uri: vscode.Uri = change.uri;
      if (isCleanupTarget(uri) && change.status !== INDEX_DELETED && !deleted.has(uri.toString())) {
        seen.set(uri.toString(), uri);
      }
    }
  }

  return [...seen.values()];
}

async function runWithProgress(
  title: string,
  action: (token: vscode.CancellationToken) => Promise<BatchResult & { unresolved?: number; created?: number }>,
  doneLabel = 'cleanup complete'
): Promise<void> {
  const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, (_progress, token) =>
    action(token)
  );

  const parts = [`${result.changed} file(s) changed`];
  if (result.created) {
    parts.push(`${result.created} file(s) created (one type per file)`);
  }

  if (result.failed > 0) {
    parts.push(`${result.failed} failed`);
  }

  if (result.cancelled) {
    parts.push('cancelled before finishing');
  }

  if (result.unresolved) {
    parts.push(`${result.unresolved} .editorconfig rule violation(s) not fixed (see the Code Janitor output)`);
    void vscode.window.showWarningMessage(`Code Janitor: ${doneLabel} - ${parts.join(', ')}.`);

    return;
  }

  void vscode.window.showInformationMessage(`Code Janitor: ${doneLabel} - ${parts.join(', ')}.`);
}

/** One choice of "Choose Rules...": a rule or step of the cleanup that changes the file. */
interface PreviewChoice extends vscode.QuickPickItem {
  readonly rule: string;
}

const CHOOSE_RULES = 'Choose Rules...';

/** The rules that change the file, labeled with their number of changes. */
function previewChoices(rules: readonly RuleResult[]): PreviewChoice[] {
  const changes = (count: number) => `${count} ${count === 1 ? 'change' : 'changes'}`;

  return rules
    .filter((rule) => rule.changes > 0)
    .map((rule) => ({
      label: `${rule.name} (${changes(rule.changes)})`,
      description: rule.id !== rule.name ? rule.id : undefined,
      rule: rule.id,
      picked: true,
    }));
}

/** The cleanup of a document without the rules left out, what each rule changed, and the open document versions it was computed from. */
interface ActivePreview {
  readonly outcome: FileOutcome;
  readonly rules: readonly RuleResult[];
  readonly openVersions: ReadonlyMap<string, number>;
}

async function previewCleanupActiveDocument(_context: vscode.ExtensionContext, editor: vscode.TextEditor): Promise<void> {
  const document = editor.document;
  if (!isSupportedFile(document.uri)) {
    void vscode.window.showInformationMessage('Code Janitor: active file is not a supported file type.');

    return;
  }

  const partial = isOutsideWorkspaceFolders(document.uri);
  const skipBecause = partial ? (await externalFileCleanup(document.uri, false)).skipBecause : undefined;
  if (skipBecause) {
    void vscode.window.showInformationMessage(`Code Janitor: ${document.uri.fsPath} skipped: ${skipBecause}.`);

    return;
  }

  const file = { uri: document.uri, content: document.getText(), isOpen: true };
  const compute = async (excludedRules: readonly string[]): Promise<ActivePreview> => {
    const openVersions = openDocumentVersions();
    if (!isCSharp(document.uri)) {
      return { outcome: { text: await cleanupOtherLanguage(file), otherFiles: [], newFiles: [], unresolved: 0 }, rules: [], openVersions };
    }

    const result = await cleanupCSharpResult(file, { renameAcrossWorkspace: false, honorOnlyChangedLines: false, partial, excludedRules });
    // Only the complete first preview logs: the previews without some rules repeat its messages.
    const outcome =
      excludedRules.length === 0
        ? engineOutcome(document.uri, result, 'Preview cleanup')
        : { text: result.text, otherFiles: result.otherFiles, newFiles: result.newFiles, unresolved: result.unresolved.length };

    return { outcome, rules: result.rules, openVersions };
  };
  const changes = (preview: ActivePreview) =>
    preview.outcome.text !== file.content || preview.outcome.otherFiles.length > 0 || preview.outcome.newFiles.length > 0;

  let full: ActivePreview;
  try {
    full = await compute([]);
  } catch (err) {
    if (!reportEngineUnavailable(err)) {
      logError(`Preview cleanup of ${document.uri.fsPath}`, err);
      void vscode.window.showWarningMessage(`Code Janitor: ${document.uri.fsPath} - ${(err as Error).message}`);
    }

    return;
  }

  const unresolved = full.outcome.unresolved;
  if (!changes(full)) {
    void (unresolved > 0
      ? vscode.window.showWarningMessage(
          `Code Janitor: no changes, but ${unresolved} .editorconfig rule violation(s) could not be fixed (see the Code Janitor output).`
        )
      : vscode.window.showInformationMessage('Code Janitor: file is already clean (no changes).'));

    return;
  }

  const choices = previewChoices(full.rules);
  logDiagnostic(
    `Preview cleanup for ${document.fileName}: ${choices.length} rule(s) would make changes (${choices
      .map((choice) => choice.label)
      .join(', ')})${unresolved > 0 ? `; ${unresolved} .editorconfig rule violation(s) could not be fixed` : ''}.`
  );

  const fileName = document.fileName.split(/[\\/]/).pop() ?? 'file';
  let preview = full;
  let excluded = new Set<string>();
  for (;;) {
    const hasChanges = changes(preview);
    const previewDoc = await vscode.workspace.openTextDocument({ content: preview.outcome.text.replace(/^\uFEFF/, ''), language: document.languageId });
    await vscode.commands.executeCommand('vscode.diff', document.uri, previewDoc.uri, `Code Janitor: Cleanup Preview (${fileName})`);

    const choice = await vscode.window.showInformationMessage(
      hasChanges ? `Code Janitor: apply cleanup changes to ${fileName}?` : 'Code Janitor: no changes with the chosen rules.',
      { modal: true },
      ...(hasChanges ? ['Apply'] : []),
      ...(choices.length > 0 ? [CHOOSE_RULES] : [])
    );
    if (choice !== CHOOSE_RULES) {
      if (choice === 'Apply') {
        break;
      }

      return;
    }

    const picked = await vscode.window.showQuickPick(
      choices.map((item) => ({ ...item, picked: !excluded.has(item.rule) })),
      { canPickMany: true, title: `Code Janitor: changes to apply to ${fileName}` }
    );
    if (picked) {
      excluded = new Set(choices.filter((item) => !picked.some((p) => p.rule === item.rule)).map((item) => item.rule));
      try {
        preview = await compute([...excluded]);
      } catch (err) {
        logError(`Preview cleanup of ${document.uri.fsPath}`, err);
        void vscode.window.showWarningMessage(`Code Janitor: ${document.uri.fsPath} - ${(err as Error).message}`);

        return;
      }
    }
  }

  if (document.isClosed) {
    void vscode.window.showWarningMessage('Code Janitor: the document was closed before preview could be applied.');

    return;
  }

  if (document.getText() !== file.content) {
    void vscode.window.showWarningMessage('Code Janitor: the file changed since preview was generated. Please run preview again.');

    return;
  }

  try {
    await applyFileOutcome(file, preview.outcome, preview.openVersions);
    logDiagnostic(`Preview cleanup applied to ${document.fileName}.`);
    void vscode.window.showInformationMessage('Code Janitor: cleanup applied.');
  } catch (err) {
    logError(`Preview cleanup of ${document.uri.fsPath}`, err);
    void vscode.window.showWarningMessage(`Code Janitor: ${document.uri.fsPath} - ${(err as Error).message}`);
  }
}
