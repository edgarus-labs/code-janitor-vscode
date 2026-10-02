import { editorConfigCatalog } from '../src/cleanup/editorConfigRegistry';

/**
 * The `.editorconfig` written by `scripts/generate-editorconfig.ts`: every C# code-style,
 * formatting and naming option Microsoft documents, set to its documented default value, with
 * severities taken from Code Janitor's registry so that everything cleanup applies is enforced
 * (`warning`) and the rest stays visible without breaking builds (`suggestion`).
 *
 * Sources (checked against the dotnet/docs repository):
 * - option defaults: the "Default option value" row of each rule page, and the example file of
 *   https://learn.microsoft.com/dotnet/fundamentals/code-analysis/code-style-rule-options
 * - rule list: https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/
 * - naming conventions: https://learn.microsoft.com/dotnet/csharp/fundamentals/coding-style/identifier-names
 */

const STYLE_RULES = 'https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules';
const QUALITY_RULES = 'https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules';

interface Section {
  readonly title: string;
  /** Documentation pages the values come from. */
  readonly sources: readonly string[];
  /** Remarks written after the sources, before the options. */
  readonly notes?: readonly string[];
  readonly options: readonly (readonly [key: string, value: string])[];
}

const rule = (page: string): string => `${STYLE_RULES}/${page}`;

const CORE: Section = {
  title: 'Core EditorConfig options',
  sources: ['https://learn.microsoft.com/dotnet/fundamentals/code-analysis/code-style-rule-options#example-editorconfig-file'],
  options: [
    ['indent_size', '4'],
    ['indent_style', 'space'],
    ['tab_width', '4'],
    ['end_of_line', 'crlf'],
    ['insert_final_newline', 'false'],
  ],
};

