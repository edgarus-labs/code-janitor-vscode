import { EditorConfigProperties, EditorConfigSeverity, isEnforced, parseSeverity, resolveDiagnosticSeverity, splitOptionSeverity } from './editorconfig';
import { QUALITY_RULES_METADATA } from './analyzerRules';
import { positiveInt } from './transformations/editorConfigSupport';

/**
 * The single registry of `.editorconfig` settings that cleanup applies to C# files, with the
 * condition under which each one takes effect. It decides which settings are reported as not
 * supported and which Code Janitor settings a `.editorconfig` setting overrides.
 */

/** When a supported setting takes effect. */
type Gate =
  /** Whenever it is set: EditorConfig core properties and options without a diagnostic. */
  | { readonly kind: 'always' }
  /** While IDE0055 is enforced: C# formatting options. */
  | { readonly kind: 'formatting' }
  /** While the diagnostic selected by the value is enforced: code-style options (`value:severity`). */
  | {
      readonly kind: 'codeStyle';
      readonly diagnosticId: (value: string) => string;
      /** Every diagnostic `diagnosticId` can select. */
      readonly diagnosticIds: readonly string[];
      /** The value picks one of `diagnosticIds` (the others are not reported); otherwise they share the option. */
      readonly selective: boolean;
    }
  /** While the given diagnostic is enforced; the value carries no severity. */
  | { readonly kind: 'diagnostic'; readonly diagnosticId: string };

interface SupportedSetting {
  readonly gate: Gate;
  /** Accepted values (lower-case); `undefined` accepts any value. */
  readonly accepts?: (value: string) => boolean;
}

const FORMATTING_DIAGNOSTIC_ID = 'IDE0055';
const NAMING_DIAGNOSTIC_ID = 'IDE1006';

const oneOf =
  (...values: string[]) =>
  (value: string): boolean =>
    values.includes(value);
const isBoolean = oneOf('true', 'false');
const always: Gate = { kind: 'always' };
const formatting: Gate = { kind: 'formatting' };
const codeStyle = (diagnosticId: string): Gate => ({ kind: 'codeStyle', diagnosticId: () => diagnosticId, diagnosticIds: [diagnosticId], selective: false });
/** A code-style option whose value selects one of two diagnostics. */
const codeStyleBy = (value: string, whenValue: string, otherwise: string): Gate => ({
  kind: 'codeStyle',
  diagnosticId: (actual) => (actual === value ? whenValue : otherwise),
  diagnosticIds: [whenValue, otherwise],
  selective: true,
});
/** A code-style option shared by several diagnostics, each gating its own part of the rule. */
const codeStyleFamily = (main: string, ...others: string[]): Gate => ({
  kind: 'codeStyle',
  diagnosticId: () => main,
  diagnosticIds: [main, ...others],
  selective: false,
});
const varDiagnostic = codeStyleBy('true', 'IDE0007', 'IDE0008');
const qualificationDiagnostic = codeStyleBy('true', 'IDE0009', 'IDE0003');
const parenthesesDiagnostic = codeStyleBy('always_for_clarity', 'IDE0048', 'IDE0047');
const parenthesesValue = oneOf('always_for_clarity', 'never_if_unnecessary');
const expressionBodyValue = oneOf('true', 'false', 'when_on_single_line', 'when_possible', 'never');

/** The modifiers `csharp_preferred_modifier_order` can list. */
const MODIFIERS = [
  'public',
  'private',
  'protected',
  'internal',
  'file',
  'static',
  'extern',
  'new',
  'virtual',
  'abstract',
  'sealed',
  'override',
  'readonly',
  'unsafe',
  'required',
  'volatile',
  'async',
  'const',
  'fixed',
  'partial',
  'ref',
];

/** The kinds `csharp_new_line_before_open_brace` lists. */
export const OPEN_BRACE_KINDS = [
  'accessors',
  'anonymous_methods',
  'anonymous_types',
  'control_blocks',
  'events',
  'indexers',
  'lambdas',
  'local_functions',
  'methods',
  'object_collection_array_initializers',
  'properties',
  'types',
];

