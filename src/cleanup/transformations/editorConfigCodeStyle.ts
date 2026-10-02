import { STRING, classifyCSharp } from '../csharpScanner';
import { EditorConfigProperties, isEnforced, resolveDiagnosticSeverity } from '../editorconfig';
import { Node, TextEdit, applyEdits, findAll, parseCSharp, walk } from '../parser';
import { diagnosticIdsOfOption, effectiveEditorConfigValue, isDiagnosticEnforced } from '../editorConfigRegistry';
import { countChangedRegions } from '../lineDiff';
import { ProjectInfo } from '../projectInfo';
import { RuleChange, SourceTransformation } from '../types';
import { BLANK_LINE_RULES } from './editorConfigBlankLineRules';
import { COLLECTION_EXPRESSION_RULES } from './editorConfigCollectionExpressions';
import { applyBracePreference } from './editorConfigBraces';
import { applyQualificationPreferences } from './editorConfigQualification';
import {
  EditorConfigIssueReporter,
  containsMultiLineString,
  describeIssue,
  hasParseErrors,
  indentUnit,
  isBlank,
  isRecoveredNode,
  lineEndAt,
  lineIndentAt,
  lineStartAt,
  newlineOf,
  parseErrorCount,
  readCodeStyleOption,
} from './editorConfigSupport';
import { EXPRESSION_PREFERENCES, applyExpressionPreference } from './editorConfigExpressionPreferences';
import { EXPRESSION_BODY_RULES } from './editorConfigExpressionBodies';
import { LANGUAGE_RULES } from './editorConfigLanguageRules';
import { MEMBER_RULES } from './editorConfigMemberPreferences';
import { OPERATOR_RULES } from './editorConfigOperatorPreferences';
import { SIMPLIFICATION_RULES } from './editorConfigSimplificationRules';
import { QUALITY_RULES } from './editorConfigQualityRules';
import { STATEMENT_PREFERENCES, applyStatementPreference } from './editorConfigStatementPreferences';
import { applySystemThreadingLock, reportPrimaryConstructors } from './editorConfigTypePreferences';
import { applyVarPreferences } from './editorConfigVarPreference';
import { createExplicitAccessModifierConverter } from './explicitAccessModifier';
import { convertToBlockScoped, convertToFileScoped, fileScopedNamespacesUnsupported } from './namespaceScope';
import { inlineOutVariableDeclarations } from './outVarInlining';
import { readonlyFieldConverter } from './readonlyFieldAndSingleLineMethods';

export interface EditorConfigCodeStyleOptions {
  /** File name used for `{fileName}` in `file_header_template`. */
  readonly fileName?: string;
  /** Full path of the file, for rules that compare it with its project folder. */
  readonly filePath?: string;
  /** The file's project, when known (see `projectInfo.ts`). */
  readonly project?: ProjectInfo;
}

export interface RuleContext {
  readonly props: EditorConfigProperties;
  readonly report: EditorConfigIssueReporter;
  /** One indentation level for code the rules create or re-indent. */
  readonly indent: string;
  readonly fileName?: string;
  readonly filePath?: string;
  readonly project?: ProjectInfo;
}

export interface Rule {
  /** The option(s) the rule applies, for reports. */
  readonly option: string;
  readonly apply: (source: string, context: RuleContext) => string;
}

/** Rule passes over a file: one rule's rewrite can make another one's apply (`if`/`return` chains). */
const MAX_PASSES = 3;

/**
 * Applies the C# code-style preferences of `.editorconfig` whose diagnostic is enforced
 * (`suggestion`, `warning` or `error`). Each rule rewrites code only when the result is certain
 * from syntax alone and reports every violation it leaves in place. The rules run again while a
 * pass changes the code, and only the last pass reports, so reports describe the final code.
 */
