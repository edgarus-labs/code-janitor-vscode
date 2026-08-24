import * as vscode from 'vscode';
import { expandToCSharpFiles, runCleanupOnUris } from './cleanupCore';

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

      const expanded = (await Promise.all(targets.map((u) => expandToCSharpFiles(u)))).flat();

      await runWithProgress('Cleaning up selected files...', () => runCleanupOnUris(context, expanded));
    }),

    vscode.commands.registerCommand('codeJanitor.cleanupWorkspace', async () => {
      const files = await vscode.workspace.findFiles('**/*.cs', '**/{bin,obj,node_modules,.git}/**');
      if (files.length === 0) {
        void vscode.window.showInformationMessage('CodeJanitor: no C# files found in the workspace.');

        return;
      }

      await runWithProgress(`Cleaning up ${files.length} file(s)...`, () => runCleanupOnUris(context, files));
    })
  );
}

async function runWithProgress(title: string, action: () => Promise<{ changed: number; failed: number }>): Promise<void> {
  const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, action);

  const parts = [`${result.changed} file(s) changed`];
  if (result.failed > 0) {
    parts.push(`${result.failed} failed`);
  }

  void vscode.window.showInformationMessage(`CodeJanitor: cleanup complete - ${parts.join(', ')}.`);
}
