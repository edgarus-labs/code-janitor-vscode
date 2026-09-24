import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CleanupSettings, createDefaultSettings } from '../cleanup/types';
import { readRepoCleanupOverrides } from '../cleanup/repositoryOverrides';
import { logInfo } from '../logging';

export const REPOSITORY_CONFIG_FILE = '.codejanitor';

const IMPORTABLE_SETTINGS: Partial<Record<keyof CleanupSettings, string>> = {
  insertBlankLineBeforeReturnAndThrowStatements: 'insertBlankLineBeforeReturnAndThrow',
};

const BOOLEAN_GROUPS: Record<string, string[]> = {
  insertBlankLinePadding: [
    'insertBlankLinePaddingBeforeClasses', 'insertBlankLinePaddingAfterClasses',
    'insertBlankLinePaddingBeforeDelegates', 'insertBlankLinePaddingAfterDelegates',
    'insertBlankLinePaddingBeforeEnumerations', 'insertBlankLinePaddingAfterEnumerations',
    'insertBlankLinePaddingBeforeEvents', 'insertBlankLinePaddingAfterEvents',
    'insertBlankLinePaddingBeforeFieldsMultiLine', 'insertBlankLinePaddingAfterFieldsMultiLine',
    'insertBlankLinePaddingBeforeInterfaces', 'insertBlankLinePaddingAfterInterfaces',
    'insertBlankLinePaddingBeforeMethods', 'insertBlankLinePaddingAfterMethods',
    'insertBlankLinePaddingBeforeNamespaces', 'insertBlankLinePaddingAfterNamespaces',
    'insertBlankLinePaddingBeforePropertiesMultiLine', 'insertBlankLinePaddingAfterPropertiesMultiLine',
    'insertBlankLinePaddingBeforeStructs', 'insertBlankLinePaddingAfterStructs',
    'insertBlankLinePaddingBeforeRegionTags', 'insertBlankLinePaddingAfterRegionTags',
    'insertBlankLinePaddingBeforeEndRegionTags', 'insertBlankLinePaddingAfterEndRegionTags',
    'insertBlankLinePaddingBeforeUsingStatementBlocks', 'insertBlankLinePaddingAfterUsingStatementBlocks',
    'insertBlankLinePaddingBeforeCaseStatements',
  ],
  insertExplicitAccessModifiers: [
    'insertExplicitAccessModifiersOnClasses', 'insertExplicitAccessModifiersOnDelegates',
    'insertExplicitAccessModifiersOnEnumerations', 'insertExplicitAccessModifiersOnEvents',
    'insertExplicitAccessModifiersOnFields', 'insertExplicitAccessModifiersOnInterfaces',
    'insertExplicitAccessModifiersOnMethods', 'insertExplicitAccessModifiersOnProperties',
    'insertExplicitAccessModifiersOnStructs',
  ],
};

const GROUPED_SETTING_KEYS = new Set(Object.values(BOOLEAN_GROUPS).flat());

/**
 * Settings that exist only in `.codejanitor` (VS Code declares no setting for them): cleanup reads
 * them from the file, so import leaves them there instead of writing an unregistered setting.
 */
const REPOSITORY_ONLY_SETTINGS: ReadonlySet<string> = new Set([
  'insertBlankLinePaddingBeforeFieldsSingleLine',
  'insertBlankLinePaddingAfterFieldsSingleLine',
  'insertBlankLinePaddingBeforePropertiesSingleLine',
  'insertBlankLinePaddingAfterPropertiesSingleLine',
  'insertBlankLinePaddingBeforeSingleLineComments',
]);

export function registerRepositorySettingsCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('codeJanitor.exportRepositorySettings', () => exportRepositorySettings()),
    vscode.commands.registerCommand('codeJanitor.importRepositorySettings', () => importRepositorySettings())
  );
}

