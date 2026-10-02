import * as path from 'node:path';
import { CODE_STYLE_RULES, getCodeStyleRule } from './codeStyleRules';
import {
  EditorConfigProperties,
  EditorConfigSeverity,
  isDisabledByDefaultDiagnostic,
  isEnforced,
  loadEditorConfigProperties,
  parseSeverity,
  withEntryOverrides,
} from './editorconfig';
import { SUPPORTED_DIAGNOSTICS, effectiveEditorConfigValue } from './editorConfigRegistry';
import { CleanupSettings } from './types';

/**
 * Resolves the cleanup settings that apply to one file (port of `EffectiveCleanupSettings.cs` of the
 * Visual Studio extension): a setting defined by `.editorconfig` wins, otherwise the repository policy
 * (`.codejanitor`) wins, otherwise the user's VS Code setting applies - the last two are already merged
 * into the `settings` passed in (see `applyRepositoryPolicy`). A plain `.editorconfig` option (such as
 * `indent_style`) whose severity suffix is `:none` or `:silent` is ignored, as are options with
 * unrecognized values or severities, so the next source decides; `suggestion` or higher, or no suffix,
 * enforces the value. A Roslyn rule is enforced as Roslyn reports it (see {@link readRule}), which also
 * resolves the Code Janitor Code Style rules (`codeStyleRules.ts`).
 */

export type NamespaceDeclarationPreference = 'unchanged' | 'fileScoped' | 'blockScoped';
export type UsingDirectivePlacementPreference = 'unchanged' | 'outsideNamespace' | 'insideNamespace';

export interface EffectiveCleanupSettings {
  /** The settings with every key `.editorconfig` decides for the file replaced by its value. */
  readonly settings: CleanupSettings;
  /**
   * The `.editorconfig` properties of the file with the enabled Code Style rules layered on top
   * (analysis only; nothing is written): the rules, as `suggestion`, and the severities of their diagnostics.
   */
  readonly properties: EditorConfigProperties;
  /**
   * The settings decided by `.editorconfig` for this file, each mapped to the option name (lower-cased for
   * a severity entry) that decides it. A setting absent from the map follows the repository policy or the user setting.
   */
  readonly editorConfigKeys: ReadonlyMap<string, string>;
  /**
   * The enabled Code Style rules that apply to this file because `.editorconfig` does not enforce them,
   * keyed by option name, with the value from the repository policy or the user setting.
   */
  readonly codeStyleValues: ReadonlyMap<string, string>;
  /** The Code Style rules `.editorconfig` enforces for this file, each mapped to the entry that enforces it. */
  readonly codeStyleEditorConfigKeys: ReadonlyMap<string, string>;
  /**
   * The entries layered on top of `.editorconfig` so the rule engine applies exactly the rules of
   * {@link codeStyleValues}: each rule with its value and `suggestion` severity, the severity of its
   * diagnostics raised to `suggestion`, and every other rule reported through one of those diagnostics,
   * unless `.editorconfig` enforces it, silenced with `none`.
   */
  readonly analyzerConfigOverrides: ReadonlyMap<string, string>;
  /** The namespace declaration style to enforce (`csharp_style_namespace_declarations`, else the setting). */
  readonly namespaceDeclarations: NamespaceDeclarationPreference;
  /** The using directive placement to enforce (`csharp_using_directive_placement`, else the setting). */
  readonly usingDirectivePlacement: UsingDirectivePlacementPreference;
  /**
   * One message per enabled Code Style rule whose value the rule engine has no implementation for (for example
   * framework type names instead of keywords): it is never silently ignored.
   */
  readonly unresolvedRules: readonly string[];
}

/** The `.editorconfig` value of one cleanup setting: how it is parsed and Roslyn's default when only a severity is set. */
interface RuleLink {
  readonly settings: readonly (keyof CleanupSettings)[];
  /** The option name, or undefined for a rule configured by severity only. */
  readonly key: string | undefined;
  readonly diagnosticIds: readonly string[];
  readonly parse: ((value: string) => boolean | undefined) | undefined;
  /** The setting value when the rule is enforced with Roslyn's default option value. */
  readonly defaultValue: boolean;
}