export function createEditorConfigCodeStyleConverter(
  props: EditorConfigProperties,
  report: EditorConfigIssueReporter,
  options: EditorConfigCodeStyleOptions = {}
): SourceTransformation {
  const run = (source: string, tracking?: RuleTracking): string => {
    if (!source || !source.trim()) {
      return source;
    }

    // A byte order mark would confuse the parser; the rules work on the text after it.
    const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
    let current = source.slice(bom.length);
    let issues: string[] = [];

    for (let pass = 0; pass < MAX_PASSES; pass++) {
      issues = [];
      const context: RuleContext = {
        props,
        report: (issue) => issues.push(issue),
        indent: indentUnit(props, current),
        fileName: options.fileName,
        filePath: options.filePath,
        project: options.project,
      };
      const updated = applyRules(current, context, tracking);
      if (updated === current) {
        break;
      }

      current = updated;
    }

    for (const issue of issues) {
      report(issue);
    }

    return bom + current;
  };

  return {
    name: 'Apply .editorconfig code style',
    apply: (source) => run(source),
    applyRules(source, excludedRules) {
      const tracking: RuleTracking = { excluded: excludedRules, changes: new Map() };
      const output = run(source, tracking);
      const rules: RuleChange[] = [...tracking.changes].map(([id, changes]) => ({ id, changes, included: !excludedRules.has(id) }));

      return { output, rules };
    },
  };
}

/** For a preview: the rules left out, and the places each rule id changed (in rule order). */
interface RuleTracking {
  readonly excluded: ReadonlySet<string>;
  readonly changes: Map<string, number>;
}

interface LanguageRequirement {
  /** Lowest C# version with the syntax the rule writes. */
  readonly version: number;
  /** True when the syntax needs .NET Core 3.0+ types (`System.Index`, `System.Range`, `Span<T>`). */
  readonly modernRuntime?: boolean;
}

/**
 * What the rewrite of each option needs from the project
 * (https://learn.microsoft.com/dotnet/csharp/whats-new/csharp-version-history). Options missing
 * here write syntax every C# version has.
 */
const LANGUAGE_REQUIREMENTS: Record<string, LanguageRequirement> = {
  csharp_style_implicit_object_creation_when_type_is_apparent: { version: 9 },
  csharp_prefer_simple_default_expression: { version: 7.1 },
  csharp_style_prefer_index_operator: { version: 8, modernRuntime: true },
  csharp_style_prefer_range_operator: { version: 8, modernRuntime: true },
  csharp_style_throw_expression: { version: 7 },
  csharp_style_prefer_null_check_over_type_check: { version: 9 },
  csharp_style_prefer_tuple_swap: { version: 7 },
  csharp_style_prefer_local_over_anonymous_function: { version: 7 },
  csharp_style_deconstructed_variable_declaration: { version: 7 },
  csharp_style_prefer_utf8_string_literals: { version: 11, modernRuntime: true },
  csharp_prefer_system_threading_lock: { version: 13 },
  csharp_style_prefer_unbound_generic_type_in_nameof: { version: 14 },
  csharp_prefer_simple_using_statement: { version: 8 },
  csharp_style_inlined_variable_declaration: { version: 7 },
  csharp_style_prefer_not_pattern: { version: 9 },
  csharp_style_prefer_pattern_matching: { version: 9 },
  dotnet_style_prefer_is_null_check_over_reference_equality_method: { version: 9 },
  dotnet_style_null_propagation: { version: 6 },
  csharp_style_conditional_delegate_call: { version: 6 },
  dotnet_style_prefer_compound_assignment: { version: 8 },
  dotnet_style_prefer_inferred_tuple_names: { version: 7.1 },
  csharp_style_prefer_switch_expression: { version: 9 },
  csharp_style_pattern_matching_over_as_with_null_check: { version: 7 },
  csharp_style_pattern_matching_over_is_with_cast_check: { version: 7 },
  dotnet_style_explicit_tuple_names: { version: 7 },
  csharp_style_prefer_extended_property_pattern: { version: 10 },
  dotnet_style_prefer_simplified_interpolation: { version: 6 },
  csharp_style_prefer_readonly_struct: { version: 7.2 },
  csharp_style_prefer_readonly_struct_member: { version: 8 },
  csharp_prefer_static_local_function: { version: 8 },
  dotnet_style_prefer_auto_properties: { version: 6 },
  csharp_style_expression_bodied_methods: { version: 6 },
  csharp_style_expression_bodied_operators: { version: 6 },
  csharp_style_expression_bodied_properties: { version: 6 },
  csharp_style_expression_bodied_indexers: { version: 6 },
  csharp_style_expression_bodied_constructors: { version: 7 },
  csharp_style_expression_bodied_accessors: { version: 7 },
  csharp_style_expression_bodied_local_functions: { version: 7 },
  dotnet_style_prefer_collection_expression: { version: 12 },
  csharp_prefer_static_anonymous_function: { version: 9 },
  csharp_style_prefer_simple_property_accessors: { version: 14 },
  IDE0082: { version: 6 },
  IDE0280: { version: 11 },
  IDE0110: { version: 9 },
};

