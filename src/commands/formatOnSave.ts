import * as vscode from 'vscode';
import { resolveEngineDll, runEngine } from '../engine/client';
import { buildEngineSettings, getDotnetPath } from '../engine/settings';

/**
 * Registers the optional "cleanup on save" behavior (codeJanitor.cleanup.onSave), mirroring the
 * Visual Studio extension's auto-cleanup-on-save feature. Runs the engine against the in-memory
 * buffer and supplies the resulting edit via `waitUntil` so it lands in the same save operation.
 */
export function registerFormatOnSave(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.onWillSaveTextDocument((event) => {
      if (event.document.languageId !== 'csharp') {
        return;
      }

      const enabled = vscode.workspace.getConfiguration('codeJanitor').get<boolean>('cleanup.onSave', false);
      if (!enabled) {
        return;
      }

      event.waitUntil(computeCleanupEdits(context, event.document));
    })
  );
}

async function computeCleanupEdits(context: vscode.ExtensionContext, document: vscode.TextDocument): Promise<vscode.TextEdit[]> {
  const engineDll = resolveEngineDll(context.extensionUri);
  const dotnetPath = getDotnetPath();
  const settings = buildEngineSettings();
  const content = document.getText();

  try {
    const [result] = await runEngine(dotnetPath, engineDll, {
      settings,
      files: [{ path: document.uri.fsPath, content }],
    });

    if (!result || result.error || !result.changed) {
      return [];
    }

    const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(content.length));

    return [vscode.TextEdit.replace(fullRange, result.output)];
  } catch {
    // Never block a save because the engine could not be reached.
    return [];
  }
}