const parseBoolean = (value: string): boolean | undefined => (value.toLowerCase() === 'true' ? true : value.toLowerCase() === 'false' ? false : undefined);
const parseInvertedBoolean = (value: string): boolean | undefined => {
  const parsed = parseBoolean(value);

  return parsed === undefined ? undefined : !parsed;
};
const parseExpressionBodyPreference = (value: string): boolean | undefined =>
  value.toLowerCase() === 'when_on_single_line' ? true : parseBoolean(value);
const parseCollectionExpressionPreference = (value: string): boolean | undefined => {
  switch (value.toLowerCase()) {
    case 'true':
    case 'when_types_exactly_match':
    case 'when_types_loosely_match':
      return true;
    case 'false':
    case 'never':
      return false;
    default:
      return undefined;
  }
};
const parseAccessibilityModifiersPreference = (value: string): boolean | undefined => {
  switch (value.toLowerCase()) {
    case 'always':
    case 'for_non_interface_members':
      return true;
    case 'never':
    case 'omit_if_default':
      return false;
    default:
      return undefined;
  }
};

const link = (
  settings: readonly (keyof CleanupSettings)[],
  key: string | undefined,
  diagnosticIds: readonly string[],
  parse: RuleLink['parse'],
  defaultValue: boolean
): RuleLink => ({ settings, key, diagnosticIds, parse, defaultValue });

const EXPLICIT_ACCESS_MODIFIER_SETTINGS = [
  'insertExplicitAccessModifiersOnClasses',
  'insertExplicitAccessModifiersOnDelegates',
  'insertExplicitAccessModifiersOnEnumerations',
  'insertExplicitAccessModifiersOnEvents',
  'insertExplicitAccessModifiersOnFields',
  'insertExplicitAccessModifiersOnInterfaces',
  'insertExplicitAccessModifiersOnMethods',
  'insertExplicitAccessModifiersOnProperties',
  'insertExplicitAccessModifiersOnStructs',
] as const satisfies readonly (keyof CleanupSettings)[];

/** The settings whose step has a Roslyn rule counterpart (the key table of `docs/features.md`, "Settings precedence"). */
const RULE_LINKS: readonly RuleLink[] = [
  link(['convertToVarWhenApparent'], 'csharp_style_var_when_type_is_apparent', ['IDE0007', 'IDE0008'], parseBoolean, false),
  link(['inlineOutVariableDeclarations'], 'csharp_style_inlined_variable_declaration', ['IDE0018'], parseBoolean, true),
  link(
    ['convertToCollectionExpressions'],
    'dotnet_style_prefer_collection_expression',
    ['IDE0300', 'IDE0301', 'IDE0302', 'IDE0303', 'IDE0304', 'IDE0305', 'IDE0306'],
    parseCollectionExpressionPreference,
    true
  ),
  link(['makeFieldsReadonlyWhenSafe'], 'dotnet_style_readonly_field', ['IDE0044'], parseBoolean, true),
  link(EXPLICIT_ACCESS_MODIFIER_SETTINGS, 'dotnet_style_require_accessibility_modifiers', ['IDE0040'], parseAccessibilityModifiersPreference, true),
  link(['simplifySingleStatementLambdas'], 'csharp_style_expression_bodied_lambdas', ['IDE0053'], parseExpressionBodyPreference, true),
  link(['sealClassesWhenSafe'], undefined, ['CA1852'], undefined, true),
  link(['convertToStringNameOf'], undefined, ['CA1507'], undefined, true),
  link(['reuseJsonSerializerOptionsForCA1869'], undefined, ['CA1869'], undefined, true),
  link(['removeMultipleConsecutiveBlankLines'], 'dotnet_style_allow_multiple_blank_lines_experimental', ['IDE2000'], parseInvertedBoolean, false),
  link(
    ['removeBlankLinesAfterOpeningBrace', 'removeBlankLinesBeforeClosingBrace'],
    'csharp_style_allow_blank_lines_between_consecutive_braces_experimental',
    ['IDE2002'],
    parseInvertedBoolean,
    false
  ),
];

