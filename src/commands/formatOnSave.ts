import * as vscode from 'vscode';
import { runCleanup } from '../cleanup/runCleanup';
import {
  discoverDisqualifiedTypeNamesForFile,
  isPathCleanable,
  logEditorConfigIssue,
  splitTypesForEditorConfig,
} from './cleanupCore';
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
    const settings = readCleanupSettings(vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath);
    // One type per file (.editorconfig): the types moved out are written to their new files first.
    const split = await splitTypesForEditorConfig({ uri: document.uri, content, isOpen: true }, logEditorConfigIssue);
    const input = split?.content ?? content;
    const disqualifiedTypeNames = await discoverDisqualifiedTypeNamesForFile(document.uri, input);
    for (const created of split?.createdFiles ?? []) {
      const cleaned = runCleanup(created.content, created.uri.fsPath, settings, disqualifiedTypeNames, logEditorConfigIssue);
      await vscode.workspace.fs.writeFile(created.uri, Buffer.from(cleaned, 'utf8'));
    }

    const output = runCleanup(input, document.uri.fsPath, settings, disqualifiedTypeNames, logEditorConfigIssue);
    if (output === content) {
      return [];
    }

    const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(content.length));

    return [vscode.TextEdit.replace(fullRange, output)];
  } catch {
    return [];
  }
}
