import * as vscode from 'vscode';
import {
  createEditorConfigIssueLog,
  discoverDisqualifiedTypeNamesForFile,
  expandToCSharpFiles,
  expandToCleanableFiles,
  isCSharp,
  isSupportedFile,
  runCleanupOnUris,
  runFixNamespaceOnUris,
  runFormatCommentsOnUris,
  runRemoveRegionsOnUris,
  runRemoveXmlDocOnUris,
  runSplitTopLevelTypesOnUris,
} from './cleanupCore';
import { runCleanupPreview } from './cleanupPreviewUi';
import { PreviewResult } from '../cleanup/pipeline';
import { getCleanupPipeline } from '../cleanup/runCleanup';
import { readCleanupSettingsForUri } from './settings';
import { logInfo } from '../logging';

const NO_FILES_MESSAGE = 'Code Janitor: no C# files to preview in the selection.';
const WORKSPACE_EXCLUDE = '**/{bin,obj,node_modules,.git}/**';

/** The files a menu command acts on: the multi-selection when there is one, otherwise the clicked file. */
function selectedTargets(clicked?: vscode.Uri, selected?: vscode.Uri[]): vscode.Uri[] {
  return selected && selected.length > 0 ? selected : clicked ? [clicked] : [];
}

function openFileUris(): vscode.Uri[] {
  return vscode.workspace.textDocuments.filter((doc) => !doc.isClosed && doc.uri.scheme === 'file' && isSupportedFile(doc.uri)).map((doc) => doc.uri);
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

      await runWithProgress('Cleaning up active file...', () => runCleanupOnUris(context, [editor.document.uri]));
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
        await runWithProgress('Cleaning up selected files...', () => runCleanupOnUris(context, expanded, { renameAcrossWorkspace: true }));
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

    vscode.commands.registerCommand(
      'codeJanitor.removeXmlDocSelectedFiles',
      async (clicked?: vscode.Uri, selected?: vscode.Uri[]) => {
        const targets = selected && selected.length > 0 ? selected : clicked ? [clicked] : [];
        if (targets.length === 0) {
          void vscode.window.showInformationMessage('Code Janitor: no files selected.');

          return;
        }

        const expanded = (await Promise.all(targets.map((u) => expandToCSharpFiles(u)))).flat();

        await runWithProgress(
          'Removing XML documentation from selected files...',
          () => runRemoveXmlDocOnUris(expanded),
          'XML documentation removed'
        );
      }
    ),

    vscode.commands.registerCommand(
      'codeJanitor.fixNamespaceSelectedFiles',
      async (clicked?: vscode.Uri, selected?: vscode.Uri[]) => {
        const targets = selected && selected.length > 0 ? selected : clicked ? [clicked] : [];
        if (targets.length === 0) {
          void vscode.window.showInformationMessage('Code Janitor: no files selected.');

          return;
        }

        const expanded = (await Promise.all(targets.map((u) => expandToCSharpFiles(u)))).flat();

        await runWithProgress(
          'Fixing namespaces in selected files...',
          () => runFixNamespaceOnUris(expanded),
          'namespaces fixed'
        );
      }
    ),

    vscode.commands.registerCommand(
      'codeJanitor.removeRegionsSelectedFiles',
      async (clicked?: vscode.Uri, selected?: vscode.Uri[]) => {
        const targets = selected && selected.length > 0 ? selected : clicked ? [clicked] : [];
        if (targets.length === 0) {
          void vscode.window.showInformationMessage('Code Janitor: no files selected.');

          return;
        }

        const expanded = (await Promise.all(targets.map((u) => expandToCSharpFiles(u)))).flat();

        await runWithProgress(
          'Removing regions from selected files...',
          () => runRemoveRegionsOnUris(expanded),
          'regions removed'
        );
      }
    ),

    vscode.commands.registerCommand(
      'codeJanitor.formatCommentsSelectedFiles',
      async (clicked?: vscode.Uri, selected?: vscode.Uri[]) => {
        const targets = selected && selected.length > 0 ? selected : clicked ? [clicked] : [];
        if (targets.length === 0) {
          void vscode.window.showInformationMessage('Code Janitor: no files selected.');

          return;
        }

        const expanded = (await Promise.all(targets.map((u) => expandToCSharpFiles(u)))).flat();

        await runWithProgress(
          'Formatting comments in selected files...',
          () => runFormatCommentsOnUris(expanded),
          'comments formatted'
        );
      }
    ),

    vscode.commands.registerCommand('codeJanitor.cleanupOpenFiles', async () => {
      const open = openFileUris();

      if (open.length === 0) {
        void vscode.window.showInformationMessage('Code Janitor: no open files to clean up.');

        return;
      }

      await runWithProgress(`Cleaning up ${open.length} open file(s)...`, () => runCleanupOnUris(context, open));
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

      await runWithProgress(`Cleaning up ${changed.length} changed file(s)...`, () =>
        runCleanupOnUris(context, changed, { honorOnlyChangedLines: true })
      );
    }),

    vscode.commands.registerCommand('codeJanitor.cleanupWorkspace', async () => {
      const includeOthers = vscode.workspace
        .getConfiguration('codeJanitor')
        .get<boolean>('cleanup.includeOtherFileTypes', false);

      const files = await vscode.workspace.findFiles(
        includeOthers ? '**/*' : '**/*.cs',
        '**/{bin,obj,node_modules,.git}/**'
      );

      if (files.length === 0) {
        void vscode.window.showInformationMessage('Code Janitor: no files found in the workspace.');

        return;
      }

      await runWithProgress(`Cleaning up ${files.length} file(s)...`, () => runCleanupOnUris(context, files, { renameAcrossWorkspace: true }));
    }),

    vscode.commands.registerCommand('codeJanitor.removeXmlDocWorkspace', async () => {
      const files = await vscode.workspace.findFiles('**/*.cs', '**/{bin,obj,node_modules,.git}/**');

      if (files.length === 0) {
        void vscode.window.showInformationMessage('Code Janitor: no C# files found in the workspace.');

        return;
      }

      await runWithProgress(
        `Removing XML documentation from ${files.length} file(s)...`,
        () => runRemoveXmlDocOnUris(files),
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

      await runWithProgress(
        'Splitting top-level types...',
        () => runSplitTopLevelTypesOnUris([editor.document.uri]),
        'top-level types split'
      );
    }),

    vscode.commands.registerCommand(
      'codeJanitor.splitTopLevelTypesSelectedFiles',
      async (clicked?: vscode.Uri, selected?: vscode.Uri[]) => {
        const targets = selected && selected.length > 0 ? selected : clicked ? [clicked] : [];
        if (targets.length === 0) {
          void vscode.window.showInformationMessage('Code Janitor: no files selected.');

          return;
        }

        const expanded = (await Promise.all(targets.map((u) => expandToCSharpFiles(u)))).flat();

        await runWithProgress(
          'Splitting top-level types in selected files...',
          () => runSplitTopLevelTypesOnUris(expanded),
          'top-level types split'
        );
      }
    )
  );
}

