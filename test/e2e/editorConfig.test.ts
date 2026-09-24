/**
 * `.editorconfig` cleanup in a real VS Code host: files created under the fixture folder
 * `test/e2e/fixtures/workspace/editorconfig`, whose `.editorconfig` sets naming, code-style,
 * formatting and one-type-per-file rules, go through the real commands, the real save pipeline
 * and the real output channel.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'codejanitor.code-janitor';

/** Indented with two spaces, block-scoped namespace, `if(` and a private field without `_`. */
const UNCLEAN_COUNTER = [
  'namespace Demo',
  '{',
  '  internal class Counter',
  '  {',
  '    private int count;',
  '',
  '    public void Add(int value)',
  '    {',
  '      if(value > 0)',
  '      {',
  '        count += value;',
  '      }',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

function fixtureFolder(): string {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspace, 'The e2e host must open the fixture workspace.');

  return path.join(workspace.uri.fsPath, 'editorconfig');
}

/**
 * Resolves once the Code Janitor output channel shows a line matching `pattern`. VS Code fills the
 * channel's backing document asynchronously, so this follows its change events; Mocha's test
 * timeout fails the test if the line never appears.
 */
async function outputChannelLine(pattern: RegExp): Promise<string> {
  const isChannel = (document: vscode.TextDocument) => document.uri.scheme === 'output' && document.uri.path.includes('Code Janitor');
  const { promise, resolve } = Promise.withResolvers<string>();
  const check = (document: vscode.TextDocument) => {
    const line = isChannel(document) ? document.getText().split('\n').find((candidate) => pattern.test(candidate)) : undefined;
    if (line !== undefined) {
      resolve(line);
    }
  };
  const subscriptions = [
    vscode.workspace.onDidOpenTextDocument(check),
    vscode.workspace.onDidChangeTextDocument((event) => check(event.document)),
  ];
  try {
    await vscode.commands.executeCommand('codeJanitor.showOutputChannel');
    vscode.workspace.textDocuments.forEach(check);

    return await promise;
  } finally {
    subscriptions.forEach((subscription) => subscription.dispose());
  }
}

suite('.editorconfig cleanup (real VS Code host)', () => {
  let folder: string;

  suiteSetup(async function () {
    this.timeout(30000);
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
  });

  setup(() => {
    folder = fs.mkdtempSync(path.join(fixtureFolder(), 'run-'));
  });

  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.rmSync(folder, { recursive: true, force: true });
  });

  test('Cleanup Active File applies the naming, code-style and formatting rules of the .editorconfig', async () => {
    const filePath = path.join(folder, 'Counter.cs');
    fs.writeFileSync(filePath, UNCLEAN_COUNTER, 'utf8');
    const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(filePath));

    await vscode.commands.executeCommand('codeJanitor.cleanupActiveFile');

    const text = editor.document.getText();
    assert.match(text, /^namespace Demo;$/m, 'The namespace should become file-scoped (IDE0161).');
    assert.match(text, /^internal class Counter$/m, 'Four-space indentation of a file-scoped namespace starts at column 0.');
    assert.match(text, /^    private int _count;$/m, 'The private field should be renamed to _camelCase (IDE1006).');
    assert.match(text, /^        if \(value > 0\)$/m, 'The if statement should be re-indented and spaced (IDE0055).');
    assert.match(text, /^            _count \+= value;$/m, 'References to the renamed field should follow it.');
  });

  test('settings cleanup does not apply are reported in the Code Janitor output channel', async () => {
    const filePath = path.join(folder, 'Reported.cs');
    fs.writeFileSync(filePath, UNCLEAN_COUNTER, 'utf8');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(filePath));

    await vscode.commands.executeCommand('codeJanitor.cleanupActiveFile');

    // Listed once per session and settings file, with the number of files it applies to.
    const line = await outputChannelLine(/\.editorconfig setting not supported: .*dotnet_style_allow_multiple_blank_lines_experimental/);
    assert.match(line, /"dotnet_style_allow_multiple_blank_lines_experimental = false:warning" is not supported and was not applied\./);
  });

  test('Cleanup Selected Files moves extra top-level types to their own files (SA1402)', async () => {
    const filePath = path.join(folder, 'First.cs');
    fs.writeFileSync(
      filePath,
      ['namespace Demo;', '', 'internal class First', '{', '}', '', 'internal class Second', '{', '}', ''].join('\n'),
      'utf8'
    );
    const uri = vscode.Uri.file(filePath);

    await vscode.commands.executeCommand('codeJanitor.cleanupSelectedFiles', uri, [uri]);

    const second = path.join(folder, 'Second.cs');
    assert.ok(fs.existsSync(second), 'Second.cs should be created for the second class.');
    assert.match(fs.readFileSync(second, 'utf8'), /internal class Second/);
    assert.doesNotMatch(fs.readFileSync(filePath, 'utf8'), /class Second/);
    assert.match(fs.readFileSync(filePath, 'utf8'), /internal class First/);
  });

  test('cleanup on save applies the .editorconfig rules to the saved file', async () => {
    assert.equal(
      vscode.workspace.getConfiguration('codeJanitor').get('cleanup.onSave'),
      true,
      'The fixture workspace enables cleanup on save.'
    );
    const filePath = path.join(folder, 'Saved.cs');
    fs.writeFileSync(filePath, 'namespace Demo;\n\ninternal class Saved\n{\n}\n', 'utf8');
    const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(filePath));

    await editor.edit((edit) =>
      edit.replace(
        new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length)),
        UNCLEAN_COUNTER
      )
    );
    await editor.document.save();

    const saved = fs.readFileSync(filePath, 'utf8');
    assert.match(saved, /^namespace Demo;$/m);
    assert.match(saved, /^    private int _count;$/m);
    assert.match(saved, /^        if \(value > 0\)$/m);
  });
});