/** The two rules that decide `convertToPatternMatchingNullChecks` together (both default to true). */
const NULL_CHECK_RULES = [
  { key: 'csharp_style_prefer_null_check_over_type_check', diagnosticId: 'IDE0150' },
  { key: 'dotnet_style_prefer_is_null_check_over_reference_equality_method', diagnosticId: 'IDE0041' },
] as const;

interface RawOption {
  readonly value: string;
  readonly severity: EditorConfigSeverity | undefined;
}

/**
 * Splits an option in the `value[:severity]` form. Undefined when the option is not defined, has two
 * suffixes or an unrecognized severity, so it is ignored.
 */
function readRawOption(props: EditorConfigProperties, key: string): RawOption | undefined {
  const raw = props.get(key);
  if (raw === undefined) {
    return undefined;
  }

  const separator = raw.indexOf(':');
  if (separator < 0) {
    return { value: raw.trim(), severity: undefined };
  }

  const severity = parseSeverity(raw.slice(separator + 1));
  if (separator !== raw.lastIndexOf(':') || severity === undefined) {
    return undefined;
  }

  return { value: raw.slice(0, separator).trim(), severity };
}

/** Whether an option severity suffix enforces the option: none at all, or `suggestion` or higher. */
function isEnforcingSuffix(severity: EditorConfigSeverity | undefined): boolean {
  return severity === undefined || isEnforced(severity);
}

/** Reads a plain option (one without a Roslyn rule): the value when it parses and its suffix enforces it. */
function readPlainOption<T>(props: EditorConfigProperties, key: string, parse: (value: string) => T | undefined): T | undefined {
  const option = readRawOption(props, key);
  const parsed = option && parse(option.value);

  return option && parsed !== undefined && isEnforcingSuffix(option.severity) ? parsed : undefined;
}

/** The analyzer category of a diagnostic, which `dotnet_analyzer_diagnostic.category-<category>.severity` configures. */
function categoryOf(diagnosticId: string): string | undefined {
  return /^IDE/i.test(diagnosticId) ? 'Style' : SUPPORTED_DIAGNOSTICS[diagnosticId.toUpperCase()]?.category;
}

/**
 * The severity `.editorconfig` configures for a diagnostic other than through an option suffix: the first
 * recognized one of `dotnet_diagnostic.<id>.severity`, the category severity and the global severity
 * (the last two do not apply to a rule that is disabled by default). `key` is the lower-cased entry.
 */
function readDiagnosticSeverity(props: EditorConfigProperties, diagnosticId: string): { key: string; enforced: boolean } | undefined {
  const category = categoryOf(diagnosticId);
  const bulkApplies = !isDisabledByDefaultDiagnostic(diagnosticId);
  const candidates = [
    `dotnet_diagnostic.${diagnosticId.toLowerCase()}.severity`,
    bulkApplies && category ? `dotnet_analyzer_diagnostic.category-${category.toLowerCase()}.severity` : undefined,
    bulkApplies ? 'dotnet_analyzer_diagnostic.severity' : undefined,
  ];

  for (const key of candidates) {
    const severity = key === undefined ? undefined : parseSeverity(props.get(key));
    if (key !== undefined && severity !== undefined) {
      return { key, enforced: isEnforced(severity) };
    }
  }

  return undefined;
}