/** The requirement of `rule` for the option's current value (file-scoped namespaces need C# 10). */
function requirementOf(rule: Rule, props: EditorConfigProperties): LanguageRequirement | undefined {
  if (rule.option === 'csharp_style_namespace_declarations') {
    return effectiveEditorConfigValue(props, rule.option) === 'file_scoped' ? { version: 10 } : undefined;
  }

  return LANGUAGE_REQUIREMENTS[rule.option];
}

/** Why the project cannot take the rule's syntax, or `undefined` when it can (or is unknown). */
function unsupportedByProject(rule: Rule, context: RuleContext): string | undefined {
  const requirement = requirementOf(rule, context.props);
  const project = context.project;
  // A rule keyed by its diagnostic (no option) applies while the diagnostic is enforced.
  const applies = /^(?:IDE|CA)\d{4}$/.test(rule.option)
    ? isDiagnosticEnforced(context.props, rule.option)
    : effectiveEditorConfigValue(context.props, rule.option) !== undefined;
  // File-scoped namespaces are only written when the language version is known to be C# 10 or newer.
  if (rule.option === NAMESPACE_OPTION && applies && requirement) {
    return fileScopedNamespacesUnsupported(project);
  }

  if (!requirement || !project || !applies) {
    return undefined;
  }

  if (project.languageVersion !== undefined && project.languageVersion < requirement.version) {
    return `the project uses C# ${project.languageVersion} and the rewrite needs C# ${requirement.version}`;
  }

  return requirement.modernRuntime && project.modernRuntime === false ? 'the project targets a runtime without the types the rewrite needs' : undefined;
}

function applyRules(source: string, context: RuleContext, tracking?: RuleTracking): string {
  let current = source;
  let errors: number | undefined;

  for (const rule of RULES) {
    const unsupported = unsupportedByProject(rule, context);
    if (unsupported) {
      context.report(`${rule.option}: not applied, ${unsupported}.`);
      continue;
    }

    const id = tracking ? diagnosticIdsOfOption(context.props, rule.option) : undefined;
    if (id !== undefined && tracking!.excluded.has(id)) {
      tracking!.changes.set(id, 0);
      continue;
    }

    const updated = rule.apply(current, context);
    if (updated === current) {
      continue;
    }

    // Every rule edits code it parsed; a result the parser reads worse than the input is dropped.
    errors ??= parseErrorCount(current);
    const updatedErrors = parseErrorCount(updated);
    if (updatedErrors > errors) {
      context.report(`${rule.option}: changes discarded, the rewritten code could not be verified.`);
      continue;
    }

    if (id !== undefined) {
      tracking!.changes.set(id, (tracking!.changes.get(id) ?? 0) + countChangedRegions(current, updated));
    }

    current = updated;
    errors = updatedErrors;
  }

  return current;
}

