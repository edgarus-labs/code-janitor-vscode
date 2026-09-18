import * as vscode from 'vscode';
import { runCleanup } from '../cleanup/runCleanup';
import { discoverDisqualifiedTypeNamesForFile, isPathCleanable } from './cleanupCore';
import { readCleanupSettings } from './settings';

/**
 * Optional cleanup on save. It never blocks or fails a save: any problem simply leaves the
 * document untouched.
 */
export function registerFormatOnSave(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.onWillSaveTextDocument((event) => {
      if (event.document.languageId !== 'csharp') {
        return;
      }

      if (!vscode.workspace.getConfiguration('codeJanitor').get<boolean>('cleanup.onSave', false)) {
        return;
      }

      if (!isPathCleanable(event.document.uri)) {
        return;
      }

      event.waitUntil(computeCleanupEdits(event.document));
    })
  );
}

async function computeCleanupEdits(document: vscode.TextDocument): Promise<vscode.TextEdit[]> {
  const content = document.getText();

  try {
    const disqualifiedTypeNames = await discoverDisqualifiedTypeNamesForFile(document.uri, content);
    const output = runCleanup(
      content,
      document.uri.fsPath,
      readCleanupSettings(vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath),
      disqualifiedTypeNames
    );
    if (output === content) {
      return [];
    }

    const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(content.length));

    return [vscode.TextEdit.replace(fullRange, output)];
  } catch {
    return [];
  }
}