const SUPPORTED_SETTINGS: Record<string, SupportedSetting> = {
  // EditorConfig core properties.
  indent_style: { gate: always, accepts: oneOf('space', 'tab') },
  indent_size: { gate: always, accepts: (value) => value === 'tab' || positiveInt(value) !== undefined },
  tab_width: { gate: always, accepts: (value) => positiveInt(value) !== undefined },
  end_of_line: { gate: always, accepts: oneOf('lf', 'crlf', 'cr') },
  charset: { gate: always, accepts: oneOf('utf-8', 'utf-8-bom') },
  trim_trailing_whitespace: { gate: always, accepts: isBoolean },
  insert_final_newline: { gate: always, accepts: isBoolean },

  // Using directive order: no diagnostic of its own (Organize Usings applies it).
  dotnet_sort_system_directives_first: { gate: always, accepts: isBoolean },
  dotnet_separate_import_directive_groups: { gate: always, accepts: isBoolean },

  // C# formatting options.
  csharp_new_line_before_open_brace: {
    gate: formatting,
    accepts: (value) =>
      value === 'all' || value === 'none' || value.split(',').every((kind) => OPEN_BRACE_KINDS.includes(kind.trim())),
  },
  csharp_new_line_before_else: { gate: formatting, accepts: isBoolean },
  csharp_new_line_before_catch: { gate: formatting, accepts: isBoolean },
  csharp_new_line_before_finally: { gate: formatting, accepts: isBoolean },
  csharp_space_after_cast: { gate: formatting, accepts: isBoolean },
  csharp_space_after_keywords_in_control_flow_statements: { gate: formatting, accepts: isBoolean },
  csharp_new_line_before_members_in_object_initializers: { gate: formatting, accepts: isBoolean },
  csharp_new_line_before_members_in_anonymous_types: { gate: formatting, accepts: isBoolean },
  csharp_new_line_between_query_expression_clauses: { gate: formatting, accepts: isBoolean },
  csharp_preserve_single_line_blocks: { gate: formatting, accepts: isBoolean },
  csharp_preserve_single_line_statements: { gate: formatting, accepts: isBoolean },
  csharp_indent_block_contents: { gate: formatting, accepts: isBoolean },
  csharp_indent_braces: { gate: formatting, accepts: isBoolean },
  csharp_indent_case_contents: { gate: formatting, accepts: isBoolean },
  csharp_indent_case_contents_when_block: { gate: formatting, accepts: isBoolean },
  csharp_indent_switch_labels: { gate: formatting, accepts: isBoolean },
  csharp_indent_labels: { gate: formatting, accepts: oneOf('flush_left', 'one_less_than_current', 'no_change') },
  csharp_space_after_colon_in_inheritance_clause: { gate: formatting, accepts: isBoolean },
  csharp_space_before_colon_in_inheritance_clause: { gate: formatting, accepts: isBoolean },
  csharp_space_after_comma: { gate: formatting, accepts: isBoolean },
  csharp_space_before_comma: { gate: formatting, accepts: isBoolean },
  csharp_space_after_dot: { gate: formatting, accepts: isBoolean },
  csharp_space_before_dot: { gate: formatting, accepts: isBoolean },
  csharp_space_after_semicolon_in_for_statement: { gate: formatting, accepts: isBoolean },
  csharp_space_before_semicolon_in_for_statement: { gate: formatting, accepts: isBoolean },
  csharp_space_around_binary_operators: { gate: formatting, accepts: oneOf('before_and_after', 'none', 'ignore') },
  csharp_space_around_declaration_statements: { gate: formatting, accepts: oneOf('false', 'ignore') },
  csharp_space_before_open_square_brackets: { gate: formatting, accepts: isBoolean },
  csharp_space_between_empty_square_brackets: { gate: formatting, accepts: isBoolean },
  csharp_space_between_square_brackets: { gate: formatting, accepts: isBoolean },
  csharp_space_between_method_call_name_and_opening_parenthesis: { gate: formatting, accepts: isBoolean },
  csharp_space_between_method_call_parameter_list_parentheses: { gate: formatting, accepts: isBoolean },
  csharp_space_between_method_call_empty_parameter_list_parentheses: { gate: formatting, accepts: isBoolean },
  csharp_space_between_method_declaration_name_and_open_parenthesis: { gate: formatting, accepts: isBoolean },
  csharp_space_between_method_declaration_parameter_list_parentheses: { gate: formatting, accepts: isBoolean },
  csharp_space_between_method_declaration_empty_parameter_list_parentheses: { gate: formatting, accepts: isBoolean },
  csharp_space_between_parentheses: {
    gate: formatting,
    accepts: (value) =>
      value === 'false' ||
      value.split(',').every((kind) => ['control_flow_statements', 'expressions', 'type_casts'].includes(kind.trim())),
  },
  // Roslyn's formatter never moves operators; the option only steers wrapping refactorings.
  dotnet_style_operator_placement_when_wrapping: { gate: formatting, accepts: oneOf('beginning_of_line', 'end_of_line') },

  // Code-style preferences.
  csharp_style_namespace_declarations: {
    gate: codeStyleBy('block_scoped', 'IDE0160', 'IDE0161'),
    accepts: oneOf('block_scoped', 'file_scoped'),
  },
  dotnet_style_require_accessibility_modifiers: {
    gate: codeStyle('IDE0040'),
    accepts: oneOf('always', 'for_non_interface_members', 'omit_if_default', 'never'),
  },
  csharp_style_var_for_built_in_types: { gate: varDiagnostic, accepts: isBoolean },
  csharp_style_var_when_type_is_apparent: { gate: varDiagnostic, accepts: isBoolean },
  csharp_style_var_elsewhere: { gate: varDiagnostic, accepts: isBoolean },
  csharp_prefer_braces: { gate: codeStyle('IDE0011'), accepts: oneOf('true', 'false', 'when_multiline') },
  dotnet_style_qualification_for_field: { gate: qualificationDiagnostic, accepts: isBoolean },
  dotnet_style_qualification_for_property: { gate: qualificationDiagnostic, accepts: isBoolean },
  dotnet_style_qualification_for_method: { gate: qualificationDiagnostic, accepts: isBoolean },
  dotnet_style_qualification_for_event: { gate: qualificationDiagnostic, accepts: isBoolean },
  csharp_using_directive_placement: {
    gate: codeStyle('IDE0065'),
    accepts: oneOf('outside_namespace', 'inside_namespace'),
  },
  csharp_style_inlined_variable_declaration: { gate: codeStyle('IDE0018'), accepts: isBoolean },
  dotnet_style_readonly_field: { gate: codeStyle('IDE0044'), accepts: isBoolean },
  csharp_prefer_simple_using_statement: { gate: codeStyle('IDE0063'), accepts: isBoolean },
  file_header_template: { gate: { kind: 'diagnostic', diagnosticId: 'IDE0073' } },
  csharp_style_implicit_object_creation_when_type_is_apparent: { gate: codeStyle('IDE0090'), accepts: isBoolean },
  csharp_prefer_simple_default_expression: { gate: codeStyle('IDE0034'), accepts: isBoolean },
  csharp_style_prefer_index_operator: { gate: codeStyle('IDE0056'), accepts: isBoolean },
  csharp_style_prefer_range_operator: { gate: codeStyle('IDE0057'), accepts: isBoolean },
  csharp_style_throw_expression: { gate: codeStyle('IDE0016'), accepts: isBoolean },
  csharp_style_prefer_null_check_over_type_check: { gate: codeStyle('IDE0150'), accepts: isBoolean },
  csharp_style_prefer_tuple_swap: { gate: codeStyle('IDE0180'), accepts: isBoolean },
  csharp_style_prefer_local_over_anonymous_function: { gate: codeStyle('IDE0039'), accepts: isBoolean },
  csharp_style_deconstructed_variable_declaration: { gate: codeStyle('IDE0042'), accepts: isBoolean },
  csharp_style_prefer_utf8_string_literals: { gate: codeStyle('IDE0230'), accepts: isBoolean },
  csharp_prefer_system_threading_lock: { gate: codeStyle('IDE0330'), accepts: isBoolean },
  csharp_style_prefer_implicitly_typed_lambda_expression: { gate: codeStyle('IDE0350'), accepts: isBoolean },
  csharp_style_prefer_unbound_generic_type_in_nameof: { gate: codeStyle('IDE0340'), accepts: isBoolean },
  csharp_style_prefer_primary_constructors: { gate: codeStyle('IDE0290'), accepts: isBoolean },
  dotnet_style_predefined_type_for_locals_parameters_members: { gate: codeStyle('IDE0049'), accepts: oneOf('true') },
  dotnet_style_predefined_type_for_member_access: { gate: codeStyle('IDE0049'), accepts: oneOf('true') },
  dotnet_style_parentheses_in_arithmetic_binary_operators: { gate: parenthesesDiagnostic, accepts: parenthesesValue },
  dotnet_style_parentheses_in_relational_binary_operators: { gate: parenthesesDiagnostic, accepts: parenthesesValue },
  dotnet_style_parentheses_in_other_binary_operators: { gate: parenthesesDiagnostic, accepts: parenthesesValue },
  dotnet_style_parentheses_in_other_operators: { gate: parenthesesDiagnostic, accepts: parenthesesValue },
  dotnet_style_prefer_inferred_tuple_names: { gate: codeStyle('IDE0037'), accepts: isBoolean },
  dotnet_style_prefer_inferred_anonymous_type_member_names: { gate: codeStyle('IDE0037'), accepts: isBoolean },
  dotnet_style_prefer_is_null_check_over_reference_equality_method: { gate: codeStyle('IDE0041'), accepts: isBoolean },
  dotnet_style_prefer_compound_assignment: { gate: codeStyle('IDE0054'), accepts: isBoolean },
  dotnet_style_prefer_simplified_boolean_expressions: { gate: codeStyle('IDE0075'), accepts: isBoolean },
  dotnet_style_coalesce_expression: { gate: codeStyleFamily('IDE0029', 'IDE0030', 'IDE0270'), accepts: isBoolean },
  dotnet_style_null_propagation: { gate: codeStyle('IDE0031'), accepts: isBoolean },
  csharp_style_prefer_pattern_matching: { gate: codeStyle('IDE0078'), accepts: isBoolean },
  csharp_style_prefer_not_pattern: { gate: codeStyle('IDE0083'), accepts: isBoolean },
  csharp_style_conditional_delegate_call: { gate: codeStyle('IDE1005'), accepts: isBoolean },
  csharp_style_prefer_readonly_struct: { gate: codeStyle('IDE0250'), accepts: isBoolean },
  csharp_prefer_static_local_function: { gate: codeStyle('IDE0062'), accepts: isBoolean },
  dotnet_style_prefer_auto_properties: { gate: codeStyle('IDE0032'), accepts: isBoolean },
  csharp_preferred_modifier_order: {
    gate: codeStyle('IDE0036'),
    accepts: (value) => value.split(',').every((modifier) => MODIFIERS.includes(modifier.trim())),
  },
  dotnet_style_namespace_match_folder: { gate: codeStyle('IDE0130'), accepts: isBoolean },
  dotnet_code_quality_unused_parameters: { gate: codeStyle('IDE0060'), accepts: oneOf('all', 'non_public') },
  csharp_style_expression_bodied_methods: { gate: codeStyle('IDE0022'), accepts: expressionBodyValue },
  csharp_style_expression_bodied_constructors: { gate: codeStyle('IDE0021'), accepts: expressionBodyValue },
  csharp_style_expression_bodied_operators: { gate: codeStyle('IDE0023'), accepts: expressionBodyValue },
  csharp_style_expression_bodied_properties: { gate: codeStyle('IDE0025'), accepts: expressionBodyValue },
  csharp_style_expression_bodied_indexers: { gate: codeStyle('IDE0026'), accepts: expressionBodyValue },
  csharp_style_expression_bodied_accessors: { gate: codeStyle('IDE0027'), accepts: expressionBodyValue },
  csharp_style_expression_bodied_local_functions: { gate: codeStyle('IDE0061'), accepts: expressionBodyValue },
  dotnet_style_object_initializer: { gate: codeStyle('IDE0017'), accepts: isBoolean },
  dotnet_style_collection_initializer: { gate: codeStyle('IDE0028'), accepts: isBoolean },
  dotnet_style_prefer_conditional_expression_over_assignment: { gate: codeStyle('IDE0045'), accepts: isBoolean },
  dotnet_style_prefer_conditional_expression_over_return: { gate: codeStyle('IDE0046'), accepts: isBoolean },
  csharp_style_prefer_switch_expression: { gate: codeStyle('IDE0066'), accepts: isBoolean },
  csharp_style_pattern_matching_over_as_with_null_check: { gate: codeStyleFamily('IDE0019', 'IDE0260'), accepts: isBoolean },
  csharp_style_pattern_matching_over_is_with_cast_check: { gate: codeStyle('IDE0020'), accepts: isBoolean },
  dotnet_style_explicit_tuple_names: { gate: codeStyle('IDE0033'), accepts: isBoolean },
  dotnet_style_prefer_simplified_interpolation: { gate: codeStyle('IDE0071'), accepts: isBoolean },
  csharp_style_prefer_extended_property_pattern: { gate: codeStyle('IDE0170'), accepts: isBoolean },
  csharp_style_prefer_method_group_conversion: { gate: codeStyle('IDE0200'), accepts: isBoolean },
  csharp_style_expression_bodied_lambdas: { gate: codeStyle('IDE0053'), accepts: expressionBodyValue },
  csharp_style_prefer_readonly_struct_member: { gate: codeStyle('IDE0251'), accepts: isBoolean },
  dotnet_prefer_system_hash_code: { gate: codeStyle('IDE0070'), accepts: isBoolean },
  csharp_prefer_static_anonymous_function: { gate: codeStyle('IDE0320'), accepts: isBoolean },
  csharp_style_prefer_simple_property_accessors: { gate: codeStyle('IDE0360'), accepts: isBoolean },
  csharp_style_prefer_top_level_statements: { gate: codeStyleBy('true', 'IDE0210', 'IDE0211'), accepts: isBoolean },
  dotnet_style_prefer_foreach_explicit_cast_in_source: { gate: codeStyle('IDE0220'), accepts: oneOf('always', 'when_strongly_typed') },
  csharp_style_unused_value_expression_statement_preference: { gate: codeStyle('IDE0058'), accepts: oneOf('discard_variable', 'unused_local_variable') },
  csharp_style_unused_value_assignment_preference: { gate: codeStyle('IDE0059'), accepts: oneOf('discard_variable', 'unused_local_variable') },
  dotnet_remove_unnecessary_suppression_exclusions: { gate: codeStyle('IDE0079') },
  dotnet_style_prefer_collection_expression: {
    gate: codeStyleFamily('IDE0300', 'IDE0301', 'IDE0302', 'IDE0303', 'IDE0304', 'IDE0305', 'IDE0306'),
    accepts: oneOf('true', 'false', 'when_types_exactly_match', 'when_types_loosely_match'),
  },
  dotnet_style_allow_multiple_blank_lines_experimental: { gate: codeStyle('IDE2000'), accepts: isBoolean },
  csharp_style_allow_embedded_statements_on_same_line_experimental: { gate: codeStyle('IDE2001'), accepts: isBoolean },
  csharp_style_allow_blank_lines_between_consecutive_braces_experimental: { gate: codeStyle('IDE2002'), accepts: isBoolean },
  dotnet_style_allow_statement_immediately_after_block_experimental: { gate: codeStyle('IDE2003'), accepts: isBoolean },
  csharp_style_allow_blank_line_after_colon_in_constructor_initializer_experimental: { gate: codeStyle('IDE2004'), accepts: isBoolean },
  csharp_style_allow_blank_line_after_token_in_conditional_expression_experimental: { gate: codeStyle('IDE2005'), accepts: isBoolean },
  csharp_style_allow_blank_line_after_token_in_arrow_expression_clause_experimental: { gate: codeStyle('IDE2006'), accepts: isBoolean },
};

