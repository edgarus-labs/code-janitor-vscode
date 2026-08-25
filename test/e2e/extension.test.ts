/**
 * Real end-to-end tests: run the extension inside an actual VS Code instance (a clean,
 * isolated profile that `@vscode/test-cli` downloads and manages), driving it purely through the
 * real `vscode` API - `vscode.commands.executeCommand`, real documents, the real Settings system.
 *
 * This is the layer the vitest suite's `vscodeMock` cannot cover: real command registration, real
 * activation, and real settings-schema loading. It exists specifically because of a class of bug
 * that a mock can never reproduce - e.g. a stale/duplicate extension install shadowing commands
 * and settings - since this test host loads *only* this extension, from a throwaway profile.
 *
 * The editor/context submenu's structure (grouping, adjacency of Generate/Remove XML Documentation,
 * `when` clauses) is checked at the manifest level in `test/commands.test.ts`'s "activation" suite,
 * which runs instantly and needs no VS Code host. What genuinely needs a real host - and is covered
 * here - is that every one of those contributed commands actually runs without throwing.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'codejanitor.code-janitor';

interface ConfigurationProperty {
  type?: string | string[];
  default?: unknown;
  enum?: string[];
}

interface PackageManifest {
  contributes: {
    commands: { command: string; title: string }[];
    configuration: { properties: Record<string, ConfigurationProperty> }[];
  };
}

function extension(): vscode.Extension<unknown> {
  const found = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(found, `Extension "${EXTENSION_ID}" is not installed in this test host.`);

  return found;
}

function manifest(): PackageManifest {
  return extension().packageJSON as PackageManifest;
}

function declaredSettings(): [string, ConfigurationProperty][] {
  return manifest().contributes.configuration.flatMap((section) => Object.entries(section.properties));
}

async function openCSharpDocument(content: string): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument({ content, language: 'csharp' });

  return vscode.window.showTextDocument(document);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Replaces `vscode.window.showInputBox` / `showQuickPick` / `showInformationMessage` /
 * `showWarningMessage` with safe, non-interactive stand-ins for the duration of `run`, so a
 * command that prompts the user (which would otherwise hang forever with no human present)
 * resolves immediately instead. Always restores the originals, even if `run` throws.
 */
async function withPromptsAutoAnswered<T>(run: () => Promise<T>): Promise<T> {
  const originalInputBox = vscode.window.showInputBox;
  const originalQuickPick = vscode.window.showQuickPick;
  const originalInformationMessage = vscode.window.showInformationMessage;
  const originalWarningMessage = vscode.window.showWarningMessage;

  // Cancel free-text prompts (namespace name, API key) and decline modal confirmations (AI apply,
  // XML doc preview, batch AI documentation) - the conservative choice for a mechanical smoke sweep.
  (vscode.window as { showInputBox: unknown }).showInputBox = () => Promise.resolve(undefined);
  (vscode.window as { showQuickPick: unknown }).showQuickPick = (items: unknown) =>
    Promise.resolve(Array.isArray(items) ? items[0] : undefined);
  (vscode.window as { showInformationMessage: unknown }).showInformationMessage = () => Promise.resolve(undefined);
  (vscode.window as { showWarningMessage: unknown }).showWarningMessage = () => Promise.resolve(undefined);

  try {
    return await run();
  } finally {
    (vscode.window as { showInputBox: unknown }).showInputBox = originalInputBox;
    (vscode.window as { showQuickPick: unknown }).showQuickPick = originalQuickPick;
    (vscode.window as { showInformationMessage: unknown }).showInformationMessage = originalInformationMessage;
    (vscode.window as { showWarningMessage: unknown }).showWarningMessage = originalWarningMessage;
  }
}

