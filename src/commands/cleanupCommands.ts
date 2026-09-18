import * as vscode from 'vscode';
import {
  discoverDisqualifiedTypeNamesForFile,
  expandToCSharpFiles,
  expandToCleanableFiles,
  isSupportedFile,
  runCleanupOnUris,
  runFixNamespaceOnUris,
  runFormatCommentsOnUris,
  runRemoveRegionsOnUris,
  runRemoveXmlDocOnUris,
  runSplitTopLevelTypesOnUris,
} from './cleanupCore';
import { getCleanupPipeline } from '../cleanup/runCleanup';
import { readCleanupSettings } from './settings';
import { logInfo } from '../logging';

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
      const targets = selected && selected.length > 0 ? selected : clicked ? [clicked] : [];
      if (targets.length === 0) {
        void vscode.window.showInformationMessage('Code Janitor: no files selected.');

        return;
      }

      const expanded = (await Promise.all(targets.map((u) => expandToCleanableFiles(u)))).flat();

      await runWithProgress('Cleaning up selected files...', () => runCleanupOnUris(context, expanded));
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
      const open = vscode.workspace.textDocuments
        .filter((doc) => !doc.isClosed && doc.uri.scheme === 'file' && isSupportedFile(doc.uri))
        .map((doc) => doc.uri);

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
        runCleanupOnUris(context, changed)
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

      await runWithProgress(`Cleaning up ${files.length} file(s)...`, () => runCleanupOnUris(context, files));
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
  action: () => Promise<{ changed: number; failed: number }>,
  doneLabel = 'cleanup complete'
): Promise<void> {
  const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, action);

  const parts = [`${result.changed} file(s) changed`];
  if (result.failed > 0) {
    parts.push(`${result.failed} failed`);
  }

  void vscode.window.showInformationMessage(`Code Janitor: ${doneLabel} - ${parts.join(', ')}.`);
}

async function previewCleanupActiveDocument(_context: vscode.ExtensionContext, editor: vscode.TextEditor): Promise<void> {
  const document = editor.document;
  if (!isSupportedFile(document.uri)) {
    void vscode.window.showInformationMessage('Code Janitor: active file is not a supported file type.');

    return;
  }

  const content = document.getText();
  const root = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
  const settings = readCleanupSettings(root);
  const disqualifiedTypeNames = await discoverDisqualifiedTypeNamesForFile(document.uri, content);
  const pipeline = getCleanupPipeline(content, document.uri.fsPath, settings, disqualifiedTypeNames);

  const preview = pipeline.preview(content);
  if (!preview.hasChanges) {
    void vscode.window.showInformationMessage('Code Janitor: file is already clean (no changes).');

    return;
  }

  const previewDoc = await vscode.workspace.openTextDocument({
    content: preview.updatedSource,
    language: document.languageId,
  });

  const changedSteps = preview.steps.filter((s) => s.changed).map((s) => s.name);
  logInfo(
    `Preview cleanup for ${document.fileName}: ${changedSteps.length} rule(s) would make changes (${changedSteps.join(
      ', '
    )}).`
  );

  const fileName = document.fileName.split(/[\\/]/).pop() ?? 'file';
  await vscode.commands.executeCommand(
    'vscode.diff',
    document.uri,
    previewDoc.uri,
    `Code Janitor: Cleanup Preview (${fileName})`
  );

  const choice = await vscode.window.showInformationMessage(
    `Code Janitor: apply cleanup changes to ${fileName}?`,
    { modal: true },
    'Apply'
  );

  if (choice !== 'Apply') {
    return;
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