/** Uses the built-in Git extension; returns `undefined` when it is not installed. */
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

  for (const repository of api.repositories ?? []) {
    const changes = [
      ...(repository.state.workingTreeChanges ?? []),
      ...(repository.state.indexChanges ?? []),
      ...(repository.state.mergeChanges ?? []),
    ];

    for (const change of changes) {
      const uri: vscode.Uri = change.uri;
      if (isSupportedFile(uri)) {
        seen.set(uri.toString(), uri);
      }
    }
  }

  return [...seen.values()];
}

async function runWithProgress(
  title: string,
  action: () => Promise<{ changed: number; failed: number; unresolved?: number; created?: number }>,
  doneLabel = 'cleanup complete'
): Promise<void> {
  const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, action);

  const parts = [`${result.changed} file(s) changed`];
  if (result.created) {
    parts.push(`${result.created} file(s) created (one type per file)`);
  }

  if (result.failed > 0) {
    parts.push(`${result.failed} failed`);
  }

  if (result.unresolved) {
    parts.push(`${result.unresolved} .editorconfig rule violation(s) not fixed (see the Code Janitor output)`);
    void vscode.window.showWarningMessage(`Code Janitor: ${doneLabel} - ${parts.join(', ')}.`);

    return;
  }

  void vscode.window.showInformationMessage(`Code Janitor: ${doneLabel} - ${parts.join(', ')}.`);
}

/** One choice of "Choose Rules...": a step of the pipeline, or one rule of a step made of rules. */
interface PreviewChoice extends vscode.QuickPickItem {
  readonly step: number;
  readonly rule?: string;
}

const CHOOSE_RULES = 'Choose Rules...';

