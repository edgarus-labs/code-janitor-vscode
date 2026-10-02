/**
 * The Roslyn code-style options Code Janitor can apply when `.editorconfig` does not enforce them
 * (port of `CodeStyleRules.cs` of the Visual Studio extension), and the format of the VS Code
 * setting (`codeJanitor.cleanup.codeStyleRules`) that stores the enabled ones: an object keyed by
 * `.editorconfig` option name whose value is the option value. Naming rules (`dotnet_naming_*`)
 * are not included: they are configured in `.editorconfig` only.
 */

export interface CodeStyleRule {
  /** The group shown in the settings panel. */
  readonly group: string;
  /** The `.editorconfig` option name. */
  readonly key: string;
  /** The description shown next to the switch. */
  readonly description: string;
  /** The IDs of the diagnostics reported for the option. */
  readonly diagnosticIds: readonly string[];
  /** The accepted values; empty when the value is free text. */
  readonly values: readonly string[];
  /** The value proposed when the rule is enabled. */
  readonly defaultValue: string;
  /** Whether `value` is a valid value of the option (matched ignoring case for listed values). */
  isValidValue(value: string): boolean;
  /** The canonical form of a value: the matching listed value ignoring case, else the trimmed text. */
  normalize(value: string): string;
}

const MODIFIERS = 'Modifiers';
const BLOCKS = 'Blocks';
const EXPRESSION_BODIES = 'Expression-bodied members';
const PATTERN_MATCHING = 'Pattern matching';
const NULL_CHECKING = 'Null checking';
const MODERN_EXPRESSIONS = 'Modern expressions';
const QUALIFICATION = "'this.' qualification";
const PREDEFINED_TYPES = 'Language keywords vs. framework type names';
const PARENTHESES = 'Parentheses';

/** The groups in the order the settings panel shows them. */
export const CODE_STYLE_GROUPS: readonly string[] = [
  MODIFIERS,
  BLOCKS,
  EXPRESSION_BODIES,
  PATTERN_MATCHING,
  NULL_CHECKING,
  MODERN_EXPRESSIONS,
  QUALIFICATION,
  PREDEFINED_TYPES,
  PARENTHESES,
];

const BOOLEAN = ['true', 'false'];
const EXPRESSION_BODY = ['true', 'false', 'when_on_single_line'];
const PARENTHESES_VALUES = ['always_for_clarity', 'never_if_unnecessary'];

/** The modifiers accepted in `csharp_preferred_modifier_order`. */
const KNOWN_MODIFIERS: ReadonlySet<string> = new Set([
  'public', 'private', 'protected', 'internal', 'file', 'static', 'extern', 'new', 'virtual', 'abstract',
  'sealed', 'override', 'readonly', 'unsafe', 'required', 'volatile', 'async', 'partial', 'const', 'fixed', 'ref',
]);

/** `csharp_preferred_modifier_order`: a comma-separated list of distinct known modifiers. */
function isModifierOrder(value: string): boolean {
  const modifiers = value.split(',').map((modifier) => modifier.trim());

  return modifiers.every((modifier) => KNOWN_MODIFIERS.has(modifier)) && new Set(modifiers).size === modifiers.length;
}

function createRule(
  group: string,
  key: string,
  description: string,
  diagnosticIds: string[],
  values: string[],
  defaultValue: string,
  isValidValue?: (value: string) => boolean
): CodeStyleRule {
  const valid = isValidValue ?? ((value: string) => values.some((entry) => entry.toLowerCase() === value.toLowerCase()));

  return {
    group,
    key,
    description,
    diagnosticIds,
    values,
    defaultValue,
    isValidValue: (value) => typeof value === 'string' && valid(value),
    normalize: (value) => {
      const trimmed = value.trim();

      return values.find((entry) => entry.toLowerCase() === trimmed.toLowerCase()) ?? trimmed;
    },
  };
}

const rule = createRule;

