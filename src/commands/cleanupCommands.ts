import * as vscode from 'vscode';
import { expandToCleanableFiles, isSupportedFile, runCleanupOnUris } from './cleanupCore';

export function registerCleanupCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('codeJanitor.cleanupActiveFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showInformationMessage('CodeJanitor: no active editor.');

        return;
      }

      await runWithProgress('Cleaning up active file...', () => runCleanupOnUris(context, [editor.document.uri]));
    }),

    vscode.commands.registerCommand('codeJanitor.cleanupSelectedFiles', async (clicked?: vscode.Uri, selected?: vscode.Uri[]) => {
      const targets = selected && selected.length > 0 ? selected : clicked ? [clicked] : [];
      if (targets.length === 0) {
        void vscode.window.showInformationMessage('CodeJanitor: no files selected.');

        return;
      }

      const expanded = (await Promise.all(targets.map((u) => expandToCleanableFiles(u)))).flat();

      await runWithProgress('Cleaning up selected files...', () => runCleanupOnUris(context, expanded));
    }),

    vscode.commands.registerCommand('codeJanitor.cleanupOpenFiles', async () => {
      const open = vscode.workspace.textDocuments
        .filter((doc) => !doc.isClosed && doc.uri.scheme === 'file' && isSupportedFile(doc.uri))
        .map((doc) => doc.uri);

      if (open.length === 0) {
        void vscode.window.showInformationMessage('CodeJanitor: no open files to clean up.');

        return;
      }

      await runWithProgress(`Cleaning up ${open.length} open file(s)...`, () => runCleanupOnUris(context, open));
    }),

    vscode.commands.registerCommand('codeJanitor.cleanupChangedFiles', async () => {
      const changed = await collectSourceControlChanges();
      if (changed === undefined) {
        void vscode.window.showWarningMessage('CodeJanitor: the built-in Git extension is not available.');

        return;
      }

      if (changed.length === 0) {
        void vscode.window.showInformationMessage('CodeJanitor: no changed files to clean up.');

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
        void vscode.window.showInformationMessage('CodeJanitor: no files found in the workspace.');

        return;
      }

      await runWithProgress(`Cleaning up ${files.length} file(s)...`, () => runCleanupOnUris(context, files));
    }),

    vscode.commands.registerCommand('codeJanitor.toggleCleanupOnSave', async () => {
      const config = vscode.workspace.getConfiguration('codeJanitor');
      const enabled = !config.get<boolean>('cleanup.onSave', false);
      await config.update('cleanup.onSave', enabled, vscode.ConfigurationTarget.Workspace);

      void vscode.window.showInformationMessage(`CodeJanitor: cleanup on save ${enabled ? 'enabled' : 'disabled'}.`);
    })
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

async function runWithProgress(title: string, action: () => Promise<{ changed: number; failed: number }>): Promise<void> {
  const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, action);

  const parts = [`${result.changed} file(s) changed`];
  if (result.failed > 0) {
    parts.push(`${result.failed} failed`);
  }

  void vscode.window.showInformationMessage(`CodeJanitor: cleanup complete - ${parts.join(', ')}.`);
}