suite('Code Janitor extension (real VS Code host)', () => {
  suiteSetup(async function () {
    this.timeout(30000);
    await extension().activate();
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  suite('Identity and command registration', () => {
    test('is the only Code Janitor-like extension in this profile', () => {
      const matches = vscode.extensions.all.filter((candidate) => /code.?janitor/i.test(candidate.id));

      assert.deepEqual(
        matches.map((candidate) => candidate.id),
        [EXTENSION_ID]
      );
    });

    test('registers a real command for every command declared in the manifest', async () => {
      const declared = manifest().contributes.commands.map((entry) => entry.command);
      const registered = await vscode.commands.getCommands(true);

      for (const command of declared) {
        assert.ok(registered.includes(command), `"${command}" is declared but not registered.`);
        assert.equal(
          registered.filter((id) => id === command).length,
          1,
          `"${command}" is registered more than once.`
        );
      }
    });
  });

  suite('Settings', () => {
    test('every declared setting is readable and matches its declared JSON type', () => {
      const config = vscode.workspace.getConfiguration('codeJanitor');

      for (const [key, schema] of declaredSettings()) {
        const shortKey = key.replace(/^codeJanitor\./, '');
        const value = config.get(shortKey);

        assert.notEqual(value, undefined, `"${key}" could not be read from the real Settings system.`);

        const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
        if (type === 'array') {
          assert.ok(Array.isArray(value), `"${key}" should be an array, got ${typeof value}.`);
        } else if (type) {
          assert.equal(typeof value, type, `"${key}" should be a ${type}, got ${typeof value}.`);
        }

        if (schema.enum) {
          assert.ok(schema.enum.includes(value as string), `"${key}" = ${String(value)} is not one of ${schema.enum}.`);
        }
      }
    });

    test('updating and clearing a setting round-trips through the real configuration store', async () => {
      const config = vscode.workspace.getConfiguration('codeJanitor');

      await config.update('cleanup.removeRegions', false, vscode.ConfigurationTarget.Global);
      assert.equal(vscode.workspace.getConfiguration('codeJanitor').get('cleanup.removeRegions'), false);

      await config.update('cleanup.removeRegions', undefined, vscode.ConfigurationTarget.Global);
      assert.equal(vscode.workspace.getConfiguration('codeJanitor').get('cleanup.removeRegions'), true);
    });

    test('Open Settings opens a single webview panel, even when invoked twice', async () => {
      await vscode.commands.executeCommand('codeJanitor.openSettings');
      await vscode.commands.executeCommand('codeJanitor.openSettings');
      await wait(200);

      const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
      const settingsTabs = tabs.filter((tab) => tab.label === 'Code Janitor Settings');

      assert.equal(settingsTabs.length, 1, 'Open Settings should reveal the existing panel, not open a second one.');

      for (const tab of settingsTabs) {
        await vscode.window.tabGroups.close(tab);
      }
    });
  });

  suite('Command Palette - every command runs without throwing', () => {
    const declaredCommands = manifest().contributes.commands.filter(
      (entry) => entry.command !== 'codeJanitor.cleanupChangedFiles' // exercised separately below
    );

    for (const { command, title } of declaredCommands) {
      test(`"${title}" (${command})`, async () => {
        await openCSharpDocument(
          '/// <summary>Existing docs.</summary>\r\ninternal class Sample\r\n{\r\n    public int Add(int x, int y)   \r\n    {\r\n        return x + y;\r\n    }\r\n}\r\n'
        );

        await withPromptsAutoAnswered(() =>
          assert.doesNotReject(() => Promise.resolve(vscode.commands.executeCommand(command)))
        );
      });
    }

    test('"Cleanup Changed Files (Git)" (codeJanitor.cleanupChangedFiles)', async () => {
      await assert.doesNotReject(() =>
        Promise.resolve(vscode.commands.executeCommand('codeJanitor.cleanupChangedFiles'))
      );
    });
  });

  suite('Specific command behavior', () => {
    test('Cleanup Active File removes trailing whitespace from the open document', async () => {
      const editor = await openCSharpDocument('internal class C   \r\n{\r\n}\r\n');

      await vscode.commands.executeCommand('codeJanitor.cleanupActiveFile');

      assert.ok(!editor.document.getText().includes('   \r\n'));
    });

    test('Cleanup Selected Files cleans a file on disk without needing it open', async () => {
      const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'code-janitor-e2e-')), 'Dirty.cs');
      fs.writeFileSync(filePath, 'internal class C   \r\n{\r\n}\r\n', 'utf8');
      const uri = vscode.Uri.file(filePath);

      try {
        await vscode.commands.executeCommand('codeJanitor.cleanupSelectedFiles', uri, [uri]);

        const cleaned = fs.readFileSync(filePath, 'utf8');
        assert.ok(!cleaned.includes('   \r\n'));
      } finally {
        fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
      }
    });

    test('Generate XML Documentation (AI) documents a method, falling back without Copilot installed', async () => {
      const editor = await openCSharpDocument(
        'internal class Sample\r\n{\r\n    public int Add(int x, int y)\r\n    {\r\n        return x + y;\r\n    }\r\n}\r\n'
      );

      await vscode.commands.executeCommand('codeJanitor.generateXmlDoc');

      assert.ok(editor.document.getText().includes('/// <summary>'));
    });

    test('Remove XML Documentation strips doc comments without any AI call', async () => {
      const editor = await openCSharpDocument('/// <summary>Docs.</summary>\r\ninternal class Sample\r\n{\r\n}\r\n');

      await vscode.commands.executeCommand('codeJanitor.removeXmlDoc');

      assert.ok(!editor.document.getText().includes('<summary>'));
    });

    test('Fix Namespace applies the name typed in the input box', async () => {
      const editor = await openCSharpDocument('namespace Old\r\n{\r\n    class C { }\r\n}\r\n');

      const original = vscode.window.showInputBox;
      (vscode.window as { showInputBox: unknown }).showInputBox = () => Promise.resolve('New.Name');
      try {
        await vscode.commands.executeCommand('codeJanitor.fixNamespace');
      } finally {
        (vscode.window as { showInputBox: unknown }).showInputBox = original;
      }

      assert.ok(editor.document.getText().includes('namespace New.Name'));
    });

    test('Test AI Connection reports a result without Copilot installed or a custom endpoint set', async () => {
      await assert.doesNotReject(() =>
        Promise.resolve(vscode.commands.executeCommand('codeJanitor.testAiConnection'))
      );
    });

    test('Use GitHub Copilot Model warns instead of throwing when no model is available', async () => {
      await withPromptsAutoAnswered(() =>
        assert.doesNotReject(() => Promise.resolve(vscode.commands.executeCommand('codeJanitor.selectCopilotModel')))
      );
    });
  });
});
