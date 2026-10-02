import * as vscode from 'vscode';
import { switchFile } from './switchFile';

/** `vscode.FilePermission.Readonly`: the bit of `FileStat.permissions` that marks a read-only file. */
const READONLY_PERMISSION = 1;

/**
 * The Visual Studio navigation and workflow commands that have a VS Code equivalent, under
 * `codeJanitor.*` ids. Where VS Code already offers the behavior, the command delegates to it.
 */
export function registerNavigationCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('codeJanitor.switchFile', switchFile),

    vscode.commands.registerCommand('codeJanitor.toggleReadOnly', async () => {
      if (!vscode.window.activeTextEditor) {
        void vscode.window.showInformationMessage('Code Janitor: no active editor.');

        return;
      }

      // Read-only for the session, as VS Code has no command that changes the file's attribute.
      await vscode.commands.executeCommand('workbench.action.files.toggleActiveEditorReadonlyInSession');
    }),

    vscode.commands.registerCommand('codeJanitor.closeAllReadOnly', closeAllReadOnlyEditors),

    vscode.commands.registerCommand('codeJanitor.findInExplorer', async () => {
      if (!vscode.window.activeTextEditor) {
        void vscode.window.showInformationMessage('Code Janitor: no active editor.');

        return;
      }

      await vscode.commands.executeCommand('workbench.files.action.showActiveFileInExplorer');
    }),

    vscode.commands.registerCommand('codeJanitor.collapseExplorer', () =>
      vscode.commands.executeCommand('workbench.files.action.collapseExplorerFolders')
    ),

    vscode.commands.registerCommand('codeJanitor.collapseSelectedInExplorer', async () => {
      // VS Code cannot collapse a selection recursively: this collapses the focused folder of the Explorer.
      await vscode.commands.executeCommand('workbench.files.action.focusFilesExplorer');
      await vscode.commands.executeCommand('list.collapse');
    })
  );
}

/** Whether the file cannot be written: on a read-only file system, or marked read-only on disk. */
async function isReadOnly(uri: vscode.Uri): Promise<boolean> {
  if (vscode.workspace.fs.isWritableFileSystem(uri.scheme) === false) {
    return true;
  }

  try {
    const stat = await vscode.workspace.fs.stat(uri);

    return ((stat.permissions ?? 0) & READONLY_PERMISSION) !== 0;
  } catch {
    return false;
  }
}

/** Closes the open editors whose file is read-only and has no unsaved changes (Visual Studio: `ReadOnly && Saved`). */
async function closeAllReadOnlyEditors(): Promise<void> {
  const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
  const closing: vscode.Tab[] = [];
  for (const tab of tabs) {
    const uri = (tab.input as { uri?: vscode.Uri } | undefined)?.uri;
    if (uri && !tab.isDirty && (await isReadOnly(uri))) {
      closing.push(tab);
    }
  }

  if (closing.length === 0) {
    void vscode.window.showInformationMessage('Code Janitor: no read-only editors are open.');

    return;
  }

  await vscode.window.tabGroups.close(closing);
  void vscode.window.showInformationMessage(`Code Janitor: closed ${closing.length} read-only editor(s).`);
}
