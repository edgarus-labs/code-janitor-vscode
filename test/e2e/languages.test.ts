/**
 * The cleanup of the files that are not C# in a real VS Code host: the file-type settings gate the files, each
 * language gets the steps of its family, and Format Comments formats a Visual Basic document through the server.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

const SETTINGS = ['cleanup.includeOtherFileTypes', 'cleanup.fileTypes.xml', 'formatting.commentWrapColumn'];

async function setting(key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration('codeJanitor').update(key, value, vscode.ConfigurationTarget.Global);
}

suite('Cleanup of the other languages (real VS Code host)', () => {
  let folder: string;

  suiteSetup(async function () {
    this.timeout(30000);
    await vscode.extensions.getExtension('codejanitor.code-janitor')?.activate();
  });

  setup(() => {
    // In the fixture workspace, whose `root = true` .editorconfig keeps the .editorconfig files above it out.
    const workspace = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspace, 'The e2e host must open the fixture workspace.');
    folder = fs.mkdtempSync(path.join(workspace.uri.fsPath, 'e2e-languages-'));
  });

  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const key of SETTINGS) {
      await setting(key, undefined);
    }

    fs.rmSync(folder, { recursive: true, force: true });
  });

  test('Cleanup Selected Files applies the markup rules to an XML file while XML files are cleaned', async () => {
    const file = path.join(folder, 'data.xml');
    fs.writeFileSync(file, '<root>\n  <item/>\n\n\n</root>\n', 'utf8');
    const uri = vscode.Uri.file(file);
    await setting('cleanup.includeOtherFileTypes', true);

    await vscode.commands.executeCommand('codeJanitor.cleanupSelectedFiles', uri, [uri]);

    assert.equal(fs.readFileSync(file, 'utf8'), '<root>\n  <item />\n</root>\n');
  });

  test('Cleanup Selected Files leaves an XML file alone when fileTypes.xml is off', async () => {
    const file = path.join(folder, 'data.xml');
    const dirty = '<root>\n  <item/>\n\n\n</root>\n';
    fs.writeFileSync(file, dirty, 'utf8');
    const uri = vscode.Uri.file(file);
    await setting('cleanup.includeOtherFileTypes', true);
    await setting('cleanup.fileTypes.xml', false);

    await vscode.commands.executeCommand('codeJanitor.cleanupSelectedFiles', uri, [uri]);

    assert.equal(fs.readFileSync(file, 'utf8'), dirty);
  });

  test('Format Comments wraps the comments of a Visual Basic document', async function () {
    this.timeout(120000);
    await setting('formatting.commentWrapColumn', 40);
    const document = await vscode.workspace.openTextDocument({
      language: 'vb',
      content: "Module Program\n    ' This comment is far too long for the wrap column of forty characters.\nEnd Module\n",
    });
    await vscode.window.showTextDocument(document);

    await vscode.commands.executeCommand('codeJanitor.formatComments');

    assert.equal(document.getText(), "Module Program\n    ' This comment is far too long for\n    ' the wrap column of forty characters.\nEnd Module\n");
  });
});