/**
 * The diagnostic of every other known code-style option, so that `dotnet_diagnostic.<ID>.severity`
 * decides whether it is enforced, as in Roslyn. Options with several diagnostics use the main one.
 */
const OTHER_CODE_STYLE_OPTIONS: Record<string, Gate> = {
  dotnet_style_prefer_non_hidden_explicit_cast_in_source: codeStyle('IDE0221'),
};

/** Parts of the naming rule, symbol and style specifications the naming rules read. */
const NAMING_KEY = new RegExp(
  '^dotnet_naming_(?:rule\\.[^.]+\\.(?:symbols|style|severity|priority)' +
    '|symbols\\.[^.]+\\.(?:applicable_kinds|applicable_accessibilities|required_modifiers)' +
    '|style\\.[^.]+\\.(?:capitalization|required_prefix|required_suffix|word_separator))$'
);

/**
 * Third-party analyzer diagnostics cleanup honors (one type per file, file name matches type name),
 * with the analyzer category their bulk severity uses. See `oneTypePerFile.ts`.
 */
export const FILE_ORGANIZATION_DIAGNOSTICS: Readonly<Record<string, string>> = {
  SA1402: 'Maintainability',
  SA1649: 'Documentation',
  MA0048: 'Design',
};

interface SupportedDiagnostic {
  /** Analyzer category, for `dotnet_analyzer_diagnostic.category-<category>.severity`. */
  readonly category: string;
  /** `dotnet_code_quality.*` options the rule reads. */
  readonly options?: readonly string[];
}

