import * as fs from 'node:fs';
import * as path from 'node:path';
import { CleanupSettings, HeaderPosition, HeaderUpdateMode, createDefaultSettings } from './types';

/** The repository policy file (`.codejanitor`) shared with the Visual Studio extension, without VS Code. */

const REPOSITORY_CONFIG_NAMES = ['.codejanitor', '.code-janitor.json'];

/**
 * `.codejanitor` keys of the Visual Studio extension that VS Code does not honor: here the
 * `.editorconfig` rules always apply, and only .NET SDK rules are fixed.
 */
const VISUAL_STUDIO_ONLY_KEYS: Readonly<Record<string, string>> = {
  applyEditorConfigFormatting: '.editorconfig rules always apply',
  applyEditorConfigNaming: '.editorconfig rules always apply',
  applyEditorConfigCodeStyle: '.editorconfig rules always apply',
  applyAnalyzerCodeFixes: 'fixes from third-party analyzers are never applied',
};

/** The ignored keys already logged in this session, as `<.codejanitor path>\n<key>`: settings are read on every save. */
const reportedIgnoredKeys = new Set<string>();

/**
 * Reads the optional repository policy file. Invalid JSON, unknown keys and wrong value types are
 * ignored; the Visual Studio-only keys are passed to `log` as ignored, once per session.
 */
export function readRepoCleanupOverrides(workspaceRoot: string | undefined, log: (message: string) => void = () => undefined): Partial<CleanupSettings> {
  if (!workspaceRoot) {
    return {};
  }

  try {
    const configPath = REPOSITORY_CONFIG_NAMES.map((name) => path.join(workspaceRoot, name)).find((file) => fs.existsSync(file));
    if (!configPath) {
      return {};
    }

    const file = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { cleanup?: Record<string, unknown> };
    const defaults = createDefaultSettings();
    const cleanup = file?.cleanup;
    if (!cleanup || typeof cleanup !== 'object' || Array.isArray(cleanup)) {
      return {};
    }

    for (const [key, reason] of Object.entries(VISUAL_STUDIO_ONLY_KEYS)) {
      const reported = `${configPath}\n${key}`;
      if (key in cleanup && !reportedIgnoredKeys.has(reported)) {
        reportedIgnoredKeys.add(reported);
        log(`'.codejanitor' key ${key} is ignored by VS Code: ${reason}.`);
      }
    }

    const overrides: Partial<CleanupSettings> = {};
    applyBooleanAlias(cleanup, overrides, 'insertBlankLinePadding', [
      'insertBlankLinePaddingBeforeClasses',
      'insertBlankLinePaddingAfterClasses',
      'insertBlankLinePaddingBeforeDelegates',
      'insertBlankLinePaddingAfterDelegates',
      'insertBlankLinePaddingBeforeEnumerations',
      'insertBlankLinePaddingAfterEnumerations',
      'insertBlankLinePaddingBeforeEvents',
      'insertBlankLinePaddingAfterEvents',
      'insertBlankLinePaddingBeforeFieldsMultiLine',
      'insertBlankLinePaddingAfterFieldsMultiLine',
      'insertBlankLinePaddingBeforeInterfaces',
      'insertBlankLinePaddingAfterInterfaces',
      'insertBlankLinePaddingBeforeMethods',
      'insertBlankLinePaddingAfterMethods',
      'insertBlankLinePaddingBeforeNamespaces',
      'insertBlankLinePaddingAfterNamespaces',
      'insertBlankLinePaddingBeforePropertiesMultiLine',
      'insertBlankLinePaddingAfterPropertiesMultiLine',
      'insertBlankLinePaddingBeforeStructs',
      'insertBlankLinePaddingAfterStructs',
      'insertBlankLinePaddingBeforeRegionTags',
      'insertBlankLinePaddingAfterRegionTags',
      'insertBlankLinePaddingBeforeEndRegionTags',
      'insertBlankLinePaddingAfterEndRegionTags',
      'insertBlankLinePaddingBeforeUsingStatementBlocks',
      'insertBlankLinePaddingAfterUsingStatementBlocks',
      'insertBlankLinePaddingBeforeCaseStatements',
    ]);
    applyBooleanAlias(cleanup, overrides, 'insertExplicitAccessModifiers', [
      'insertExplicitAccessModifiersOnClasses',
      'insertExplicitAccessModifiersOnDelegates',
      'insertExplicitAccessModifiersOnEnumerations',
      'insertExplicitAccessModifiersOnEvents',
      'insertExplicitAccessModifiersOnFields',
      'insertExplicitAccessModifiersOnInterfaces',
      'insertExplicitAccessModifiersOnMethods',
      'insertExplicitAccessModifiersOnProperties',
      'insertExplicitAccessModifiersOnStructs',
    ]);

    for (const key of Object.keys(defaults) as (keyof CleanupSettings)[]) {
      const value = cleanup[key];
      if (key === 'fileHeaderPosition' || key === 'fileHeaderUpdateMode') {
        const enumValue = value === 'afterUsings' || value === 'replace' ? value : value === 'documentStart' || value === 'insert' ? value : undefined;
        if (enumValue !== undefined) {
          (overrides as Record<string, unknown>)[key] = key === 'fileHeaderPosition'
            ? enumValue === 'afterUsings' ? HeaderPosition.AfterUsings : HeaderPosition.DocumentStart
            : enumValue === 'replace' ? HeaderUpdateMode.Replace : HeaderUpdateMode.Insert;
        }

        continue;
      }

      if (value === undefined || typeof value !== typeof defaults[key]) {
        continue;
      }

      (overrides as Record<string, unknown>)[key] = value;
    }

    return overrides;
  } catch {
    return {};
  }
}

function applyBooleanAlias(
  config: Record<string, unknown>,
  overrides: Partial<CleanupSettings>,
  key: string,
  targetKeys: readonly string[]
): void {
  if (typeof config[key] !== 'boolean') {
    return;
  }

  for (const targetKey of targetKeys) {
    (overrides as Record<string, unknown>)[targetKey] = config[key];
  }
}