const RULES: readonly Rule[] = [
  { option: 'csharp_style_namespace_declarations', apply: applyNamespaceDeclarationPreference },
  { option: 'file_header_template', apply: applyFileHeaderTemplate },
  { option: 'dotnet_style_require_accessibility_modifiers', apply: applyAccessibilityModifierPreference },
  {
    option: 'dotnet_style_readonly_field',
    apply: (source, { props }) =>
      isPreferred(props, 'dotnet_style_readonly_field', 'IDE0044') ? readonlyFieldConverter.apply(source) : source,
  },
  {
    option: 'dotnet_style_qualification_for_*',
    apply: (source, { props, report }) => applyQualificationPreferences(source, props, report),
  },
  { option: 'csharp_style_var_*', apply: (source, { props, report }) => applyVarPreferences(source, props, report) },
  {
    option: 'csharp_style_inlined_variable_declaration',
    apply: (source, { props }) =>
      isPreferred(props, 'csharp_style_inlined_variable_declaration', 'IDE0018')
        ? inlineOutVariableDeclarations(source, { preserveScope: true, keepDeclaredType: true })
        : source,
  },
  { option: 'csharp_prefer_simple_using_statement', apply: applySimpleUsingStatementPreference },
  ...STATEMENT_PREFERENCES.map(
    (rule): Rule => ({ option: rule.option, apply: (source, { props, indent }) => applyStatementPreference(rule, source, props, indent) })
  ),
  ...EXPRESSION_PREFERENCES.map(
    (rule): Rule => ({
      option: rule.option,
      apply: (source, { props, report }) => applyExpressionPreference(rule, source, props, report),
    })
  ),
  {
    option: 'csharp_prefer_system_threading_lock',
    apply: (source, { props, report, project }) => applySystemThreadingLock(source, props, report, project?.targetFrameworks),
  },
  {
    option: 'csharp_style_prefer_primary_constructors',
    apply: (source, { props, report }) => reportPrimaryConstructors(source, props, report),
  },
  ...OPERATOR_RULES,
  ...SIMPLIFICATION_RULES,
  ...COLLECTION_EXPRESSION_RULES,
  ...LANGUAGE_RULES,
  // Before the member preferences, so that IDE0036 orders the modifiers CA1822/CA1852 add.
  ...QUALITY_RULES,
  ...MEMBER_RULES,
  ...EXPRESSION_BODY_RULES,
  {
    option: 'csharp_prefer_braces',
    apply: (source, { props, report, indent }) => applyBracePreference(source, props, report, indent),
  },
  // Last: they only move whitespace, around the code the other rules wrote.
  ...BLANK_LINE_RULES,
];

/** True when a boolean option is set to `true` and its diagnostic is enforced. */
function isPreferred(props: EditorConfigProperties, option: string, diagnosticId: string): boolean {
  const value = readCodeStyleOption(props, option, diagnosticId);

  return value?.enforced === true && value.value === 'true';
}

// ---------------------------------------------------------------------------------------------
// csharp_style_namespace_declarations (IDE0160 / IDE0161)
// ---------------------------------------------------------------------------------------------

const NAMESPACE_OPTION = 'csharp_style_namespace_declarations';

function applyNamespaceDeclarationPreference(source: string, context: RuleContext): string {
  const option = readCodeStyleOption(context.props, NAMESPACE_OPTION, (value) => (value === 'block_scoped' ? 'IDE0160' : 'IDE0161'));
  if (!option?.enforced || (option.value !== 'file_scoped' && option.value !== 'block_scoped')) {
    return source;
  }

  const id = option.value === 'block_scoped' ? 'IDE0160' : 'IDE0161';
  const report = (reason: string, offset: number): void =>
    context.report(describeIssue(id, NAMESPACE_OPTION, source, offset, `namespace not converted: ${reason}`));
  const options = { indent: context.indent, report };

  return option.value === 'file_scoped' ? convertToFileScoped(source, options) : convertToBlockScoped(source, options);
}

// ---------------------------------------------------------------------------------------------
// csharp_using_directive_placement (IDE0065): the step of `runCleanup.ts` (see `namespaceScope.ts`), not a rule here.
// ---------------------------------------------------------------------------------------------

/**
 * The text between `start` and `end` without its surrounding blank lines and with the indentation
 * of its first line removed from every line (lines inside string literals are never changed).
 */
function dedentBlock(source: string, kinds: Uint8Array, start: number, end: number): string {
  const text = source.slice(start, end);
  const firstContent = text.search(/\S/);
  if (firstContent < 0) {
    return '';
  }

  const unit = lineIndentAt(text, firstContent);
  const newline = newlineOf(source);
  const lines: string[] = [];
  let lineStart = lineStartAt(text, firstContent);

  while (lineStart <= text.length) {
    const lineEnd = lineEndAt(text, lineStart);
    const line = text.slice(lineStart, lineEnd);
    const startsInString = lineStart > 0 && kinds[start + lineStart - 1] === STRING;
    lines.push(startsInString ? line : line.startsWith(unit) ? line.slice(unit.length) : isBlank(line) ? '' : line);

    const next = text.indexOf('\n', lineEnd);
    if (next < 0) {
      break;
    }

    lineStart = next + 1;
  }

  return lines.join(newline).trimEnd();
}