const DOTNET_CONVENTIONS: readonly Section[] = [
  {
    title: 'Organize usings',
    sources: [rule('dotnet-formatting-options'), rule('ide0073')],
    options: [
      ['dotnet_separate_import_directive_groups', 'false'],
      ['dotnet_sort_system_directives_first', 'true'],
      ['file_header_template', 'unset'],
    ],
  },
  {
    title: 'this. and Me. preferences (IDE0003, IDE0009)',
    sources: [rule('ide0003-ide0009')],
    options: [
      ['dotnet_style_qualification_for_event', 'false'],
      ['dotnet_style_qualification_for_field', 'false'],
      ['dotnet_style_qualification_for_method', 'false'],
      ['dotnet_style_qualification_for_property', 'false'],
    ],
  },
  {
    title: 'Language keywords vs BCL types preferences (IDE0049)',
    sources: [rule('ide0049')],
    options: [
      ['dotnet_style_predefined_type_for_locals_parameters_members', 'true'],
      ['dotnet_style_predefined_type_for_member_access', 'true'],
    ],
  },
  {
    title: 'Parentheses preferences (IDE0047, IDE0048)',
    sources: [rule('ide0047-ide0048')],
    options: [
      ['dotnet_style_parentheses_in_arithmetic_binary_operators', 'always_for_clarity'],
      ['dotnet_style_parentheses_in_other_binary_operators', 'always_for_clarity'],
      ['dotnet_style_parentheses_in_other_operators', 'never_if_unnecessary'],
      ['dotnet_style_parentheses_in_relational_binary_operators', 'always_for_clarity'],
    ],
  },
  {
    title: 'Modifier preferences (IDE0040)',
    sources: [rule('ide0040')],
    options: [['dotnet_style_require_accessibility_modifiers', 'for_non_interface_members']],
  },
  {
    title: 'Expression-level preferences',
    sources: [rule('ide0029-ide0030-ide0270'), rule('ide0028'), rule('ide0300'), rule('ide0054-ide0074'), rule('ide0070'), rule('language-rules')],
    options: [
      ['dotnet_style_coalesce_expression', 'true'],
      ['dotnet_style_collection_initializer', 'true'],
      ['dotnet_style_explicit_tuple_names', 'true'],
      ['dotnet_style_namespace_match_folder', 'true'],
      ['dotnet_style_null_propagation', 'true'],
      ['dotnet_style_object_initializer', 'true'],
      ['dotnet_style_operator_placement_when_wrapping', 'beginning_of_line'],
      ['dotnet_style_prefer_auto_properties', 'true'],
      ['dotnet_style_prefer_collection_expression', 'when_types_loosely_match'],
      ['dotnet_style_prefer_compound_assignment', 'true'],
      ['dotnet_style_prefer_conditional_expression_over_assignment', 'true'],
      ['dotnet_style_prefer_conditional_expression_over_return', 'true'],
      ['dotnet_style_prefer_foreach_explicit_cast_in_source', 'when_strongly_typed'],
      ['dotnet_style_prefer_inferred_anonymous_type_member_names', 'true'],
      ['dotnet_style_prefer_inferred_tuple_names', 'true'],
      ['dotnet_style_prefer_is_null_check_over_reference_equality_method', 'true'],
      ['dotnet_style_prefer_non_hidden_explicit_cast_in_source', 'true'],
      ['dotnet_style_prefer_simplified_boolean_expressions', 'true'],
      ['dotnet_style_prefer_simplified_interpolation', 'true'],
      ['dotnet_prefer_system_hash_code', 'true'],
    ],
  },
  {
    title: 'Field preferences (IDE0044)',
    sources: [rule('ide0044')],
    options: [['dotnet_style_readonly_field', 'true']],
  },
  {
    title: 'Parameter preferences (IDE0060)',
    sources: [rule('ide0060')],
    options: [['dotnet_code_quality_unused_parameters', 'all']],
  },
  {
    title: 'Suppression preferences (IDE0079)',
    sources: [rule('ide0079')],
    options: [['dotnet_remove_unnecessary_suppression_exclusions', 'none']],
  },
  {
    title: 'New line preferences (experimental, IDE2000, IDE2003)',
    sources: [rule('ide2000'), rule('ide2003')],
    options: [
      ['dotnet_style_allow_multiple_blank_lines_experimental', 'true'],
      ['dotnet_style_allow_statement_immediately_after_block_experimental', 'true'],
    ],
  },
];