/** The steps and rules that change the file, labeled with their number of changes. */
function previewChoices(preview: PreviewResult): PreviewChoice[] {
  const changes = (count: number) => `${count} ${count === 1 ? 'change' : 'changes'}`;

  return preview.steps.flatMap((step): PreviewChoice[] =>
    step.rules
      ? step.rules
          .filter((rule) => rule.changes > 0)
          .map((rule) => ({ label: `${rule.id} (${changes(rule.changes)})`, description: step.name, step: step.index, rule: rule.id, picked: true }))
      : step.changed
        ? [{ label: `${step.name} (${changes(step.changes)})`, step: step.index, picked: true }]
        : []
  );
}

async function previewCleanupActiveDocument(_context: vscode.ExtensionContext, editor: vscode.TextEditor): Promise<void> {
  const document = editor.document;
  if (!isSupportedFile(document.uri)) {
    void vscode.window.showInformationMessage('Code Janitor: active file is not a supported file type.');

    return;
  }

  const content = document.getText();
  const settings = readCleanupSettingsForUri(document.uri);
  const disqualifiedTypeNames = await discoverDisqualifiedTypeNamesForFile(document.uri, content);
  // Only the first, complete preview reports issues: previews without some rules repeat them.
  const issues = createEditorConfigIssueLog(true);
  let reporting = true;
  const pipeline = getCleanupPipeline(content, document.uri.fsPath, settings, disqualifiedTypeNames, (issue) => {
    if (reporting) {
      issues.report(issue);
    }
  });

  const full = pipeline.preview(content);
  reporting = false;
  const { unresolved } = issues.finish();
  if (!full.hasChanges) {
    void (unresolved > 0
      ? vscode.window.showWarningMessage(
          `Code Janitor: no changes, but ${unresolved} .editorconfig rule violation(s) could not be fixed (see the Code Janitor output).`
        )
      : vscode.window.showInformationMessage('Code Janitor: file is already clean (no changes).'));

    return;
  }

  const choices = previewChoices(full);
  logInfo(
    `Preview cleanup for ${document.fileName}: ${choices.length} rule(s) would make changes (${choices
      .map((choice) => choice.label)
      .join(', ')})${unresolved > 0 ? `; ${unresolved} .editorconfig rule violation(s) could not be fixed` : ''}.`
  );

  const fileName = document.fileName.split(/[\\/]/).pop() ?? 'file';
  let preview = full;
  let excluded = new Set<PreviewChoice>();
  for (;;) {
    const previewDoc = await vscode.workspace.openTextDocument({ content: preview.updatedSource, language: document.languageId });
    await vscode.commands.executeCommand('vscode.diff', document.uri, previewDoc.uri, `Code Janitor: Cleanup Preview (${fileName})`);

    const choice = await vscode.window.showInformationMessage(
      preview.hasChanges ? `Code Janitor: apply cleanup changes to ${fileName}?` : 'Code Janitor: no changes with the chosen rules.',
      { modal: true },
      ...(preview.hasChanges ? ['Apply', CHOOSE_RULES] : [CHOOSE_RULES])
    );
    if (choice !== CHOOSE_RULES) {
      if (choice === 'Apply') {
        break;
      }

      return;
    }

    const picked = await vscode.window.showQuickPick(
      choices.map((item) => ({ ...item, picked: !excluded.has(item) })),
      { canPickMany: true, title: `Code Janitor: changes to apply to ${fileName}` }
    );
    if (picked) {
      excluded = new Set(choices.filter((item) => !picked.some((p) => p.step === item.step && p.rule === item.rule)));
      preview = pipeline.preview(
        content,
        new Set([...excluded].filter((item) => !item.rule).map((item) => item.step)),
        new Set([...excluded].flatMap((item) => (item.rule ? [item.rule] : [])))
      );
    }
  }

  if (document.isClosed) {
    void vscode.window.showWarningMessage('Code Janitor: the document was closed before preview could be applied.');

    return;
  }

  const currentContent = document.getText();
  const applied = preview.tryApply(currentContent, async (updated) => {
    const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(currentContent.length));
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, fullRange, updated);
    const success = await vscode.workspace.applyEdit(edit);
    if (success) {
      logInfo(`Preview cleanup applied to ${document.fileName}.`);
      void vscode.window.showInformationMessage('Code Janitor: cleanup applied.');
    }
  });

  if (!applied) {
    void vscode.window.showWarningMessage(
      'Code Janitor: the file changed since preview was generated. Please run preview again.'
    );
  }
}