// ---------------------------------------------------------------------------------------------
// file_header_template (IDE0073)
// ---------------------------------------------------------------------------------------------

function applyFileHeaderTemplate(source: string, context: RuleContext): string {
  const template = context.props.get('file_header_template');
  if (!template?.trim() || !isEnforced(resolveDiagnosticSeverity(context.props, 'IDE0073'))) {
    return source;
  }

  const report = (message: string): string => {
    context.report(describeIssue('IDE0073', 'file_header_template', source, 0, message));

    return source;
  };

  let text = template.replace(/\\n/g, '\n');
  if (text.includes('{fileName}')) {
    if (!context.fileName) {
      return report('file header not applied: the file name is unknown.');
    }

    text = text.replace(/\{fileName\}/g, context.fileName);
  }

  const newline = newlineOf(source);
  const expected = text.split('\n').map((line) => (line.trimEnd() ? `// ${line.trimEnd()}` : '//'));
  const existing = /^(?:[ \t]*\/\/(?!\/)[^\r\n]*(?:\r?\n|$))+/.exec(source)?.[0] ?? '';

  if (!existing && /^\s*\/\*/.test(source)) {
    return report('file header not applied: the file starts with a block comment.');
  }

  if (/<auto-generated/i.test(existing)) {
    return source;
  }

  const currentLines = existing.split(/\r?\n/).filter((line, index, all) => index < all.length - 1 || line !== '');
  if (currentLines.map((line) => line.trim()).join('\n') === expected.join('\n')) {
    return source;
  }

  const rest = source.slice(existing.length).replace(/^(?:[ \t]*\r?\n)+/, '');

  return `${expected.join(newline)}${newline}${rest ? newline + rest : ''}`;
}

// ---------------------------------------------------------------------------------------------
// dotnet_style_require_accessibility_modifiers (IDE0040)
// ---------------------------------------------------------------------------------------------

const ACCESSIBILITY_OPTION = 'dotnet_style_require_accessibility_modifiers';
const ACCESS_MODIFIERS: Record<string, true> = { public: true, internal: true, protected: true, private: true };

const TYPE_DECLARATIONS: Record<string, true> = {
  class_declaration: true,
  struct_declaration: true,
  record_declaration: true,
  interface_declaration: true,
  enum_declaration: true,
  delegate_declaration: true,
};

const MEMBER_DECLARATIONS: Record<string, true> = {
  field_declaration: true,
  event_field_declaration: true,
  event_declaration: true,
  method_declaration: true,
  property_declaration: true,
  indexer_declaration: true,
  constructor_declaration: true,
};

const ALL_ACCESS_MODIFIER_KINDS = {
  insertExplicitAccessModifiersOnClasses: true,
  insertExplicitAccessModifiersOnDelegates: true,
  insertExplicitAccessModifiersOnEnumerations: true,
  insertExplicitAccessModifiersOnEvents: true,
  insertExplicitAccessModifiersOnFields: true,
  insertExplicitAccessModifiersOnInterfaces: true,
  insertExplicitAccessModifiersOnMethods: true,
  insertExplicitAccessModifiersOnProperties: true,
  insertExplicitAccessModifiersOnStructs: true,
};

function applyAccessibilityModifierPreference(source: string, context: RuleContext): string {
  const option = readCodeStyleOption(context.props, ACCESSIBILITY_OPTION, 'IDE0040');
  if (!option?.enforced) {
    return source;
  }

  switch (option.value) {
    case 'always':
    case 'for_non_interface_members': {
      const updated = addPrivateToIndexers(createExplicitAccessModifierConverter(ALL_ACCESS_MODIFIER_KINDS).apply(source));
      reportMissingAccessibility(updated, context, option.value === 'always');

      return updated;
    }

    case 'omit_if_default':
      return removeDefaultAccessModifiers(source);

    default:
      return source;
  }
}

function modifiers(node: Node): Node[] {
  return node.namedChildren.filter((child) => child.type === 'modifier');
}