/**
 * Rules without a code-style option that cleanup applies (or reports) while
 * `dotnet_diagnostic.<ID>.severity`, else the category or global bulk severity, enforces them.
 */
export const SUPPORTED_DIAGNOSTICS: Readonly<Record<string, SupportedDiagnostic>> = {
  IDE0004: { category: 'Style' },
  IDE0005: { category: 'Style' },
  IDE0051: { category: 'Style' },
  IDE0052: { category: 'Style' },
  IDE0035: { category: 'Style' },
  IDE0050: { category: 'Style' },
  IDE0072: { category: 'Style' },
  IDE0076: { category: 'Style' },
  IDE0077: { category: 'Style' },
  IDE0080: { category: 'Style' },
  IDE0082: { category: 'Style' },
  IDE0100: { category: 'Style' },
  IDE0110: { category: 'Style' },
  IDE0001: { category: 'Style' },
  IDE0002: { category: 'Style' },
  IDE0064: { category: 'Style' },
  IDE0079: { category: 'Style' },
  IDE0120: { category: 'Style' },
  IDE0121: { category: 'Style' },
  IDE0240: { category: 'Style' },
  IDE0241: { category: 'Style' },
  IDE0280: { category: 'Style' },
  IDE0380: { category: 'Style' },
  IDE0390: { category: 'Style' },
  IDE0391: { category: 'Style' },
  ...QUALITY_RULES_METADATA,
};

