import { EditorConfigProperties, isEnforced, parseSeverity, resolveDiagnosticSeverity, splitOptionSeverity } from './editorconfig';
import { positiveInt, readCodeStyleOption } from './transformations/editorConfigSupport';

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
};

/** Parts of the naming rule, symbol and style specifications the naming rules read. */
const NAMING_KEY = new RegExp(
  '^dotnet_naming_(?:rule\\.[^.]+\\.(?:symbols|style|severity|priority)' +
    '|symbols\\.[^.]+\\.(?:applicable_kinds|applicable_accessibilities|required_modifiers)' +
    '|style\\.[^.]+\\.(?:capitalization|required_prefix|required_suffix|word_separator))$'
);

/** Diagnostics whose severity cleanup reads: the ones a supported setting is gated on. */
const SUPPORTED_DIAGNOSTIC_IDS = new Set([FORMATTING_DIAGNOSTIC_ID, NAMING_DIAGNOSTIC_ID, ...gateDiagnosticIds()]);

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

  if (CODE_STYLE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    // The diagnostic of an unsupported option is unknown: its own severity or a bulk severity decides.
    return isEnforced(resolveDiagnosticSeverity(props, '', splitOptionSeverity(raw).severity));
  }

  return true;
}

/** An unsupported code-style option's value when it is enforced (used to keep settings from violating it). */
export function enforcedCodeStyleValue(props: EditorConfigProperties, key: string, diagnosticId: string): string | undefined {
  const option = readCodeStyleOption(props, key, diagnosticId);

  return option?.enforced ? option.value : undefined;
}