const CSHARP_CONVENTIONS: readonly Section[] = [
  {
    title: 'var preferences (IDE0007, IDE0008)',
    sources: [rule('ide0007-ide0008')],
    notes: [
      'csharp_style_var_elsewhere = false cannot be fully enforced without a compiler: cleanup keeps var',
      'wherever the type cannot be known from the syntax and reports it once per file.',
    ],
    options: [
      ['csharp_style_var_elsewhere', 'false'],
      ['csharp_style_var_for_built_in_types', 'false'],
      ['csharp_style_var_when_type_is_apparent', 'false'],
    ],
  },
  {
    title: 'Expression-bodied members (IDE0021-IDE0027, IDE0053, IDE0061)',
    sources: [rule('ide0021'), rule('ide0022'), rule('ide0023-ide0024'), rule('ide0025'), rule('ide0026'), rule('ide0027'), rule('ide0053'), rule('ide0061')],
    options: [
      ['csharp_style_expression_bodied_accessors', 'true'],
      ['csharp_style_expression_bodied_constructors', 'false'],
      ['csharp_style_expression_bodied_indexers', 'true'],
      ['csharp_style_expression_bodied_lambdas', 'true'],
      ['csharp_style_expression_bodied_local_functions', 'false'],
      ['csharp_style_expression_bodied_methods', 'false'],
      ['csharp_style_expression_bodied_operators', 'false'],
      ['csharp_style_expression_bodied_properties', 'true'],
    ],
  },
  {
    title: 'Pattern matching preferences',
    sources: [rule('ide0019'), rule('ide0020-ide0038'), rule('ide0066'), rule('ide0078-ide0260'), rule('ide0083'), rule('ide0170')],
    options: [
      ['csharp_style_pattern_matching_over_as_with_null_check', 'true'],
      ['csharp_style_pattern_matching_over_is_with_cast_check', 'true'],
      ['csharp_style_prefer_extended_property_pattern', 'true'],
      ['csharp_style_prefer_not_pattern', 'true'],
      ['csharp_style_prefer_pattern_matching', 'true'],
      ['csharp_style_prefer_switch_expression', 'true'],
    ],
  },
  {
    title: 'Null-checking preferences (IDE1005)',
    sources: [rule('ide1005')],
    options: [['csharp_style_conditional_delegate_call', 'true']],
  },
  {
    title: 'Modifier preferences',
    sources: [rule('ide0036'), rule('ide0062'), rule('ide0250'), rule('ide0251'), rule('ide0320')],
    options: [
      ['csharp_prefer_static_anonymous_function', 'true'],
      ['csharp_prefer_static_local_function', 'true'],
      [
        'csharp_preferred_modifier_order',
        'public,private,protected,internal,file,static,extern,new,virtual,abstract,sealed,override,readonly,unsafe,required,volatile,async',
      ],
      ['csharp_style_prefer_readonly_struct', 'true'],
      ['csharp_style_prefer_readonly_struct_member', 'true'],
    ],
  },
  {
    title: 'Code-block preferences',
    sources: [rule('ide0011'), rule('ide0063'), rule('ide0160-ide0161'), rule('ide0200'), rule('ide0210'), rule('ide0290'), rule('ide0330'), rule('ide0410')],
    options: [
      ['csharp_prefer_braces', 'true'],
      ['csharp_prefer_simple_using_statement', 'true'],
      ['csharp_prefer_system_threading_lock', 'true'],
      ['csharp_style_namespace_declarations', 'block_scoped'],
      ['csharp_style_prefer_labeled_jump_statements', 'true'],
      ['csharp_style_prefer_method_group_conversion', 'true'],
      ['csharp_style_prefer_primary_constructors', 'true'],
      ['csharp_style_prefer_top_level_statements', 'true'],
    ],
  },
  {
    title: 'Expression-level preferences',
    sources: [
      rule('ide0016'),
      rule('ide0018'),
      rule('ide0034'),
      rule('ide0039'),
      rule('ide0042'),
      rule('ide0056'),
      rule('ide0057'),
      rule('ide0058'),
      rule('ide0059'),
      rule('ide0090'),
      rule('ide0150'),
      rule('ide0180'),
      rule('ide0230'),
      rule('ide0340'),
      rule('ide0350'),
      rule('ide0360'),
    ],
    options: [
      ['csharp_prefer_simple_default_expression', 'true'],
      ['csharp_style_deconstructed_variable_declaration', 'true'],
      ['csharp_style_implicit_object_creation_when_type_is_apparent', 'true'],
      ['csharp_style_inlined_variable_declaration', 'true'],
      ['csharp_style_prefer_implicitly_typed_lambda_expression', 'true'],
      ['csharp_style_prefer_index_operator', 'true'],
      ['csharp_style_prefer_local_over_anonymous_function', 'true'],
      ['csharp_style_prefer_null_check_over_type_check', 'true'],
      ['csharp_style_prefer_range_operator', 'true'],
      ['csharp_style_prefer_simple_property_accessors', 'true'],
      ['csharp_style_prefer_tuple_swap', 'true'],
      ['csharp_style_prefer_unbound_generic_type_in_nameof', 'true'],
      ['csharp_style_prefer_utf8_string_literals', 'true'],
      ['csharp_style_throw_expression', 'true'],
      ['csharp_style_unused_value_assignment_preference', 'discard_variable'],
      ['csharp_style_unused_value_expression_statement_preference', 'discard_variable'],
    ],
  },
  {
    title: "'using' directive preferences (IDE0065)",
    sources: [rule('ide0065')],
    options: [['csharp_using_directive_placement', 'outside_namespace']],
  },
  {
    title: 'New line preferences (experimental, IDE2001, IDE2002, IDE2004-IDE2006)',
    sources: [rule('ide2001'), rule('ide2002'), rule('ide2004'), rule('ide2005'), rule('ide2006')],
    options: [
      ['csharp_style_allow_blank_line_after_colon_in_constructor_initializer_experimental', 'true'],
      ['csharp_style_allow_blank_line_after_token_in_arrow_expression_clause_experimental', 'true'],
      ['csharp_style_allow_blank_line_after_token_in_conditional_expression_experimental', 'true'],
      ['csharp_style_allow_blank_lines_between_consecutive_braces_experimental', 'true'],
      ['csharp_style_allow_embedded_statements_on_same_line_experimental', 'true'],
    ],
  },
];

