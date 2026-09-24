import * as vscode from 'vscode';
import { runCleanup } from '../cleanup/runCleanup';
import { logError } from '../logging';
import { Baseline, readHeadVersion } from '../cleanup/gitBaseline';
import {
  cleanupChangedLines,
  createEditorConfigIssueLog,
  discoverDisqualifiedTypeNamesForFile,
  isPathCleanable,
  reportOneTypePerFileOnSave,
} from './cleanupCore';
import { readCleanupSettings } from './settings';

/**
 * Optional cleanup on save. It never blocks or fails a save: a problem leaves the document
 * untouched and is logged. It never creates files (see {@link reportOneTypePerFileOnSave}).
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
  // Saves repeat: the unsupported settings of an `.editorconfig` are reported once per session.
  const issues = createEditorConfigIssueLog(true);

  try {
    const content = document.getText();
    const settings = readCleanupSettings(vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath);
    const disqualifiedTypeNames = await discoverDisqualifiedTypeNamesForFile(document.uri, content);
    let output: string;
    if (settings.onlyChangedLines) {
      const baseline: Baseline =
        document.uri.scheme === 'file' ? await readHeadVersion(document.uri.fsPath) : { kind: 'unavailable', reason: 'the document is not a file' };
      output = cleanupChangedLines(content, document.uri.fsPath, settings, baseline, disqualifiedTypeNames, issues.report);
    } else {
      await reportOneTypePerFileOnSave({ uri: document.uri, content, isOpen: true }, issues.report);
      output = runCleanup(content, document.uri.fsPath, settings, disqualifiedTypeNames, issues.report);
    }

    if (output === content) {
      return [];
    }

    const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(content.length));

    return [vscode.TextEdit.replace(fullRange, output)];
  } catch (err) {
    logError(`Cleanup on save of ${document.uri.fsPath}`, err);

    return [];
  } finally {
    issues.finish();
  }
}
