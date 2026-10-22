import { setTimeout as delay } from 'node:timers/promises';
import * as vscode from 'vscode';
import { logDiagnostic, logError, logInfo } from '../logging';
import { reportEngineUnavailable } from '../engine/vscodeEngine';
import { cleanupCSharpResult, engineOutcome, externalFileCleanup, isOutsideWorkspaceFolders, isPathCleanable } from './cleanupCore';

/**
 * How long cleanup on save waits for the C# engine: VS Code gives all save participants about 1.5 s, and a
 * save must never wait longer (the engine's first request loads the projects, which takes longer).
 */
export const SAVE_CLEANUP_TIMEOUT_MS = 1250;

/**
 * Optional cleanup on save. It never blocks or fails a save: a problem, or an engine slower than
 * {@link SAVE_CLEANUP_TIMEOUT_MS}, leaves the document untouched and is logged. It never changes other
 * files or creates files: VS Code can drop the edits of a save, which would leave a split type both in
 * the saved file and in its new file. A file outside the workspace folders is cleaned partially without
 * asking, unless `codeJanitor.cleanup.performPartialCleanupOnExternal` is `never`. Format Document, the other
 * cleaning commands and AI documentation never run on save: they would hold up the save.
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
  const cancellation = new vscode.CancellationTokenSource();
  const timeout = new AbortController();
  try {
    const partial = isOutsideWorkspaceFolders(document.uri);
    const skipBecause = partial ? (await externalFileCleanup(document.uri, false)).skipBecause : undefined;
    if (skipBecause) {
      logDiagnostic(`Cleanup on save of ${document.uri.fsPath} skipped: ${skipBecause}.`);

      return [];
    }

    const content = document.getText();
    // The engine may still be starting, which the request's cancellation does not cut short.
    const result = await Promise.race([
      cleanupCSharpResult(
        { uri: document.uri, content, isOpen: true },
        { renameAcrossWorkspace: false, honorOnlyChangedLines: true, onSave: true, partial, token: cancellation.token }
      ),
      delay(SAVE_CLEANUP_TIMEOUT_MS, undefined, { signal: timeout.signal }),
    ]);
    if (result === undefined) {
      cancellation.cancel();
      logInfo(`Cleanup on save of ${document.uri.fsPath} skipped: the C# engine did not answer within ${SAVE_CLEANUP_TIMEOUT_MS} ms.`);

      return [];
    }

    if (result.otherFiles.length > 0 || result.newFiles.length > 0) {
      logInfo(
        `Cleanup on save of ${document.uri.fsPath} skipped: it would also change or create other files (${[...result.otherFiles, ...result.newFiles]
          .map((file) => file.path)
          .join(', ')}); run Cleanup Active File instead.`
      );

      return [];
    }

    const output = engineOutcome(document.uri, result, 'Cleanup on save').text.replace(/^\uFEFF/, '');
    if (output === content) {
      return [];
    }

    if (document.getText() !== content) {
      logInfo(`Cleanup on save of ${document.uri.fsPath} skipped: the document changed while the C# engine was cleaning it.`);

      return [];
    }

    return [vscode.TextEdit.replace(new vscode.Range(document.positionAt(0), document.positionAt(content.length)), output)];
  } catch (err) {
    if (!reportEngineUnavailable(err)) {
      logError(`Cleanup on save of ${document.uri.fsPath}`, err);
    }

    return [];
  } finally {
    timeout.abort();
    cancellation.dispose();
  }
}
