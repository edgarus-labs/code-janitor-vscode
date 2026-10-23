/**
 * The external tools after a cleanup, in a real VS Code host: the formatter VS Code has for the language
 * (`codeJanitor.cleanup.runFormatDocument`) and the commands of `codeJanitor.thirdParty.otherCleaningCommands`,
 * run with the cleaned document as the active editor.
 */

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

const EXTENSION_ID = 'codejanitor.code-janitor';
const RECORD_COMMAND = 'codeJanitorE2e.recordActiveDocument';
const FAILING_COMMAND = 'codeJanitorE2e.fail';

suite('External tools after cleanup (real VS Code host)', () => {
  const disposables: vscode.Disposable[] = [];
  const config = () => vscode.workspace.getConfiguration('codeJanitor');

  suiteSetup(async function () {
    this.timeout(30000);
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
  });

  teardown(async () => {
    disposables.splice(0).forEach((disposable) => disposable.dispose());
    await config().update('cleanup.runFormatDocument', undefined, vscode.ConfigurationTarget.Global);
    await config().update('thirdParty.otherCleaningCommands', undefined, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('Cleanup Active File runs Format Document, then the other cleaning commands on the active document, past a failing one', async function () {
    this.timeout(60000);
    const seen: string[] = [];
    disposables.push(
      vscode.languages.registerDocumentFormattingEditProvider('csharp', {
        provideDocumentFormattingEdits: (document) =>
          document.getText().startsWith('// formatted') ? [] : [vscode.TextEdit.insert(new vscode.Position(0, 0), '// formatted\n')],
      }),
      vscode.commands.registerCommand(FAILING_COMMAND, () => {
        throw new Error('failing on purpose');
      }),
      vscode.commands.registerCommand(RECORD_COMMAND, () => seen.push(vscode.window.activeTextEditor?.document.getText() ?? '<no active editor>'))
    );
    await config().update('cleanup.runFormatDocument', true, vscode.ConfigurationTarget.Global);
    await config().update('thirdParty.otherCleaningCommands', [FAILING_COMMAND, RECORD_COMMAND], vscode.ConfigurationTarget.Global);
    const editor = await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument({ content: 'internal class C   \n{\n}\n', language: 'csharp' })
    );

    await vscode.commands.executeCommand('codeJanitor.cleanupActiveFile');

    const text = editor.document.getText();
    assert.ok(text.startsWith('// formatted\n'), `Format Document did not run: ${JSON.stringify(text)}`);
    assert.ok(!text.includes('   \n'), 'the cleanup did not run');
    assert.deepEqual(seen, [text]);
  });
});
