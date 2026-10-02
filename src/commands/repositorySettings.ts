import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { formatCodeStyleScopeSetting, formatCodeStyleSetting, parseCodeStyleSetting } from '../cleanup/codeStyleRules';
import { CleanupSettings, createDefaultSettings } from '../cleanup/types';
import { readRepositoryPolicy } from '../cleanup/repositoryOverrides';
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

/**
 * The VS Code setting (below `codeJanitor.cleanup.`) of a `.codejanitor` cleanup flag: the group
 * setting for a per-kind flag, undefined for the flags VS Code declares no setting for.
 */
export function vscodeSettingOf(key: keyof CleanupSettings): string | undefined {
  if (REPOSITORY_ONLY_SETTINGS.has(key)) {
    return undefined;
  }

  return Object.keys(BOOLEAN_GROUPS).find((alias) => BOOLEAN_GROUPS[alias].includes(key)) ?? IMPORTABLE_SETTINGS[key] ?? key;
}

/** The VS Code setting value of a `.codejanitor` flag value: the file header enumerations are names there. */
function toSettingValue(key: keyof CleanupSettings, value: unknown): unknown {
  if (key === 'fileHeaderPosition' && value !== undefined) {
    return value === 1 ? 'afterUsings' : 'documentStart';
  }

  if (key === 'fileHeaderUpdateMode' && value !== undefined) {
    return value === 1 ? 'replace' : 'insert';
  }

  return value;
}

/** The value the policy gives every flag of a group, when they all have the same one. */
function groupPolicyValue(overrides: Partial<CleanupSettings>, targetKeys: readonly string[]): boolean | undefined {
  const values = targetKeys.map((key) => overrides[key as keyof CleanupSettings]);

  return typeof values[0] === 'boolean' && values.every((value) => value === values[0]) ? values[0] : undefined;
}

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

  // A key the file lists wins over each user's setting, so only the settings set in VS Code (in any
  // scope) are exported; the others keep following each user's setting, unless the overwritten file
  // already lists them.
  const config = vscode.workspace.getConfiguration('codeJanitor');
  const overrides = readRepositoryPolicy(root, logInfo).overrides;
  const configured = (settingKey: string): unknown => {
    const inspected = config.inspect(`cleanup.${settingKey}`);

    return inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
  };
  const cleanup: Record<string, unknown> = {};

  for (const key of Object.keys(createDefaultSettings()) as (keyof CleanupSettings)[]) {
    if (GROUPED_SETTING_KEYS.has(key) || key === 'codeStyleRules' || key === 'reorganize') {
      continue;
    }

    const settingKey = IMPORTABLE_SETTINGS[key] ?? key;
    const value = configured(settingKey) ?? toSettingValue(key, overrides[key]);
    if (value !== undefined) {
      cleanup[settingKey] = value;
    }
  }

  for (const [alias, targetKeys] of Object.entries(BOOLEAN_GROUPS)) {
    const value = configured(alias) ?? groupPolicyValue(overrides, targetKeys);
    if (value !== undefined) {
      cleanup[alias] = value;
      continue;
    }

    for (const key of targetKeys) {
      const listed = overrides[key as keyof CleanupSettings];
      if (listed !== undefined) {
        cleanup[key] = listed;
      }
    }
  }

  // Only the enabled Code Style rules: a disabled rule is not pinned and follows each user's setting
  // (add a `null` entry by hand to pin a rule off).
  cleanup.codeStyle = formatCodeStyleSetting(parseCodeStyleSetting(config.get('cleanup.codeStyleRules', {})));

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

  const policy = readRepositoryPolicy(root, logInfo);
  const overrides = policy.overrides;
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

    await config.update(`cleanup.${IMPORTABLE_SETTINGS[key] ?? key}`, toSettingValue(key, value), vscode.ConfigurationTarget.Workspace);
    imported++;
  }

  for (const [alias, targetKeys] of Object.entries(BOOLEAN_GROUPS)) {
    const value = groupPolicyValue(overrides, targetKeys);
    if (value !== undefined) {
      await config.update(`cleanup.${alias}`, value, vscode.ConfigurationTarget.Workspace);
      imported++;
    }
  }

  const codeStyle = Object.entries(policy.codeStyle);
  if (codeStyle.length > 0) {
    // The policy's rules over the Workspace rules: a value enables (or changes) a rule, `null` disables
    // it. VS Code merges this object setting across scopes, so the Workspace value is the base (the
    // effective one would copy the User rules into the often committed workspace settings), and a rule
    // the User settings enable is turned off with `null`, which overrides it.
    const inspected = config.inspect<Record<string, unknown>>('cleanup.codeStyleRules');
    const rules: Record<string, string> = { ...parseCodeStyleSetting(inspected?.workspaceValue) };
    const userRules = parseCodeStyleSetting(inspected?.globalValue);
    const workspaceRules = (inspected?.workspaceValue ?? {}) as Record<string, unknown>;
    const off = new Set(Object.keys(userRules).filter((key) => workspaceRules[key] === null));
    for (const [key, value] of codeStyle) {
      if (value === null) {
        delete rules[key];
        if (userRules[key] !== undefined) {
          off.add(key);
        }
      } else {
        rules[key] = value;
        off.delete(key);
      }

      imported++;
    }

    await config.update('cleanup.codeStyleRules', formatCodeStyleScopeSetting(rules, off), vscode.ConfigurationTarget.Workspace);
  }

  const kept = repositoryOnly > 0 ? ` ${repositoryOnly} setting(s) have no VS Code setting and keep applying from ${REPOSITORY_CONFIG_FILE}.` : '';
  void vscode.window.showInformationMessage(`Code Janitor: imported ${imported} repository setting(s) into workspace settings.${kept}`);
}