const FORMATTING: readonly Section[] = [
  {
    title: 'New line preferences',
    sources: [rule('csharp-formatting-options#new-line-options')],
    options: [
      ['csharp_new_line_before_catch', 'true'],
      ['csharp_new_line_before_else', 'true'],
      ['csharp_new_line_before_finally', 'true'],
      ['csharp_new_line_before_members_in_anonymous_types', 'true'],
      ['csharp_new_line_before_members_in_object_initializers', 'true'],
      ['csharp_new_line_before_open_brace', 'all'],
      ['csharp_new_line_between_query_expression_clauses', 'true'],
    ],
  },
  {
    title: 'Indentation preferences',
    sources: [rule('csharp-formatting-options#indentation-options')],
    options: [
      ['csharp_indent_block_contents', 'true'],
      ['csharp_indent_braces', 'false'],
      ['csharp_indent_case_contents', 'true'],
      ['csharp_indent_case_contents_when_block', 'true'],
      ['csharp_indent_labels', 'one_less_than_current'],
      ['csharp_indent_switch_labels', 'true'],
    ],
  },
  {
    title: 'Space preferences',
    sources: [rule('csharp-formatting-options#spacing-options')],
    options: [
      ['csharp_space_after_cast', 'false'],
      ['csharp_space_after_colon_in_inheritance_clause', 'true'],
      ['csharp_space_after_comma', 'true'],
      ['csharp_space_after_dot', 'false'],
      ['csharp_space_after_keywords_in_control_flow_statements', 'true'],
      ['csharp_space_after_semicolon_in_for_statement', 'true'],
      ['csharp_space_around_binary_operators', 'before_and_after'],
      ['csharp_space_around_declaration_statements', 'false'],
      ['csharp_space_before_colon_in_inheritance_clause', 'true'],
      ['csharp_space_before_comma', 'false'],
      ['csharp_space_before_dot', 'false'],
      ['csharp_space_before_open_square_brackets', 'false'],
      ['csharp_space_before_semicolon_in_for_statement', 'false'],
      ['csharp_space_between_empty_square_brackets', 'false'],
      ['csharp_space_between_method_call_empty_parameter_list_parentheses', 'false'],
      ['csharp_space_between_method_call_name_and_opening_parenthesis', 'false'],
      ['csharp_space_between_method_call_parameter_list_parentheses', 'false'],
      ['csharp_space_between_method_declaration_empty_parameter_list_parentheses', 'false'],
      ['csharp_space_between_method_declaration_name_and_open_parenthesis', 'false'],
      ['csharp_space_between_method_declaration_parameter_list_parentheses', 'false'],
      ['csharp_space_between_parentheses', 'false'],
      ['csharp_space_between_square_brackets', 'false'],
    ],
  },
  {
    title: 'Wrapping preferences',
    sources: [rule('csharp-formatting-options#wrap-options')],
    options: [
      ['csharp_preserve_single_line_blocks', 'true'],
      ['csharp_preserve_single_line_statements', 'true'],
    ],
  },
];

