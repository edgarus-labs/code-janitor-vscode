import { EditorConfigProperties, isEnforced, parseSeverity, resolveDiagnosticSeverity, splitOptionSeverity } from './editorconfig';
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
const codeStyle = (diagnosticId: string): Gate => ({ kind: 'codeStyle', diagnosticId: () => diagnosticId, diagnosticIds: [diagnosticId] });
/** A code-style option whose value selects one of two diagnostics. */
const codeStyleBy = (value: string, whenValue: string, otherwise: string): Gate => ({
  kind: 'codeStyle',
  diagnosticId: (actual) => (actual === value ? whenValue : otherwise),
  diagnosticIds: [whenValue, otherwise],
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
  dotnet_style_coalesce_expression: { gate: codeStyle('IDE0029'), accepts: isBoolean },
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
};

/**
 * The diagnostic of every other known code-style option, so that `dotnet_diagnostic.<ID>.severity`
 * decides whether it is enforced, as in Roslyn. Options with several diagnostics use the main one.
 */
const OTHER_CODE_STYLE_OPTIONS: Record<string, Gate> = {
  dotnet_style_prefer_collection_expression: codeStyle('IDE0300'),
  dotnet_style_explicit_tuple_names: codeStyle('IDE0033'),
  dotnet_style_prefer_simplified_interpolation: codeStyle('IDE0071'),
  dotnet_style_prefer_foreach_explicit_cast_in_source: codeStyle('IDE0220'),
  dotnet_remove_unnecessary_suppression_exclusions: codeStyle('IDE0079'),
  dotnet_style_allow_multiple_blank_lines_experimental: codeStyle('IDE2000'),
  dotnet_style_allow_statement_immediately_after_block_experimental: codeStyle('IDE2003'),
  csharp_style_expression_bodied_lambdas: codeStyle('IDE0053'),
  csharp_style_pattern_matching_over_is_with_cast_check: codeStyle('IDE0020'),
  csharp_style_pattern_matching_over_as_with_null_check: codeStyle('IDE0019'),
  csharp_style_prefer_switch_expression: codeStyle('IDE0066'),
  csharp_style_prefer_extended_property_pattern: codeStyle('IDE0170'),
  csharp_prefer_static_anonymous_function: codeStyle('IDE0320'),
  csharp_style_prefer_readonly_struct_member: codeStyle('IDE0251'),
  csharp_style_prefer_method_group_conversion: codeStyle('IDE0200'),
  csharp_style_prefer_top_level_statements: codeStyleBy('true', 'IDE0210', 'IDE0211'),
  csharp_style_unused_value_assignment_preference: codeStyle('IDE0059'),
  csharp_style_unused_value_expression_statement_preference: codeStyle('IDE0058'),
  csharp_style_allow_embedded_statements_on_same_line_experimental: codeStyle('IDE2001'),
  csharp_style_allow_blank_lines_between_consecutive_braces_experimental: codeStyle('IDE2002'),
  csharp_style_allow_blank_line_after_colon_in_constructor_initializer_experimental: codeStyle('IDE2004'),
  csharp_style_allow_blank_line_after_token_in_conditional_expression_experimental: codeStyle('IDE2005'),
  csharp_style_allow_blank_line_after_token_in_arrow_expression_clause_experimental: codeStyle('IDE2006'),
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

/** Diagnostics whose severity cleanup reads: the ones a supported setting is gated on. */
const SUPPORTED_DIAGNOSTIC_IDS = new Set([
  FORMATTING_DIAGNOSTIC_ID,
  NAMING_DIAGNOSTIC_ID,
  ...gateDiagnosticIds(),
  ...Object.keys(FILE_ORGANIZATION_DIAGNOSTICS),
]);

/** Bulk severities cleanup honors for the diagnostics above. */
const SUPPORTED_BULK_SEVERITY_KEYS = new Set(['dotnet_analyzer_diagnostic.severity', 'dotnet_analyzer_diagnostic.category-style.severity']);

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
  const value = gate.kind === 'codeStyle' ? splitOptionSeverity(raw).value.toLowerCase() : raw.trim().toLowerCase();
  if (setting.accepts && !setting.accepts(value)) {
    return undefined;
  }

  return isGateOpen(props, gate, raw) ? value : undefined;
}

function isGateOpen(props: EditorConfigProperties, gate: Gate, raw: string): boolean {
  switch (gate.kind) {
    case 'always':
      return true;
    case 'formatting':
      return isEnforced(resolveDiagnosticSeverity(props, FORMATTING_DIAGNOSTIC_ID));
    case 'diagnostic':
      return isEnforced(resolveDiagnosticSeverity(props, gate.diagnosticId));
    case 'codeStyle': {
      const { value, severity } = splitOptionSeverity(raw);

      return isEnforced(resolveDiagnosticSeverity(props, gate.diagnosticId(value.toLowerCase()), severity));
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
      const value = supported.gate.kind === 'codeStyle' ? splitOptionSeverity(raw).value : raw;
      if (supported.accepts && !supported.accepts(value.trim().toLowerCase()) && isGateOpen(props, supported.gate, raw)) {
        messages.push(`${setting} has an unsupported value and was not applied.`);
      }

      continue;
    }

    if (isRequiredButNotApplied(props, key, raw)) {
      messages.push(`${setting} is not supported and was not applied.`);
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

  return gate.kind === 'codeStyle' ? splitOptionSeverity(raw).value.toLowerCase() : raw.trim().toLowerCase();
}