/** Every rule, in the order shown in the settings panel. */
export const CODE_STYLE_RULES: readonly CodeStyleRule[] = [
  rule(MODIFIERS, 'csharp_preferred_modifier_order', 'Order modifiers', ['IDE0036'], [],
    'public,private,protected,internal,file,static,extern,new,virtual,abstract,sealed,override,readonly,unsafe,required,volatile,async',
    isModifierOrder),
  rule(MODIFIERS, 'csharp_prefer_static_local_function', 'Make local functions static', ['IDE0062'], BOOLEAN, 'true'),
  rule(MODIFIERS, 'csharp_prefer_static_anonymous_function', 'Make anonymous functions static', ['IDE0320'], BOOLEAN, 'true'),
  rule(MODIFIERS, 'csharp_style_prefer_readonly_struct', 'Make structs readonly', ['IDE0250'], BOOLEAN, 'true'),
  rule(MODIFIERS, 'csharp_style_prefer_readonly_struct_member', 'Make struct members readonly', ['IDE0251'], BOOLEAN, 'true'),

  rule(BLOCKS, 'csharp_prefer_braces', 'Use braces', ['IDE0011'], ['true', 'false', 'when_multiline'], 'true'),
  rule(BLOCKS, 'csharp_prefer_simple_using_statement', "Use simple 'using' statements", ['IDE0063'], BOOLEAN, 'true'),
  rule(BLOCKS, 'csharp_style_prefer_method_group_conversion', 'Convert lambdas to method groups', ['IDE0200'], BOOLEAN, 'true'),

  rule(EXPRESSION_BODIES, 'csharp_style_expression_bodied_methods', 'Methods', ['IDE0022'], EXPRESSION_BODY, 'false'),
  rule(EXPRESSION_BODIES, 'csharp_style_expression_bodied_constructors', 'Constructors', ['IDE0021'], EXPRESSION_BODY, 'false'),
  rule(EXPRESSION_BODIES, 'csharp_style_expression_bodied_operators', 'Operators', ['IDE0023', 'IDE0024'], EXPRESSION_BODY, 'false'),
  rule(EXPRESSION_BODIES, 'csharp_style_expression_bodied_properties', 'Properties', ['IDE0025'], EXPRESSION_BODY, 'true'),
  rule(EXPRESSION_BODIES, 'csharp_style_expression_bodied_indexers', 'Indexers', ['IDE0026'], EXPRESSION_BODY, 'true'),
  rule(EXPRESSION_BODIES, 'csharp_style_expression_bodied_accessors', 'Accessors', ['IDE0027'], EXPRESSION_BODY, 'true'),
  rule(EXPRESSION_BODIES, 'csharp_style_expression_bodied_local_functions', 'Local functions', ['IDE0061'], EXPRESSION_BODY, 'false'),

  rule(PATTERN_MATCHING, 'csharp_style_pattern_matching_over_is_with_cast_check', "Pattern matching over 'is' with cast", ['IDE0020', 'IDE0038'], BOOLEAN, 'true'),
  rule(PATTERN_MATCHING, 'csharp_style_pattern_matching_over_as_with_null_check', "Pattern matching over 'as' with null check", ['IDE0019', 'IDE0260'], BOOLEAN, 'true'),
  rule(PATTERN_MATCHING, 'csharp_style_prefer_pattern_matching', 'Combine patterns', ['IDE0078'], BOOLEAN, 'true'),
  rule(PATTERN_MATCHING, 'csharp_style_prefer_not_pattern', "Use 'not' pattern", ['IDE0083'], BOOLEAN, 'true'),
  rule(PATTERN_MATCHING, 'csharp_style_prefer_extended_property_pattern', 'Use extended property patterns', ['IDE0170'], BOOLEAN, 'true'),
  rule(PATTERN_MATCHING, 'csharp_style_prefer_switch_expression', 'Use switch expressions', ['IDE0066'], BOOLEAN, 'true'),

  rule(NULL_CHECKING, 'dotnet_style_coalesce_expression', "Use '??'", ['IDE0029', 'IDE0030', 'IDE0270'], BOOLEAN, 'true'),
  rule(NULL_CHECKING, 'dotnet_style_null_propagation', "Use '?.'", ['IDE0031'], BOOLEAN, 'true'),
  rule(NULL_CHECKING, 'csharp_style_throw_expression', 'Use throw expressions', ['IDE0016'], BOOLEAN, 'true'),
  rule(NULL_CHECKING, 'csharp_style_conditional_delegate_call', "Invoke delegates with '?.'", ['IDE1005'], BOOLEAN, 'true'),

  rule(MODERN_EXPRESSIONS, 'csharp_style_prefer_primary_constructors', 'Use primary constructors', ['IDE0290'], BOOLEAN, 'true'),
  rule(MODERN_EXPRESSIONS, 'csharp_style_implicit_object_creation_when_type_is_apparent', "Use target-typed 'new()'", ['IDE0090'], BOOLEAN, 'true'),
  rule(MODERN_EXPRESSIONS, 'csharp_style_prefer_index_operator', "Use index operator '^'", ['IDE0056'], BOOLEAN, 'true'),
  rule(MODERN_EXPRESSIONS, 'csharp_style_prefer_range_operator', "Use range operator '..'", ['IDE0057'], BOOLEAN, 'true'),
  rule(MODERN_EXPRESSIONS, 'csharp_style_prefer_utf8_string_literals', 'Use UTF-8 string literals', ['IDE0230'], BOOLEAN, 'true'),
  rule(MODERN_EXPRESSIONS, 'csharp_style_prefer_tuple_swap', 'Swap values with tuples', ['IDE0180'], BOOLEAN, 'true'),
  rule(MODERN_EXPRESSIONS, 'csharp_style_deconstructed_variable_declaration', 'Deconstruct variable declarations', ['IDE0042'], BOOLEAN, 'true'),
  rule(MODERN_EXPRESSIONS, 'csharp_style_unused_value_assignment_preference', 'Unused value assignments', ['IDE0059'], ['discard_variable', 'unused_local_variable'], 'discard_variable'),
  rule(MODERN_EXPRESSIONS, 'csharp_prefer_simple_default_expression', "Use 'default' literal", ['IDE0034'], BOOLEAN, 'true'),
  rule(MODERN_EXPRESSIONS, 'dotnet_style_prefer_auto_properties', 'Use auto-properties', ['IDE0032'], BOOLEAN, 'true'),
  rule(MODERN_EXPRESSIONS, 'dotnet_style_prefer_compound_assignment', 'Use compound assignment', ['IDE0054', 'IDE0074'], BOOLEAN, 'true'),
  rule(MODERN_EXPRESSIONS, 'dotnet_style_prefer_simplified_boolean_expressions', 'Simplify boolean expressions', ['IDE0075'], BOOLEAN, 'true'),
  rule(MODERN_EXPRESSIONS, 'dotnet_style_prefer_simplified_interpolation', 'Simplify interpolation', ['IDE0071'], BOOLEAN, 'true'),
  rule(MODERN_EXPRESSIONS, 'dotnet_style_object_initializer', 'Use object initializers', ['IDE0017'], BOOLEAN, 'true'),
  rule(MODERN_EXPRESSIONS, 'dotnet_style_collection_initializer', 'Use collection initializers', ['IDE0028'], BOOLEAN, 'true'),
  rule(MODERN_EXPRESSIONS, 'dotnet_style_explicit_tuple_names', 'Use explicit tuple names', ['IDE0033'], BOOLEAN, 'true'),
  rule(MODERN_EXPRESSIONS, 'dotnet_style_prefer_inferred_tuple_names', 'Use inferred tuple element names', ['IDE0037'], BOOLEAN, 'true'),
  rule(MODERN_EXPRESSIONS, 'dotnet_style_prefer_inferred_anonymous_type_member_names', 'Use inferred anonymous type member names', ['IDE0037'], BOOLEAN, 'true'),

  rule(QUALIFICATION, 'dotnet_style_qualification_for_field', 'Fields', ['IDE0003', 'IDE0009'], BOOLEAN, 'false'),
  rule(QUALIFICATION, 'dotnet_style_qualification_for_property', 'Properties', ['IDE0003', 'IDE0009'], BOOLEAN, 'false'),
  rule(QUALIFICATION, 'dotnet_style_qualification_for_method', 'Methods', ['IDE0003', 'IDE0009'], BOOLEAN, 'false'),
  rule(QUALIFICATION, 'dotnet_style_qualification_for_event', 'Events', ['IDE0003', 'IDE0009'], BOOLEAN, 'false'),

  rule(PREDEFINED_TYPES, 'dotnet_style_predefined_type_for_locals_parameters_members', 'Locals, parameters and members', ['IDE0049'], BOOLEAN, 'true'),
  rule(PREDEFINED_TYPES, 'dotnet_style_predefined_type_for_member_access', 'Member access expressions', ['IDE0049'], BOOLEAN, 'true'),

  rule(PARENTHESES, 'dotnet_style_parentheses_in_arithmetic_binary_operators', 'Arithmetic operators', ['IDE0047', 'IDE0048'], PARENTHESES_VALUES, 'always_for_clarity'),
  rule(PARENTHESES, 'dotnet_style_parentheses_in_relational_binary_operators', 'Relational operators', ['IDE0047', 'IDE0048'], PARENTHESES_VALUES, 'always_for_clarity'),
  rule(PARENTHESES, 'dotnet_style_parentheses_in_other_binary_operators', 'Other binary operators', ['IDE0047', 'IDE0048'], PARENTHESES_VALUES, 'always_for_clarity'),
  rule(PARENTHESES, 'dotnet_style_parentheses_in_other_operators', 'Other operators', ['IDE0047', 'IDE0048'], PARENTHESES_VALUES, 'never_if_unnecessary'),
];