/** One naming rule: the symbols it covers and the style they must follow. */
interface NamingConvention {
  readonly name: string;
  /** Why, quoted or paraphrased from the identifier-names page. */
  readonly doc: string;
  readonly kinds: string;
  readonly accessibilities?: string;
  readonly modifiers?: string;
  readonly prefix?: string;
  readonly capitalization: 'pascal_case' | 'camel_case';
}

/**
 * The C# identifier conventions documented at
 * https://learn.microsoft.com/dotnet/csharp/fundamentals/coding-style/identifier-names (the
 * .NET runtime team's style). Roslyn orders naming rules by specificity, so the more specific
 * rules (constants, static fields) win over the general ones.
 */
const NAMING: readonly NamingConvention[] = [
  { name: 'interfaces', doc: 'Interface names start with a capital I.', kinds: 'interface', prefix: 'I', capitalization: 'pascal_case' },
  { name: 'type_parameters', doc: 'Prefix descriptive type parameter names with T.', kinds: 'type_parameter', prefix: 'T', capitalization: 'pascal_case' },
  {
    name: 'types',
    doc: 'Use PascalCase for class, struct, enum and delegate names.',
    kinds: 'class, struct, enum, delegate',
    capitalization: 'pascal_case',
  },
  { name: 'namespaces', doc: 'Namespaces use PascalCase.', kinds: 'namespace', capitalization: 'pascal_case' },
  {
    name: 'constants',
    doc: 'Use PascalCase for constant names, both fields and local constants, including private and internal ones.',
    kinds: 'field, local',
    modifiers: 'const',
    capitalization: 'pascal_case',
  },
  {
    name: 'private_static_fields',
    doc: 'Private and internal static fields start with s_.',
    kinds: 'field',
    accessibilities: 'private, internal, private_protected',
    modifiers: 'static',
    prefix: 's_',
    capitalization: 'camel_case',
  },
  {
    name: 'private_fields',
    doc: 'Private and internal non-constant instance fields are camelCase and start with an underscore.',
    kinds: 'field',
    accessibilities: 'private, internal, private_protected',
    prefix: '_',
    capitalization: 'camel_case',
  },
  {
    name: 'public_fields',
    doc: 'Public members of types, such as fields, use PascalCase.',
    kinds: 'field',
    accessibilities: 'public, protected, protected_internal',
    capitalization: 'pascal_case',
  },
  {
    name: 'members',
    doc: 'Use PascalCase for methods, local functions, properties and events.',
    kinds: 'method, local_function, property, event',
    capitalization: 'pascal_case',
  },
  { name: 'parameters', doc: 'Use camelCase for method arguments.', kinds: 'parameter', capitalization: 'camel_case' },
  { name: 'locals', doc: 'Use camelCase for local variables.', kinds: 'local', capitalization: 'camel_case' },
];

/**
 * The C# rules of the style-rule list, in documentation order. Visual Basic-only rules (IDE0081,
 * IDE0084, IDE0140), IDE1007 (a compiler error surfaced as a rule) and IDE3000 (Copilot) are left
 * out: none has a code-style fix.
 */