/**
 * Reads a Roslyn rule configured by an option and the severities of its diagnostics, resolved as Roslyn
 * reports it. An option with the `:none` suffix stops the rule whatever else is configured. Otherwise the
 * effective severity of each diagnostic is the first one defined of `dotnet_diagnostic.<id>.severity`,
 * `dotnet_analyzer_diagnostic.category-<category>.severity`, `dotnet_analyzer_diagnostic.severity` and the
 * option's severity suffix; an option without a suffix enforces the diagnostics none of those configure.
 * The rule is enforced when one of its diagnostics is `suggestion` or higher, and not enforced when none is
 * (all `none` or `silent`, or nothing configured), so the next source decides.
 *
 * @returns `value`: the enforced option value, or undefined when the rule is enforced with Roslyn's default value;
 *   `decidingKey`: the option name when the option is defined, otherwise the severity entry that enforces the rule.
 */
function readRule(
  props: EditorConfigProperties,
  key: string | undefined,
  diagnosticIds: readonly string[],
  isValidValue: (value: string) => boolean
): { value: string | undefined; decidingKey: string } | undefined {
  const option = key === undefined ? undefined : readRawOption(props, key);
  const defined = option !== undefined && isValidValue(option.value);
  if (defined && option.severity === 'none') {
    // Roslyn does not run the rule's analysis at all, whatever severity its diagnostics get.
    return undefined;
  }

  let enforcingKey: string | undefined;
  for (const diagnosticId of diagnosticIds) {
    const configured = readDiagnosticSeverity(props, diagnosticId);
    if (configured) {
      enforcingKey ??= configured.enforced ? configured.key : undefined;
    } else if (defined && isEnforcingSuffix(option.severity)) {
      enforcingKey ??= key;
    }
  }

  return enforcingKey === undefined ? undefined : { value: defined ? option.value : undefined, decidingKey: defined ? key! : enforcingKey };
}

/**
 * Resolves the effective settings of one file. `settings` holds the repository policy merged over the user's
 * settings; `.editorconfig` decides over both. Missing or unreadable configuration files are ignored; a blank
 * path yields `settings` only.
 */
export function resolveEffectiveCleanupSettings(
  filePath: string,
  settings: CleanupSettings,
  base: EditorConfigProperties = loadEditorConfigProperties(filePath)
): EffectiveCleanupSettings {
  const resolved: CleanupSettings = { ...settings };
  const editorConfigKeys = new Map<string, string>();
  const decide = (setting: keyof CleanupSettings, key: string, value: boolean | string): void => {
    (resolved as unknown as Record<string, unknown>)[setting] = value;
    editorConfigKeys.set(setting, key);
  };

  const trim = readPlainOption(base, 'trim_trailing_whitespace', parseBoolean);
  if (trim !== undefined) {
    decide('removeEndOfLineWhitespace', 'trim_trailing_whitespace', trim);
  }

  for (const entry of RULE_LINKS) {
    const rule = readRule(base, entry.key, entry.diagnosticIds, (value) => entry.parse?.(value) !== undefined);
    if (rule) {
      const value = rule.value === undefined ? entry.defaultValue : entry.parse!(rule.value)!;
      for (const setting of entry.settings) {
        decide(setting, rule.decidingKey, value);
      }
    }
  }

  resolveNullChecks(base, decide);
  resolveFileHeader(base, filePath, decide);

  const namespaceDeclarations = resolveNamespaceDeclarations(base, resolved, decide);
  const usingDirectivePlacement = resolveUsingDirectivePlacement(base, resolved, decide);
  resolved.organizeUsings = resolveOrganizeUsings(base, settings.organizeUsings);

  const codeStyle = resolveCodeStyleRules(base, settings.codeStyleRules ?? {});
  resolved.codeStyleRules = Object.fromEntries(codeStyle.values);

  const properties = codeStyle.overrides.size === 0 ? base : withEntryOverrides(base, codeStyle.overrides);

  return {
    settings: resolved,
    properties,
    editorConfigKeys,
    codeStyleValues: codeStyle.values,
    codeStyleEditorConfigKeys: codeStyle.editorConfigKeys,
    analyzerConfigOverrides: codeStyle.overrides,
    namespaceDeclarations,
    usingDirectivePlacement,
    unresolvedRules: [...codeStyle.values]
      .filter(([key]) => effectiveEditorConfigValue(properties, key) === undefined)
      .map(([key, value]) => `Code Style rule ${key} = ${value} (${getCodeStyleRule(key)?.diagnosticIds.join('/')}) is not implemented by Code Janitor for VS Code, so it was not applied.`),
  };
}

