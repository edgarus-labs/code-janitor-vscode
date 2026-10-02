import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatCodeStyleSetting, getCodeStyleRule } from './codeStyleRules';
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

/** `.codejanitor` keys whose name differs from the setting of the pipeline's shape. */
const KEY_ALIASES: Readonly<Record<string, keyof CleanupSettings>> = {
  insertBlankLineBeforeReturnAndThrow: 'insertBlankLineBeforeReturnAndThrowStatements',
};

const INSERT_BLANK_LINE_PADDING_KEYS = [
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
] as const;

const INSERT_EXPLICIT_ACCESS_MODIFIER_KEYS = [
  'insertExplicitAccessModifiersOnClasses',
  'insertExplicitAccessModifiersOnDelegates',
  'insertExplicitAccessModifiersOnEnumerations',
  'insertExplicitAccessModifiersOnEvents',
  'insertExplicitAccessModifiersOnFields',
  'insertExplicitAccessModifiersOnInterfaces',
  'insertExplicitAccessModifiersOnMethods',
  'insertExplicitAccessModifiersOnProperties',
  'insertExplicitAccessModifiersOnStructs',
] as const;

/** The ignored keys already logged in this session, as `<.codejanitor path>\n<key>`: settings are read on every save. */
const reportedIgnoredKeys = new Set<string>();

/** What `.codejanitor` decides for a file: the cleanup flags it lists and its Code Style rules. */
export interface RepositoryPolicy {
  /** The file the policy was read from; undefined when none applies (or it could not be read). */
  readonly configPath?: string;
  /** The cleanup flags the file lists; the rest follow the user's settings. */
  readonly overrides: Partial<CleanupSettings>;
  /**
   * The `cleanup.codeStyle` section, keyed by `.editorconfig` option name: a valid value (normalized)
   * enables the rule with that value, `null` disables it. Rules it does not list follow the user setting.
   */
  readonly codeStyle: Readonly<Record<string, string | null>>;
}

const NO_POLICY: RepositoryPolicy = { overrides: {}, codeStyle: {} };

/**
 * The nearest `.codejanitor` (or `.code-janitor.json`) of the directory and its ancestors: the nearest
 * file wins, as in the Visual Studio extension.
 */
export function findRepositoryConfigFile(startDirectory: string): string | undefined {
  let directory = path.resolve(startDirectory);

  for (;;) {
    const found = REPOSITORY_CONFIG_NAMES.map((name) => path.join(directory, name)).find((file) => isFile(file));
    if (found) {
      return found;
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      return undefined;
    }

    directory = parent;
  }
}

/**
 * Reads the optional repository policy that applies to files in `startDirectory` (usually the
 * directory of the cleaned file). Invalid JSON, unknown keys and wrong value types are ignored; the
 * Visual Studio-only keys are passed to `log` as ignored, once per session.
 */
export function readRepositoryPolicy(startDirectory: string | undefined, log: (message: string) => void = () => undefined): RepositoryPolicy {
  if (!startDirectory) {
    return NO_POLICY;
  }

  try {
    const configPath = findRepositoryConfigFile(startDirectory);
    if (!configPath) {
      return NO_POLICY;
    }

    const policy = parseRepositoryPolicy(fs.readFileSync(configPath, 'utf8'), (key, reason) => {
      const reported = `${configPath}\n${key}`;
      if (!reportedIgnoredKeys.has(reported)) {
        reportedIgnoredKeys.add(reported);
        log(`'.codejanitor' key ${key} is ignored by VS Code: ${reason}.`);
      }
    });

    return { ...policy, configPath };
  } catch {
    return NO_POLICY;
  }
}

/**
 * Parses the text of a `.codejanitor` file. Invalid JSON, a missing `cleanup` section, unknown keys
 * and wrong value types yield nothing for the entry; `onIgnoredKey` receives the Visual Studio-only keys.
 */
export function parseRepositoryPolicy(text: string, onIgnoredKey?: (key: string, reason: string) => void): RepositoryPolicy {
  let file: { cleanup?: unknown } | undefined;
  try {
    file = JSON.parse(text) as { cleanup?: unknown };
  } catch {
    return NO_POLICY;
  }

  const cleanup = file?.cleanup;
  if (!cleanup || typeof cleanup !== 'object' || Array.isArray(cleanup)) {
    return NO_POLICY;
  }

  const section = cleanup as Record<string, unknown>;
  for (const [key, reason] of Object.entries(VISUAL_STUDIO_ONLY_KEYS)) {
    if (key in section) {
      onIgnoredKey?.(key, reason);
    }
  }

  const defaults = createDefaultSettings();
  const overrides: Partial<CleanupSettings> = {};
  applyBooleanAlias(section, overrides, 'insertBlankLinePadding', INSERT_BLANK_LINE_PADDING_KEYS);
  applyBooleanAlias(section, overrides, 'insertExplicitAccessModifiers', INSERT_EXPLICIT_ACCESS_MODIFIER_KEYS);

  const readers: [string, keyof CleanupSettings][] = [
    ...(Object.keys(defaults) as (keyof CleanupSettings)[])
      .filter((key) => key !== 'codeStyleRules' && key !== 'reorganize')
      .map((key): [string, keyof CleanupSettings] => [key, key]),
    ...Object.entries(KEY_ALIASES).map(([alias, key]): [string, keyof CleanupSettings] => [alias, key]),
  ];
  for (const [name, key] of readers) {
    const value = section[name];
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

  return { overrides, codeStyle: parseCodeStyleSection(section.codeStyle) };
}

/** The user's settings with the policy applied: a key listed in `.codejanitor` wins over the user's setting. */
export function applyRepositoryPolicy(user: CleanupSettings, policy: RepositoryPolicy): CleanupSettings {
  const codeStyleRules: Record<string, string> = { ...user.codeStyleRules };
  for (const [key, value] of Object.entries(policy.codeStyle)) {
    if (value === null) {
      delete codeStyleRules[key];
    } else {
      codeStyleRules[key] = value;
    }
  }

  return { ...user, ...policy.overrides, codeStyleRules: formatCodeStyleSetting(codeStyleRules) };
}

/**
 * The rules of the `codeStyle` object: a string value valid for the rule (matched ignoring case, so
 * `"True"` works; JSON booleans are ignored) enables it, `null` disables it; unknown rules and invalid
 * values are ignored.
 */
function parseCodeStyleSection(codeStyle: unknown): Record<string, string | null> {
  const rules: Record<string, string | null> = {};
  if (!codeStyle || typeof codeStyle !== 'object' || Array.isArray(codeStyle)) {
    return rules;
  }

  for (const [key, value] of Object.entries(codeStyle)) {
    const rule = getCodeStyleRule(key);
    if (!rule) {
      continue;
    }

    if (value === null) {
      rules[key] = null;
    } else if (typeof value === 'string' && rule.isValidValue(value.trim())) {
      rules[key] = rule.normalize(value);
    }
  }

  return rules;
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
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
