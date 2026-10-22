/**
 * The Spade view in a real VS Code host with the real C# engine: the tree of a C# file, a sort and a delete. The tree's
 * nodes come from `codeJanitor.spade.refresh`, which resolves to the root nodes it shows.
 */

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

interface SpadeNode {
  readonly name: string;
  readonly contextValue: string;
  readonly children: readonly SpadeNode[];
}

const SOURCE = [
  'namespace Fixture',
  '{',
  '    public class SpadeFixture',
  '    {',
  '        private int count;',
  '',
  '        public int Zeta() => count;',
  '',
  '        /// <summary>Alpha.</summary>',
  '        public int Alpha(int x)',
  '        {',
  '            if (x > 0)',
  '            {',
  '                return x;',
  '            }',
  '',
  '            return -x;',
  '        }',
  '    }',
  '}',
  '',
].join('\r\n');

async function refresh(): Promise<readonly SpadeNode[]> {
  return (await vscode.commands.executeCommand<readonly SpadeNode[]>('codeJanitor.spade.refresh')) ?? [];
}

function names(nodes: readonly SpadeNode[]): string[] {
  return nodes.map((node) => node.name);
}

suite('Spade (real VS Code host)', () => {
  let editor: vscode.TextEditor;

  suiteSetup(async function () {
    this.timeout(30000);
    await vscode.extensions.getExtension('codejanitor.code-janitor')!.activate();
  });

  setup(async () => {
    // The Command Palette sweep of the other suite saves a sort order in the test profile.
    await vscode.workspace.getConfiguration('codeJanitor').update('spade.primarySortOrder', undefined, vscode.ConfigurationTarget.Global);
    const document = await vscode.workspace.openTextDocument({ content: SOURCE, language: 'csharp' });
    editor = await vscode.window.showTextDocument(document);
  });

  teardown(async () => {
    await vscode.workspace.getConfiguration('codeJanitor').update('spade.primarySortOrder', undefined, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  test('shows the namespace, the type and the members of the active C# file', async function () {
    this.timeout(60000);

    const roots = await refresh();

    assert.deepEqual(names(roots), ['Fixture']);
    assert.equal(roots[0].contextValue, 'namespace');
    const type = roots[0].children[0];
    assert.equal(type.name, 'SpadeFixture');
    assert.equal(type.contextValue, 'type');
    assert.deepEqual(names(type.children), ['count', 'Zeta', 'Alpha']);
    assert.deepEqual(
      type.children.map((node) => node.contextValue),
      ['member', 'member', 'member']
    );
  });

  test('sorts the members alphabetically and by type, saving the order', async function () {
    this.timeout(60000);

    await vscode.commands.executeCommand('codeJanitor.spade.sortAlphabetically');
    const alphabetical = await refresh();
    assert.equal(vscode.workspace.getConfiguration('codeJanitor').get('spade.primarySortOrder'), 'alphabetical');
    assert.deepEqual(names(alphabetical[0].children[0].children), ['Alpha', 'count', 'Zeta']);

    await vscode.commands.executeCommand('codeJanitor.spade.sortByType');
    const byType = await refresh();
    const classes = byType[0].children[0];
    assert.equal(classes.contextValue, 'group');
    assert.deepEqual(names(classes.children[0].children), ['Fields', 'Methods']);
    assert.deepEqual(names(classes.children[0].children[1].children), ['Zeta', 'Alpha']);
  });

  test('deletes a member with its documentation after confirmation', async function () {
    this.timeout(60000);
    const roots = await refresh();
    const alpha = roots[0].children[0].children.find((node) => node.name === 'Alpha');
    assert.ok(alpha, 'Alpha is in the tree.');

    const original = vscode.window.showWarningMessage;
    (vscode.window as { showWarningMessage: unknown }).showWarningMessage = () => Promise.resolve('Delete');
    try {
      await vscode.commands.executeCommand('codeJanitor.spade.deleteMember', alpha);
    } finally {
      (vscode.window as { showWarningMessage: unknown }).showWarningMessage = original;
    }

    const text = editor.document.getText();
    assert.ok(!text.includes('Alpha'), text);
    assert.ok(text.includes('public int Zeta() => count;'), text);
    assert.deepEqual(names((await refresh())[0].children[0].children), ['count', 'Zeta']);
  });

  test('Show Spade focuses the view', async () => {
    await assert.doesNotReject(() => Promise.resolve(vscode.commands.executeCommand('codeJanitor.showSpade')));
  });
});