type Decide = (setting: keyof CleanupSettings, key: string, value: boolean | string) => void;

/**
 * `convertToPatternMatchingNullChecks` is decided by two Roslyn rules: when `.editorconfig` enforces either,
 * null checks are converted only if every enforced rule prefers null checks (both default to true). The note
 * names the first enforced rule, or the first one that turns the conversion off.
 */
function resolveNullChecks(props: EditorConfigProperties, decide: Decide): void {
  let convert: boolean | undefined;
  let decidingKey: string | undefined;

  for (const rule of NULL_CHECK_RULES) {
    const read = readRule(props, rule.key, [rule.diagnosticId], (value) => parseBoolean(value) !== undefined);
    if (!read) {
      continue;
    }

    const prefersNullCheck = read.value === undefined || parseBoolean(read.value) === true;
    if (convert === undefined || (convert && !prefersNullCheck)) {
      decidingKey = read.decidingKey;
    }

    convert = (convert ?? true) && prefersNullCheck;
  }

  if (convert !== undefined) {
    decide('convertToPatternMatchingNullChecks', decidingKey!, convert);
  }
}

/**
 * The C# file header defined by `file_header_template`: each template line becomes a `//` comment line, `\n`
 * escapes separate lines and `{fileName}` is replaced by the file name. `unset` or an empty template defines
 * an empty header. The option takes no severity suffix and is not gated by IDE0073.
 */
function resolveFileHeader(props: EditorConfigProperties, filePath: string, decide: Decide): void {
  const key = 'file_header_template';
  const raw = props.get(key);
  if (raw === undefined && !props.unsetKeys?.has(key)) {
    return;
  }

  const template = raw?.trim() ?? '';
  if (template === '' || template.toLowerCase() === 'unset') {
    decide('fileHeaderCSharp', key, '');

    return;
  }

  const lines = template
    .replace(/\{fileName\}/g, filePath ? path.basename(filePath) : '')
    .split('\\n')
    .map((line) => (line.length === 0 ? '//' : `// ${line}`));
  decide('fileHeaderCSharp', key, lines.join('\n'));
}

/**
 * The namespace declaration style: `.editorconfig` wins when it enforces `csharp_style_namespace_declarations`
 * (IDE0160, IDE0161), with Roslyn's default `block_scoped` when enforced by severity only; otherwise the
 * file-scoped conversion setting decides.
 */
function resolveNamespaceDeclarations(props: EditorConfigProperties, settings: CleanupSettings, decide: Decide): NamespaceDeclarationPreference {
  const parse = (value: string): NamespaceDeclarationPreference | undefined =>
    value.toLowerCase() === 'file_scoped' ? 'fileScoped' : value.toLowerCase() === 'block_scoped' ? 'blockScoped' : undefined;
  const rule = readRule(props, 'csharp_style_namespace_declarations', ['IDE0160', 'IDE0161'], (value) => parse(value) !== undefined);
  if (rule) {
    const preference = rule.value === undefined ? 'blockScoped' : parse(rule.value)!;
    decide('convertToFileScopedNamespace', rule.decidingKey, preference === 'fileScoped');

    return preference;
  }

  return settings.convertToFileScopedNamespace ? 'fileScoped' : 'unchanged';
}

/**
 * The using directive placement: `.editorconfig` wins when it enforces `csharp_using_directive_placement`
 * (IDE0065), with Roslyn's default `outside_namespace` when enforced by severity only; otherwise the
 * move-outside setting decides.
 */
