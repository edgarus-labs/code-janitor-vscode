import * as vscode from 'vscode';
import { isRazorFile } from '../razor/razorSettings';
import { expandToRazorFiles, runFormatRazorOnUris } from './cleanupCore';

/** The files a menu command acts on: the multi-selection when there is one, otherwise the clicked file. */
function selectedTargets(clicked?: vscode.Uri, selected?: vscode.Uri[]): vscode.Uri[] {
  return selected && selected.length > 0 ? selected : clicked ? [clicked] : [];
}

/**
 * `codeJanitor.formatRazor`: formats the C# of `@code` / `@functions` and control blocks in
 * `.razor` / `.cshtml` files - the active editor when run from the palette, the selected files and
 * folders when run from the explorer. It runs whatever `codeJanitor.cleanup.formatRazorComponents` says.
 */
export function registerRazorCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('codeJanitor.formatRazor', async (clicked?: vscode.Uri, selected?: vscode.Uri[]) => {
      const targets = selectedTargets(clicked, selected);
      const active = vscode.window.activeTextEditor?.document.uri;
      if (targets.length === 0 && !active) {
        void vscode.window.showInformationMessage('Code Janitor: no active editor.');

        return;
      }

      if (targets.length === 0 && active && !isRazorFile(active)) {
        void vscode.window.showInformationMessage('Code Janitor: the active file is not a Razor file (.razor or .cshtml).');

        return;
      }

      const uris = targets.length > 0 ? (await Promise.all(targets.map((uri) => expandToRazorFiles(uri)))).flat() : active ? [active] : [];

      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Formatting Razor...' },
        () => runFormatRazorOnUris(uris)
      );
      const failed = result.failed > 0 ? `, ${result.failed} failed` : '';
      void vscode.window.showInformationMessage(`Code Janitor: Razor formatted - ${result.changed} file(s) changed${failed}.`);
    })
  );
}