/**
 * True when `diagnosticId` (one of {@link SUPPORTED_DIAGNOSTICS}) is `suggestion`, `warning` or
 * `error` by an explicit setting. A CA rule's implicit default severity (where the .NET analyzers
 * run) is not enough: cleanup rewrites only what the configuration or the project asks for.
 */
export function isDiagnosticEnforced(props: EditorConfigProperties, diagnosticId: string): boolean {
  const diagnostic = SUPPORTED_DIAGNOSTICS[diagnosticId];

  return diagnostic !== undefined && isEnforced(resolveDiagnosticSeverity(props, diagnosticId, undefined, diagnostic.category, false));
}

/** Diagnostics whose severity cleanup reads: the ones a supported setting is gated on. */
const SUPPORTED_DIAGNOSTIC_IDS = new Set([
  FORMATTING_DIAGNOSTIC_ID,
  NAMING_DIAGNOSTIC_ID,
  ...gateDiagnosticIds(),
  ...Object.keys(FILE_ORGANIZATION_DIAGNOSTICS),
  ...Object.keys(SUPPORTED_DIAGNOSTICS),
]);

/** Bulk severities cleanup honors for the diagnostics above. */
const SUPPORTED_BULK_SEVERITY_KEYS = new Set([
  'dotnet_analyzer_diagnostic.severity',
  ...[...new Set(['Style', ...Object.values(SUPPORTED_DIAGNOSTICS).map((diagnostic) => diagnostic.category)])].map(
    (category) => `dotnet_analyzer_diagnostic.category-${category.toLowerCase()}.severity`
  ),
]);