function accessModifiers(node: Node): Node[] {
  return modifiers(node).filter((child) => ACCESS_MODIFIERS[child.text] === true);
}

/** The type a member is declared in (through its `declaration_list`), if any. */
function containingType(node: Node): Node | undefined {
  const owner = node.parent?.type === 'declaration_list' ? node.parent.parent : undefined;

  return owner && TYPE_DECLARATIONS[owner.type] === true ? owner : undefined;
}

/** The explicit-access converter does not handle indexers; they default to `private` in classes and structs. */
function addPrivateToIndexers(source: string): string {
  const tree = parseCSharp(source);

  try {
    const edits: TextEdit[] = [];

    for (const indexer of findAll(tree.rootNode, 'indexer_declaration')) {
      const owner = containingType(indexer);
      if (
        !owner ||
        owner.type === 'interface_declaration' ||
        hasParseErrors(indexer) ||
        indexer.parent?.namedChildren.some(isRecoveredNode) ||
        accessModifiers(indexer).length > 0 ||
        indexer.namedChildren.some((child) => child.type === 'explicit_interface_specifier')
      ) {
        continue;
      }

      const anchor = modifiers(indexer)[0] ?? indexer.childForFieldName('type');
      if (anchor) {
        edits.push({ start: anchor.startIndex, end: anchor.startIndex, text: 'private ' });
      }
    }

    return applyEdits(source, edits);
  } finally {
    tree.delete();
  }
}

/**
 * Reports declarations still without an access modifier: partial types (the accessibility may be
 * declared by another part) and, for `always`, interface members.
 */
function reportMissingAccessibility(source: string, context: RuleContext, includeInterfaceMembers: boolean): void {
  const tree = parseCSharp(source);

  try {
    for (const node of walk(tree.rootNode)) {
      if (accessModifiers(node).length > 0) {
        continue;
      }

      const isPartial = modifiers(node).some((child) => child.text === 'partial');
      const owner = containingType(node);
      let reason: string | undefined;

      if (TYPE_DECLARATIONS[node.type] === true && isPartial) {
        reason = 'the accessibility of a partial type may be declared by another part';
      } else if (
        includeInterfaceMembers &&
        owner?.type === 'interface_declaration' &&
        MEMBER_DECLARATIONS[node.type] === true &&
        !node.namedChildren.some((child) => child.type === 'explicit_interface_specifier')
      ) {
        reason = 'interface members are not changed (explicit accessibility requires C# 8 default interface members)';
      }

      if (reason) {
        context.report(describeIssue('IDE0040', ACCESSIBILITY_OPTION, source, node.startIndex, `no access modifier added: ${reason}.`));
      }
    }
  } finally {
    tree.delete();
  }
}

/**
 * `omit_if_default`: removes `private` from members and nested types of classes, structs and
 * records, and `internal` from top-level types, when it is the only access modifier. Interface
 * members and partial methods are left alone.
 */
function removeDefaultAccessModifiers(source: string): string {
  const tree = parseCSharp(source);

  try {
    const edits: TextEdit[] = [];

    for (const node of walk(tree.rootNode)) {
      const isType = TYPE_DECLARATIONS[node.type] === true;
      if (!isType && MEMBER_DECLARATIONS[node.type] !== true) {
        continue;
      }

      const access = accessModifiers(node);
      if (access.length !== 1) {
        continue;
      }

      const owner = containingType(node);
      if (owner?.type === 'interface_declaration' || (!owner && !isType)) {
        continue;
      }

      if (node.type === 'method_declaration' && modifiers(node).some((child) => child.text === 'partial')) {
        continue;
      }

      const defaultAccess = owner ? 'private' : 'internal';
      if (access[0].text !== defaultAccess) {
        continue;
      }

      let end = access[0].endIndex;
      while (/\s/.test(source[end] ?? '')) {
        end++;
      }

      edits.push({ start: access[0].startIndex, end, text: '' });
    }

    return applyEdits(source, edits);
  } finally {
    tree.delete();
  }
}

// ---------------------------------------------------------------------------------------------
// csharp_prefer_simple_using_statement (IDE0063)
// ---------------------------------------------------------------------------------------------