const RULES_BY_KEY: ReadonlyMap<string, CodeStyleRule> = new Map(CODE_STYLE_RULES.map((entry) => [entry.key, entry]));

/** The rule of the `.editorconfig` option, or `undefined` when it is not a Code Janitor rule. */
export function getCodeStyleRule(key: string | undefined): CodeStyleRule | undefined {
  return key === undefined ? undefined : RULES_BY_KEY.get(key);
}

/** The value of each enabled rule, keyed by `.editorconfig` option name. */
export type CodeStyleValues = Readonly<Record<string, string>>;

/**
 * Reads the value of the VS Code setting that stores the enabled rules: an object keyed by option
 * name with the option value (matched ignoring case, so `"True"` works). Unknown keys and invalid
 * or non-string values (JSON booleans included) are ignored.
 */
export function parseCodeStyleSetting(setting: unknown): CodeStyleValues {
  const values: Record<string, string> = {};
  if (typeof setting !== 'object' || setting === null || Array.isArray(setting)) {
    return values;
  }

  for (const [key, value] of Object.entries(setting as Record<string, unknown>)) {
    const entry = getCodeStyleRule(key.trim());
    if (entry && typeof value === 'string' && entry.isValidValue(value.trim())) {
      values[entry.key] = entry.normalize(value);
    }
  }

  return values;
}