const CODE_STYLE_PREFIXES = [
  'dotnet_style_',
  'csharp_style_',
  'csharp_prefer_',
  'csharp_preferred_',
  'dotnet_code_quality_unused_parameters',
  'dotnet_remove_unnecessary_suppression_exclusions',
];
const FORMATTING_PREFIXES = ['csharp_new_line_', 'csharp_indent_', 'csharp_space_', 'csharp_preserve_single_line_'];
const FORMATTING_KEYS = ['dotnet_style_operator_placement_when_wrapping'];

function gateDiagnosticIds(): string[] {
  return Object.values(SUPPORTED_SETTINGS).flatMap(({ gate }) =>
    gate.kind === 'diagnostic' ? [gate.diagnosticId] : gate.kind === 'codeStyle' ? gate.diagnosticIds : []
  );
}

/**
 * The lower-cased value of a supported setting when it takes effect for the file: it is set, has a
 * supported value and its gate (IDE0055, the option's diagnostic) is enforced. Such a setting is
 * applied by the `.editorconfig` categories and overrides the Code Janitor setting for the same
 * concern.
 */
export function effectiveEditorConfigValue(props: EditorConfigProperties, key: string): string | undefined {
  const setting = SUPPORTED_SETTINGS[key];
  const raw = props.get(key);
  if (!setting || raw === undefined) {
    return undefined;
  }

  const gate = setting.gate;
  const value = optionValue(gate, raw).toLowerCase();
  if (setting.accepts && !setting.accepts(value)) {
    return undefined;
  }

  return isGateOpen(props, gate, raw) ? value : undefined;
}

