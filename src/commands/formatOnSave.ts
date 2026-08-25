import * as vscode from 'vscode';
import { runCleanup } from '../cleanup/runCleanup';
import { isPathCleanable } from './cleanupCore';
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

function computeCleanupEdits(document: vscode.TextDocument): Promise<vscode.TextEdit[]> {
  const content = document.getText();

  try {
    const output = runCleanup(content, document.uri.fsPath, readCleanupSettings());
    if (output === content) {
      return Promise.resolve([]);
    }

    const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(content.length));

    return Promise.resolve([vscode.TextEdit.replace(fullRange, output)]);
  } catch {
    return Promise.resolve([]);
  }
}