function resolveUsingDirectivePlacement(props: EditorConfigProperties, settings: CleanupSettings, decide: Decide): UsingDirectivePlacementPreference {
  const parse = (value: string): UsingDirectivePlacementPreference | undefined =>
    value.toLowerCase() === 'outside_namespace' ? 'outsideNamespace' : value.toLowerCase() === 'inside_namespace' ? 'insideNamespace' : undefined;
  const rule = readRule(props, 'csharp_using_directive_placement', ['IDE0065'], (value) => parse(value) !== undefined);
  if (rule) {
    const preference = rule.value === undefined ? 'outsideNamespace' : parse(rule.value)!;
    decide('moveUsingsOutsideNamespace', rule.decidingKey, preference === 'outsideNamespace');

    return preference;
  }

  return settings.moveUsingsOutsideNamespace ? 'outsideNamespace' : 'unchanged';
}

/**
 * Whether using directives are organized. `.editorconfig` turns it off when it contradicts the organizer
 * (System directives not first, or groups separated) and on when System directives first is enforced;
 * otherwise the policy or user setting decides.
 */
function resolveOrganizeUsings(props: EditorConfigProperties, configured: boolean): boolean {
  const sortSystemFirst = readPlainOption(props, 'dotnet_sort_system_directives_first', parseBoolean);
  const separateGroups = readPlainOption(props, 'dotnet_separate_import_directive_groups', parseBoolean);
  if ((sortSystemFirst !== undefined && sortSystemFirst !== true) || (separateGroups !== undefined && separateGroups !== false)) {
    return false;
  }

  return sortSystemFirst === true || configured;
}

interface CodeStyleResolution {
  readonly values: ReadonlyMap<string, string>;
  readonly editorConfigKeys: ReadonlyMap<string, string>;
  readonly overrides: ReadonlyMap<string, string>;
}

/**
 * Resolves every Code Style rule: `.editorconfig` wins when it enforces the rule (see {@link readRule});
 * otherwise an enabled rule (`rules`: repository policy, else the user setting) applies with its value.
 * The overrides are the analyzer configuration entries the rule engine applies on top of `.editorconfig`.
 */
function resolveCodeStyleRules(props: EditorConfigProperties, rules: Readonly<Record<string, string>>): CodeStyleResolution {
  const values = new Map<string, string>();
  const editorConfigKeys = new Map<string, string>();

  for (const rule of CODE_STYLE_RULES) {
    const enforced = readRule(props, rule.key, rule.diagnosticIds, rule.isValidValue);
    if (enforced) {
      editorConfigKeys.set(rule.key, enforced.decidingKey);
    } else if (rule.key in rules && rule.isValidValue(rules[rule.key])) {
      values.set(rule.key, rule.normalize(rules[rule.key]));
    }
  }

  const overrides = new Map<string, string>();
  const raisedDiagnosticIds = new Set<string>();
  for (const rule of CODE_STYLE_RULES.filter((entry) => values.has(entry.key))) {
    overrides.set(rule.key, `${values.get(rule.key)}:suggestion`);
    for (const diagnosticId of rule.diagnosticIds) {
      overrides.set(`dotnet_diagnostic.${diagnosticId}.severity`, 'suggestion');
      raisedDiagnosticIds.add(diagnosticId.toUpperCase());
    }
  }

  // A raised severity would also surface the diagnostics other rules report under the same ID (e.g. IDE0009 for
  // every 'this.' qualification option), so the rules Code Janitor does not apply and .editorconfig does not
  // enforce are switched off.
  for (const rule of CODE_STYLE_RULES) {
    if (values.has(rule.key) || editorConfigKeys.has(rule.key) || !rule.diagnosticIds.some((id) => raisedDiagnosticIds.has(id.toUpperCase()))) {
      continue;
    }

    const configured = readRawOption(props, rule.key);
    const value = configured && rule.isValidValue(configured.value) ? rule.normalize(configured.value) : rule.defaultValue;
    overrides.set(rule.key, `${value}:none`);
  }

  return { values, editorConfigKeys, overrides };
}