/**
 * The diagnostic id(s) behind a rule's option(s), for display: `IDE0090`, or `IDE0007/IDE0008` when
 * the values set select several. `option` may end with `*` for a family of options
 * (`csharp_style_var_*`); a diagnostic id (`CA1822`) is returned as is.
 */
export function diagnosticIdsOfOption(props: EditorConfigProperties, option: string): string {
  if (/^(?:IDE|CA)\d/.test(option)) {
    return option;
  }

  const keys = option.endsWith('*') ? Object.keys(SUPPORTED_SETTINGS).filter((key) => key.startsWith(option.slice(0, -1))) : [option];
  const selected = new Set<string>();
  const possible = new Set<string>();
  for (const key of keys) {
    const gate = SUPPORTED_SETTINGS[key]?.gate;
    if (gate?.kind !== 'codeStyle') {
      continue;
    }

    gate.diagnosticIds.forEach((id) => possible.add(id));
    const raw = props.get(key);
    if (raw !== undefined) {
      selected.add(gate.diagnosticId(splitOptionSeverity(raw).value.toLowerCase()));
    }
  }

  const ids = [...(selected.size > 0 ? selected : possible)].sort();

  return ids.length > 0 ? ids.join('/') : option;
}

/**
 * The one diagnostic Roslyn reports for a code-style option whose value selects between several
 * (`dotnet_style_qualification_for_field = true` reports IDE0009, `false` IDE0003); undefined for
 * an option whose diagnostics all apply, or that is not supported.
 */
export function diagnosticIdSelectedBy(key: string, value: string): string | undefined {
  const gate = SUPPORTED_SETTINGS[key]?.gate;

  return gate?.kind === 'codeStyle' && gate.selective ? gate.diagnosticId(value.toLowerCase()) : undefined;
}

/** The value of a setting as written: code-style options and plain options take a `:severity` suffix. */
function optionValue(gate: Gate, raw: string): string {
  return gate.kind === 'codeStyle' || gate.kind === 'always' ? splitOptionSeverity(raw).value : raw.trim();
}

function isGateOpen(props: EditorConfigProperties, gate: Gate, raw: string): boolean {
  switch (gate.kind) {
    case 'always': {
      // A plain option (`indent_style = tab:none`) is ignored by a severity that does not enforce it.
      const { severity } = splitOptionSeverity(raw);

      return severity === undefined || isEnforced(severity);
    }
    case 'formatting':
      return isEnforced(resolveDiagnosticSeverity(props, FORMATTING_DIAGNOSTIC_ID));
    case 'diagnostic':
      return isEnforced(resolveDiagnosticSeverity(props, gate.diagnosticId, undefined, undefined, false));
    case 'codeStyle': {
      const { value, severity } = splitOptionSeverity(raw);

      // A `:none` suffix stops the rule whatever severity its diagnostics are given elsewhere.
      return severity !== 'none' && isEnforced(resolveDiagnosticSeverity(props, gate.diagnosticId(value.toLowerCase()), severity));
    }
  }
}

/**
 * One message per setting of the file's `.editorconfig` that cleanup does not apply although it
 * would take effect: unknown settings, supported settings with an unknown value, and rules
 * (code-style options, formatting options, diagnostics) that are enforced but not implemented.
 * Settings for Visual Basic and rules that are not enforced (`none`, `silent`, no severity)
 * require nothing and are not reported.
 */
export function unsupportedEditorConfigSettings(props: EditorConfigProperties): string[] {
  const messages: string[] = [];

  for (const [key, raw] of props.entries) {
    const setting = `"${key} = ${raw}"`;
    const supported = SUPPORTED_SETTINGS[key];

    if (supported) {
      const value = optionValue(supported.gate, raw);
      if (supported.accepts && !supported.accepts(value.trim().toLowerCase()) && isGateOpen(props, supported.gate, raw)) {
        messages.push(`${setting} has an unsupported value and was not applied.`);
      }

      continue;
    }

    if (isRequiredButNotApplied(props, key, raw)) {
      const diagnostic = /^dotnet_diagnostic\.([^.]+)\.severity$/.exec(key)?.[1];
      messages.push(
        diagnostic && !/^(?:IDE|CA)\d+$/i.test(diagnostic)
          ? `${setting} belongs to a third-party analyzer (${diagnostic.toUpperCase()}); cleanup only applies .NET SDK rules, so it was not applied.`
          : `${setting} is not supported and was not applied.`
      );
    }
  }

  return messages;
}