const STYLE_RULE_IDS = [
  'IDE0001', 'IDE0002', 'IDE0003', 'IDE0004', 'IDE0005', 'IDE0007', 'IDE0008', 'IDE0009', 'IDE0010', 'IDE0011',
  'IDE0016', 'IDE0017', 'IDE0018', 'IDE0019', 'IDE0020', 'IDE0021', 'IDE0022', 'IDE0023', 'IDE0024', 'IDE0025',
  'IDE0026', 'IDE0027', 'IDE0028', 'IDE0029', 'IDE0030', 'IDE0031', 'IDE0032', 'IDE0033', 'IDE0034', 'IDE0035',
  'IDE0036', 'IDE0037', 'IDE0038', 'IDE0039', 'IDE0040', 'IDE0041', 'IDE0042', 'IDE0043', 'IDE0044', 'IDE0045',
  'IDE0046', 'IDE0047', 'IDE0048', 'IDE0049', 'IDE0050', 'IDE0051', 'IDE0052', 'IDE0053', 'IDE0054', 'IDE0055',
  'IDE0056', 'IDE0057', 'IDE0058', 'IDE0059', 'IDE0060', 'IDE0061', 'IDE0062', 'IDE0063', 'IDE0064', 'IDE0065',
  'IDE0066', 'IDE0070', 'IDE0071', 'IDE0072', 'IDE0073', 'IDE0074', 'IDE0075', 'IDE0076', 'IDE0077', 'IDE0078',
  'IDE0079', 'IDE0080', 'IDE0082', 'IDE0083', 'IDE0090', 'IDE0100', 'IDE0110', 'IDE0120', 'IDE0121', 'IDE0130',
  'IDE0150', 'IDE0160', 'IDE0161', 'IDE0170', 'IDE0180', 'IDE0200', 'IDE0210', 'IDE0211', 'IDE0220', 'IDE0221',
  'IDE0230', 'IDE0240', 'IDE0241', 'IDE0250', 'IDE0251', 'IDE0260', 'IDE0270', 'IDE0280', 'IDE0290', 'IDE0300',
  'IDE0301', 'IDE0302', 'IDE0303', 'IDE0304', 'IDE0305', 'IDE0306', 'IDE0320', 'IDE0330', 'IDE0340', 'IDE0350',
  'IDE0360', 'IDE0370', 'IDE0380', 'IDE0390', 'IDE0391', 'IDE0410', 'IDE1005', 'IDE1006', 'IDE2000', 'IDE2001',
  'IDE2002', 'IDE2003', 'IDE2004', 'IDE2005', 'IDE2006',
];

/** Options of code-quality rules cleanup applies, with the documented reason for the value. */
const QUALITY_RULE_OPTIONS: Readonly<Record<string, readonly (readonly [key: string, value: string, why: string])[]>> = {
  CA1822: [
    [
      'dotnet_code_quality.CA1822.api_surface',
      'private, internal',
      'Making a member visible outside the assembly static is a breaking change (CA1822 page, "Fix is breaking or non-breaking"); the page documents this value to analyze only the non-public API surface.',
    ],
  ],
  CA1852: [
    [
      'dotnet_code_quality.CA1852.ignore_internalsvisibleto',
      'false',
      'Documented default: types of an assembly with InternalsVisibleTo are not sealed, a friend assembly may derive from them.',
    ],
  ],
};

/**
 * Third-party rules cleanup applies. MA0048 (Meziantou) is left out: SA1402 + SA1649 already
 * cover one type per file, named after the type.
 */
const ONE_TYPE_PER_FILE: readonly (readonly [id: string, url: string])[] = [
  ['SA1402', 'https://github.com/DotNetAnalyzers/StyleCopAnalyzers/blob/master/documentation/SA1402.md'],
  ['SA1649', 'https://github.com/DotNetAnalyzers/StyleCopAnalyzers/blob/master/documentation/SA1649.md'],
];

function renderSection(section: Section): string[] {
  return [
    `# ${section.title}`,
    ...section.sources.map((source) => `# ${source}`),
    ...(section.notes ?? []).map((note) => `# ${note}`),
    ...section.options.map(([key, value]) => `${key} = ${value}`),
    '',
  ];
}

function renderNaming(): string[] {
  const lines = [
    '#### Naming conventions (IDE1006) ####',
    '# https://learn.microsoft.com/dotnet/csharp/fundamentals/coding-style/identifier-names',
    `# ${STYLE_RULES}/naming-rules`,
    '# Thread-static fields (t_ prefix) cannot be told apart from other static fields by naming rules.',
    '',
  ];
  for (const convention of NAMING) {
    lines.push(
      `# ${convention.doc}`,
      `dotnet_naming_rule.${convention.name}.symbols = ${convention.name}`,
      `dotnet_naming_rule.${convention.name}.style = ${convention.name}_style`,
      `dotnet_naming_rule.${convention.name}.severity = warning`,
      `dotnet_naming_symbols.${convention.name}.applicable_kinds = ${convention.kinds}`,
      `dotnet_naming_symbols.${convention.name}.applicable_accessibilities = ${convention.accessibilities ?? '*'}`
    );
    if (convention.modifiers) {
      lines.push(`dotnet_naming_symbols.${convention.name}.required_modifiers = ${convention.modifiers}`);
    }

    if (convention.prefix) {
      lines.push(`dotnet_naming_style.${convention.name}_style.required_prefix = ${convention.prefix}`);
    }

    lines.push(`dotnet_naming_style.${convention.name}_style.capitalization = ${convention.capitalization}`, '');
  }

  return lines;
}