export async function exportRepositorySettings(workspaceRoot?: string): Promise<void> {
  const root = workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    void vscode.window.showInformationMessage('Code Janitor: open a workspace to export repository settings.');

    return;
  }

  const filePath = path.join(root, REPOSITORY_CONFIG_FILE);
  if (fs.existsSync(filePath)) {
    const choice = await vscode.window.showWarningMessage(
      `Code Janitor: overwrite ${REPOSITORY_CONFIG_FILE}?`,
      { modal: true },
      'Overwrite'
    );
    if (choice !== 'Overwrite') {
      return;
    }
  }

  const config = vscode.workspace.getConfiguration('codeJanitor');
  const cleanup: Record<string, unknown> = {};
  const defaults = createDefaultSettings();
  const effective = { ...defaults, ...readRepoCleanupOverrides(root, logInfo) };

  for (const key of Object.keys(defaults) as (keyof CleanupSettings)[]) {
    if (GROUPED_SETTING_KEYS.has(key)) {
      continue;
    }

    const settingKey = IMPORTABLE_SETTINGS[key] ?? key;
    if (key === 'fileHeaderPosition') {
      cleanup[settingKey] = config.get('cleanup.fileHeaderPosition', effective[key] === 1 ? 'afterUsings' : 'documentStart');
    } else if (key === 'fileHeaderUpdateMode') {
      cleanup[settingKey] = config.get('cleanup.fileHeaderUpdateMode', effective[key] === 1 ? 'replace' : 'insert');
    } else {
      cleanup[settingKey] = config.get(`cleanup.${settingKey}`, effective[key]);
    }
  }

  cleanup.insertBlankLinePadding = config.get('cleanup.insertBlankLinePadding', undefined);
  cleanup.insertExplicitAccessModifiers = config.get('cleanup.insertExplicitAccessModifiers', undefined);
  if (cleanup.insertBlankLinePadding === undefined) {
    delete cleanup.insertBlankLinePadding;
  }
  if (cleanup.insertExplicitAccessModifiers === undefined) {
    delete cleanup.insertExplicitAccessModifiers;
  }

  fs.writeFileSync(filePath, `${JSON.stringify({ cleanup }, null, 2)}\n`, 'utf8');
  void vscode.window.showInformationMessage(`Code Janitor: exported repository settings to ${REPOSITORY_CONFIG_FILE}.`);
}

export async function importRepositorySettings(workspaceRoot?: string): Promise<void> {
  const root = workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    void vscode.window.showInformationMessage('Code Janitor: open a workspace to import repository settings.');

    return;
  }

  const filePath = path.join(root, REPOSITORY_CONFIG_FILE);
  if (!fs.existsSync(filePath)) {
    void vscode.window.showInformationMessage(`Code Janitor: ${REPOSITORY_CONFIG_FILE} was not found.`);

    return;
  }

  const overrides = readRepoCleanupOverrides(root, logInfo);
  const config = vscode.workspace.getConfiguration('codeJanitor');
  let imported = 0;
  let repositoryOnly = 0;

  for (const [key, value] of Object.entries(overrides) as [keyof CleanupSettings, unknown][]) {
    // Grouped keys have no VS Code setting of their own; the group setting below imports them.
    if (GROUPED_SETTING_KEYS.has(key)) {
      continue;
    }

    if (REPOSITORY_ONLY_SETTINGS.has(key)) {
      repositoryOnly++;
      continue;
    }

    const settingKey = IMPORTABLE_SETTINGS[key] ?? key;
    const importedValue = key === 'fileHeaderPosition'
      ? value === 1 ? 'afterUsings' : 'documentStart'
      : key === 'fileHeaderUpdateMode'
        ? value === 1 ? 'replace' : 'insert'
        : value;
    await config.update(`cleanup.${settingKey}`, importedValue, vscode.ConfigurationTarget.Workspace);
    imported++;
  }

  for (const [alias, targetKeys] of Object.entries(BOOLEAN_GROUPS)) {
    const values = targetKeys.map((key) => overrides[key as keyof CleanupSettings]);
    if (values.length > 0 && values.every((value) => value === values[0]) && typeof values[0] === 'boolean') {
      await config.update(`cleanup.${alias}`, values[0], vscode.ConfigurationTarget.Workspace);
      imported++;
    }
  }

  const kept = repositoryOnly > 0 ? ` ${repositoryOnly} setting(s) have no VS Code setting and keep applying from ${REPOSITORY_CONFIG_FILE}.` : '';
  void vscode.window.showInformationMessage(`Code Janitor: imported ${imported} repository setting(s) into workspace settings.${kept}`);
}