function isRequiredButNotApplied(props: EditorConfigProperties, key: string, raw: string): boolean {
  if (key.startsWith('visual_basic_') || NAMING_KEY.test(key) || SUPPORTED_BULK_SEVERITY_KEYS.has(key)) {
    return false;
  }

  const diagnostic = /^dotnet_diagnostic\.([^.]+)\.severity$/.exec(key);
  if (diagnostic) {
    return !SUPPORTED_DIAGNOSTIC_IDS.has(diagnostic[1].toUpperCase()) && isEnforced(parseSeverity(raw));
  }

  // `dotnet_code_quality.*` options only parameterize a rule; its severity entry is what is reported.
  if (key.startsWith('dotnet_code_quality.')) {
    return false;
  }

  if (/^dotnet_analyzer_diagnostic\./.test(key)) {
    return isEnforced(parseSeverity(raw));
  }

  if (FORMATTING_KEYS.includes(key) || FORMATTING_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    return isEnforced(resolveDiagnosticSeverity(props, FORMATTING_DIAGNOSTIC_ID));
  }

  const knownGate = OTHER_CODE_STYLE_OPTIONS[key];
  if (knownGate) {
    return isGateOpen(props, knownGate, raw);
  }

  if (CODE_STYLE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    // The diagnostic of an unsupported option is unknown: its own severity or a bulk severity decides.
    return isEnforced(resolveDiagnosticSeverity(props, '', splitOptionSeverity(raw).severity));
  }

  return true;
}

/**
 * The lower-cased value of any known code-style option (supported or not) while its diagnostic is
 * enforced. Used to keep Code Janitor settings from violating options cleanup does not apply.
 */
export function enforcedOptionValue(props: EditorConfigProperties, key: string): string | undefined {
  const gate = SUPPORTED_SETTINGS[key]?.gate ?? OTHER_CODE_STYLE_OPTIONS[key];
  const raw = props.get(key);
  if (!gate || raw === undefined || !isGateOpen(props, gate, raw)) {
    return undefined;
  }

  return optionValue(gate, raw).toLowerCase();
}

/**
 * What cleanup applies, for tools that write `.editorconfig` files (`scripts/generate-editorconfig.ts`):
 * the setting keys it implements and the diagnostics whose severity it honors.
 */
export function editorConfigCatalog(): { readonly settings: readonly string[]; readonly diagnostics: ReadonlySet<string> } {
  return { settings: Object.keys(SUPPORTED_SETTINGS), diagnostics: SUPPORTED_DIAGNOSTIC_IDS };
}

const SEVERITY_ORDER: Readonly<Record<EditorConfigSeverity, number>> = { none: 0, silent: 1, suggestion: 2, warning: 3, error: 4 };

/**
 * The effective severity of a diagnostic id as cleanup reports it (`IDE0090`, or `IDE0007/IDE0008`
 * for a rule of several ids: the highest): the `:severity` of a code-style option whose value
 * selects the id, then the diagnostic's `dotnet_diagnostic`, bulk and analysis severities.
 */
export function diagnosticSeverity(props: EditorConfigProperties, diagnosticId: string): EditorConfigSeverity | undefined {
  let highest: EditorConfigSeverity | undefined;
  for (const id of diagnosticId.split('/')) {
    let optionSeverity: EditorConfigSeverity | undefined;
    let stopped = false;
    for (const [key, { gate }] of Object.entries(SUPPORTED_SETTINGS)) {
      const raw = gate.kind === 'codeStyle' && gate.diagnosticIds.includes(id) ? props.get(key) : undefined;
      if (raw === undefined || gate.kind !== 'codeStyle') {
        continue;
      }

      const { value, severity } = splitOptionSeverity(raw);
      if (severity && gate.diagnosticId(value.toLowerCase()) === id) {
        optionSeverity = severity;
        // A `:none` suffix stops the rule whatever severity its diagnostic gets elsewhere.
        stopped ||= severity === 'none';
      }
    }

    const severity = stopped ? 'none' : resolveDiagnosticSeverity(props, id, optionSeverity, SUPPORTED_DIAGNOSTICS[id]?.category);
    if (severity && (!highest || SEVERITY_ORDER[severity] > SEVERITY_ORDER[highest])) {
      highest = severity;
    }
  }

  return highest;
}