const SIMPLE_USING_OPTION = 'csharp_prefer_simple_using_statement';
const MAX_SIMPLE_USING_PASSES = 32;

function applySimpleUsingStatementPreference(source: string, context: RuleContext): string {
  if (!isPreferred(context.props, SIMPLE_USING_OPTION, 'IDE0063')) {
    return source;
  }

  const issues = new Set<string>();
  let current = source;

  for (let pass = 0; pass < MAX_SIMPLE_USING_PASSES; pass++) {
    const updated = simplifyLastUsingStatements(current, issues);
    if (updated === current) {
      break;
    }

    current = updated;
  }

  for (const issue of issues) {
    context.report(issue);
  }

  return current;
}

/**
 * Converts `using (declaration) { ... }` to `using declaration;` when it is the last statement of
 * its block, so the resource is still disposed at the same point, and the names it declares are
 * not used anywhere else in the block (they would then clash with the enclosing scope).
 */
function simplifyLastUsingStatements(source: string, issues: Set<string>): string {
  const tree = parseCSharp(source);

  try {
    const kinds = classifyCSharp(source);
    const edits: TextEdit[] = [];

    for (const statement of findAll(tree.rootNode, 'using_statement')) {
      const block = statement.parent;
      const declaration = statement.namedChildren.find((child) => child.type === 'variable_declaration');
      const body = statement.namedChildren[statement.namedChildren.length - 1];
      if (block?.type !== 'block' || !declaration || body?.type !== 'block') {
        continue;
      }

      const statements = block.namedChildren.filter((child) => child.type !== 'comment' && !child.type.startsWith('preproc'));
      if (statements[statements.length - 1] !== statement || /\bawait\s*$/.test(source.slice(lineStartAt(source, statement.startIndex), statement.startIndex))) {
        continue;
      }

      if (edits.some((edit) => edit.start < statement.endIndex && statement.startIndex < edit.end)) {
        continue;
      }

      const reason = simpleUsingBlocker(source, kinds, block, statement, body);
      if (reason) {
        issues.add(describeIssue('IDE0063', SIMPLE_USING_OPTION, source, statement.startIndex, `using statement not simplified: ${reason}`));
        continue;
      }

      const newline = newlineOf(source);
      const open = body.children[0];
      const close = body.children[body.children.length - 1];
      const usingIndent = lineIndentAt(source, statement.startIndex);
      const inner = dedentBlock(source, kinds, open.endIndex, close.startIndex)
        .split(newline)
        .map((line) => (line ? usingIndent + line : line))
        .join(newline);

      edits.push({
        start: statement.startIndex,
        end: statement.endIndex,
        text: `using ${declaration.text};${inner ? newline + inner : ''}`,
      });
    }

    return applyEdits(source, edits);
  } finally {
    tree.delete();
  }
}

function simpleUsingBlocker(source: string, kinds: Uint8Array, block: Node, statement: Node, body: Node): string | undefined {
  if (hasParseErrors(block)) {
    return 'the enclosing block could not be fully parsed.';
  }

  const open = body.children[0];
  const close = body.children[body.children.length - 1];
  if (open?.type !== '{' || close?.type !== '}') {
    return 'the using body could not be fully parsed.';
  }

  const header = statement.children.find((child) => child.type === ')');
  if (!header || !isBlank(source.slice(header.endIndex, open.startIndex))) {
    return 'a comment separates the using header from its body.';
  }

  if (containsMultiLineString(source, kinds, open.endIndex, close.startIndex)) {
    return 'the body contains a multi-line string literal, which cannot be re-indented.';
  }

  const declared = new Set<string>();
  for (const node of statement.descendantsOfType(['variable_declarator', 'declaration_expression', 'local_function_statement'])) {
    const name = node.childForFieldName('name')?.text;
    if (name) {
      declared.add(name);
    }
  }

  for (const identifier of block.descendantsOfType('identifier')) {
    const insideStatement = identifier.startIndex >= statement.startIndex && identifier.endIndex <= statement.endIndex;
    if (!insideStatement && declared.has(identifier.text)) {
      return `'${identifier.text}' is also used elsewhere in the enclosing block.`;
    }
  }

  return undefined;
}