/** The setting value for the enabled rules, in catalog order, with normalized values. */
export function formatCodeStyleSetting(values: Readonly<Record<string, string>>): Record<string, string> {
  const setting: Record<string, string> = {};
  for (const entry of CODE_STYLE_RULES) {
    const value = values[entry.key];
    if (value !== undefined && entry.isValidValue(value.trim())) {
      setting[entry.key] = entry.normalize(value);
    }
  }

  return setting;
}

/** The property of the `codeJanitor.cleanup.codeStyleRules` setting for one rule, as declared in `package.json`. */
export interface CodeStyleRuleSchema {
  readonly type: 'string';
  readonly enum?: readonly string[];
  readonly pattern?: string;
  readonly markdownDescription: string;
}

/**
 * The JSON schema properties of the `codeJanitor.cleanup.codeStyleRules` setting, one per rule, generated
 * from the catalog: `package.json` declares exactly these (a test keeps both in step).
 */
export function codeStyleSettingProperties(): Record<string, CodeStyleRuleSchema> {
  return Object.fromEntries(
    CODE_STYLE_RULES.map((entry): [string, CodeStyleRuleSchema] => [
      entry.key,
      {
        type: 'string',
        ...(entry.values.length > 0 ? { enum: entry.values } : { pattern: '^\\s*\\w+(\\s*,\\s*\\w+)*\\s*$' }),
        markdownDescription: `${entry.group}: ${entry.description} (${entry.diagnosticIds.join(', ')}). Enables the rule with this value, as \`suggestion\`, unless \`.editorconfig\` enforces \`${entry.key}\`. Proposed value: \`${entry.defaultValue}\`.`,
      },
    ])
  );
}