function renderSeverities(diagnostics: ReadonlySet<string>): string[] {
  const applied = STYLE_RULE_IDS.filter((id) => diagnostics.has(id));
  const reported = STYLE_RULE_IDS.filter((id) => !diagnostics.has(id));

  return [
    '#### Code-style rule severities ####',
    `# ${STYLE_RULES}/`,
    '# Rule-ID severities are respected at build time on every SDK, unlike the option:severity suffix',
    '# (see "Option format" on the language-rules page).',
    '',
    '# Applied by Code Janitor cleanup: enforced as warnings.',
    ...applied.map((id) => `dotnet_diagnostic.${id}.severity = warning`),
    '',
    '# Not applied by Code Janitor cleanup (listed in its output channel): suggestions, so Visual Studio',
    '# and dotnet format still offer the fix without failing builds.',
    ...reported.map((id) => `dotnet_diagnostic.${id}.severity = suggestion`),
    '',
  ];
}

function renderQualityRules(diagnostics: ReadonlySet<string>): string[] {
  const lines = [
    '#### Code-quality rules applied by Code Janitor cleanup ####',
    `# ${QUALITY_RULES}/`,
    '# Other CA rules keep the SDK defaults (see <AnalysisMode> in the project file).',
    '',
  ];
  for (const id of [...diagnostics].filter((candidate) => candidate.startsWith('CA')).sort()) {
    lines.push(`# ${QUALITY_RULES}/${id.toLowerCase()}`);
    for (const [key, value, why] of QUALITY_RULE_OPTIONS[id] ?? []) {
      lines.push(`# ${why}`, `${key} = ${value}`);
    }

    lines.push(`dotnet_diagnostic.${id}.severity = warning`, '');
  }

  return lines;
}

function renderOneTypePerFile(): string[] {
  return [
    '#### One type per file (StyleCop.Analyzers) ####',
    ...ONE_TYPE_PER_FILE.flatMap(([id, url]) => [`# ${url}`, `dotnet_diagnostic.${id}.severity = warning`]),
    '',
  ];
}

/** The generated `.editorconfig` text. */
export function renderEditorConfig(): string {
  const { diagnostics } = editorConfigCatalog();
  const lines = [
    '# Generated by scripts/generate-editorconfig.ts from the Microsoft .NET code analysis documentation.',
    '# Every value is the documented default; severities come from Code Janitor: what cleanup applies is',
    '# a warning, the other documented style rules are suggestions.',
    `# ${STYLE_RULES}/`,
    'root = true',
    '',
    '[*.cs]',
    '',
    `#### ${CORE.title} ####`,
    ...renderSection({ ...CORE, title: 'Indentation, spacing and new lines' }),
    '#### .NET coding conventions ####',
    '',
    ...DOTNET_CONVENTIONS.flatMap(renderSection),
    '#### C# coding conventions ####',
    '',
    ...CSHARP_CONVENTIONS.flatMap(renderSection),
    '#### C# formatting rules (IDE0055) ####',
    `# ${STYLE_RULES}/ide0055`,
    '',
    ...FORMATTING.flatMap(renderSection),
    ...renderNaming(),
    ...renderSeverities(diagnostics),
    ...renderQualityRules(diagnostics),
    ...renderOneTypePerFile(),
  ];

  return `${lines.join('\n').trimEnd()}\n`;
}
