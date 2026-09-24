import { STRING, classifyCSharp } from '../csharpScanner';
import { EditorConfigProperties, isEnforced, resolveDiagnosticSeverity } from '../editorconfig';
import { Node, TextEdit, applyEdits, findAll, parseCSharp, walk } from '../parser';
import { SourceTransformation } from '../types';
import { applyBracePreference } from './editorConfigBraces';
import { applyQualificationPreferences } from './editorConfigQualification';
import {
  EditorConfigIssueReporter,
  containsMultiLineString,
  describeIssue,
  hasParseErrors,
  indentFollowingLines,
  indentUnit,
  isBlank,
  lineEndAt,
  lineIndentAt,
  lineStartAt,
  newlineOf,
  parseErrorCount,
  readCodeStyleOption,
} from './editorConfigSupport';
import { EXPRESSION_PREFERENCES, applyExpressionPreference } from './editorConfigExpressionPreferences';
import { STATEMENT_PREFERENCES, applyStatementPreference } from './editorConfigStatementPreferences';
import { applySystemThreadingLock, reportPrimaryConstructors } from './editorConfigTypePreferences';
import { applyVarPreferences } from './editorConfigVarPreference';
import { createExplicitAccessModifierConverter } from './explicitAccessModifier';
import { moveUsingsOutside } from './namespaceScope';
import { inlineOutVariableDeclarations } from './outVarInlining';
import { readonlyFieldConverter } from './readonlyFieldAndSingleLineMethods';

export interface EditorConfigCodeStyleOptions {
  /** File name used for `{fileName}` in `file_header_template`. */
  readonly fileName?: string;
  /** Target frameworks of the file's project, when known (see `projectInfo.ts`). */
  readonly targetFrameworks?: readonly string[];
}

interface RuleContext {
  readonly props: EditorConfigProperties;
  readonly report: EditorConfigIssueReporter;
  /** One indentation level for code the rules create or re-indent. */
  readonly indent: string;
  readonly fileName?: string;
  readonly targetFrameworks?: readonly string[];
}

interface Rule {
  /** The option(s) the rule applies, for reports. */
  readonly option: string;
  readonly apply: (source: string, context: RuleContext) => string;
}

/**
 * Applies the C# code-style preferences of `.editorconfig` whose diagnostic is enforced
 * (`suggestion`, `warning` or `error`). Each rule rewrites code only when the result is certain
 * from syntax alone and reports every violation it leaves in place.
 */
export function createEditorConfigCodeStyleConverter(
  props: EditorConfigProperties,
  report: EditorConfigIssueReporter,
  options: EditorConfigCodeStyleOptions = {}
): SourceTransformation {
  return {
    name: 'Apply .editorconfig code style',
    apply(source: string): string {
      if (!source || !source.trim()) {
        return source;
      }

      // A byte order mark would confuse the parser; the rules work on the text after it.
      const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
      const text = source.slice(bom.length);
      const context: RuleContext = { props, report, indent: indentUnit(props, text), fileName: options.fileName, targetFrameworks: options.targetFrameworks };

      let current = text;
      let errors: number | undefined;

      for (const rule of RULES) {
        const updated = rule.apply(current, context);
        if (updated === current) {
          continue;
        }

        // Every rule edits code it parsed; a result the parser reads worse than the input is dropped.
        errors ??= parseErrorCount(current);
        const updatedErrors = parseErrorCount(updated);
        if (updatedErrors > errors) {
          report(`${rule.option}: changes discarded, the rewritten code could not be verified.`);
          continue;
        }

        current = updated;
        errors = updatedErrors;
      }

      return bom + current;
    },
  };
}

const RULES: readonly Rule[] = [
  { option: 'csharp_style_namespace_declarations', apply: applyNamespaceDeclarationPreference },
  { option: 'csharp_using_directive_placement', apply: applyUsingPlacementPreference },
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
    (rule): Rule => ({ option: rule.option, apply: (source, { props }) => applyStatementPreference(rule, source, props) })
  ),
  ...EXPRESSION_PREFERENCES.map(
    (rule): Rule => ({
      option: rule.option,
      apply: (source, { props, report }) => applyExpressionPreference(rule, source, props, report),
    })
  ),
  {
    option: 'csharp_prefer_system_threading_lock',
    apply: (source, { props, report, targetFrameworks }) => applySystemThreadingLock(source, props, report, targetFrameworks),
  },
  {
    option: 'csharp_style_prefer_primary_constructors',
    apply: (source, { props, report }) => reportPrimaryConstructors(source, props, report),
  },
  {
    option: 'csharp_prefer_braces',
    apply: (source, { props, report, indent }) => applyBracePreference(source, props, report, indent),
  },
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

/** Compilation-unit children that may accompany the single namespace of a convertible file. */
const FILE_LEVEL_TRIVIA: Record<string, true> = {
  using_directive: true,
  comment: true,
  extern_alias_directive: true,
  attribute_list: true,
};

function applyNamespaceDeclarationPreference(source: string, context: RuleContext): string {
  const option = readCodeStyleOption(context.props, NAMESPACE_OPTION, (value) => (value === 'block_scoped' ? 'IDE0160' : 'IDE0161'));
  if (!option?.enforced) {
    return source;
  }

  if (option.value === 'file_scoped') {
    return toFileScopedNamespace(source, context);
  }

  return option.value === 'block_scoped' ? toBlockScopedNamespace(source, context) : source;
}

/**
 * Converts the file's only (block-scoped) namespace to a file-scoped one, keeping any using
 * directives inside it (a file-scoped namespace keeps them in the namespace). Like Roslyn, files
 * with other top-level members or several namespaces are not candidates.
 */
function toFileScopedNamespace(source: string, context: RuleContext): string {
  const tree = parseCSharp(source);

  try {
    const members = tree.rootNode.namedChildren.filter(
      (child) => FILE_LEVEL_TRIVIA[child.type] !== true && !child.type.startsWith('preproc')
    );
    const namespaceNode = members[0];
    if (members.length !== 1 || namespaceNode.type !== 'namespace_declaration') {
      return source;
    }

    if (findAll(namespaceNode, ['namespace_declaration', 'file_scoped_namespace_declaration']).length !== 1) {
      return source;
    }

    const body = namespaceNode.childForFieldName('body');
    const name = namespaceNode.childForFieldName('name');
    const open = body?.children.find((child) => child.type === '{');
    const close = body?.children[body.children.length - 1];
    const fail = (reason: string): string => {
      context.report(describeIssue('IDE0161', NAMESPACE_OPTION, source, namespaceNode.startIndex, `namespace not converted: ${reason}`));

      return source;
    };

    if (!name || !open || close?.type !== '}') {
      return fail('the namespace could not be fully parsed.');
    }

    const kinds = classifyCSharp(source);
    if (!isBlank(source.slice(name.endIndex, open.startIndex)) || !isBlank(source.slice(close.endIndex))) {
      return fail('comments or code surround the namespace braces.');
    }

    if (containsMultiLineString(source, kinds, open.endIndex, close.startIndex)) {
      return fail('the namespace contains a multi-line string literal, which cannot be re-indented.');
    }

    const newline = newlineOf(source);
    const bodyText = dedentBlock(source, kinds, open.endIndex, close.startIndex);
    const header = source.slice(0, namespaceNode.startIndex);

    return `${header}namespace ${name.text};${bodyText ? newline + newline + bodyText : ''}${newline}`;
  } finally {
    tree.delete();
  }
}

/** Converts a file-scoped namespace to a block-scoped one, indenting everything after it by one level. */
function toBlockScopedNamespace(source: string, context: RuleContext): string {
  const tree = parseCSharp(source);

  try {
    const namespaces = findAll(tree.rootNode, 'file_scoped_namespace_declaration');
    if (namespaces.length !== 1) {
      return source;
    }

    const namespaceNode = namespaces[0];
    const name = namespaceNode.childForFieldName('name');
    const semicolon = namespaceNode.children.find((child) => child.type === ';');
    if (!name || !semicolon) {
      context.report(describeIssue('IDE0160', NAMESPACE_OPTION, source, namespaceNode.startIndex, 'namespace not converted: it could not be fully parsed.'));

      return source;
    }

    const kinds = classifyCSharp(source);
    if (containsMultiLineString(source, kinds, semicolon.endIndex, source.length)) {
      context.report(
        describeIssue(
          'IDE0160',
          NAMESPACE_OPTION,
          source,
          namespaceNode.startIndex,
          'namespace not converted: the file contains a multi-line string literal, which cannot be re-indented.'
        )
      );

      return source;
    }

    const newline = newlineOf(source);
    const rest = source.slice(semicolon.endIndex);
    const leadingBlank = /^(?:[ \t]*\r?\n)*/.exec(rest)?.[0].length ?? 0;
    const content = rest.slice(leadingBlank).trimEnd();
    const body = content
      ? `${context.indent}${indentFollowingLines(content, context.indent, kinds, semicolon.endIndex + leadingBlank)}${newline}`
      : '';

    return `${source.slice(0, namespaceNode.startIndex)}namespace ${name.text}${newline}{${newline}${body}}${newline}`;
  } finally {
    tree.delete();
  }
}

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
// csharp_using_directive_placement (IDE0065)
// ---------------------------------------------------------------------------------------------

const USING_PLACEMENT_OPTION = 'csharp_using_directive_placement';

/** Roots that are taken to be fully qualified when a using directive moves out of a namespace. */
const WELL_KNOWN_ROOTS: Record<string, true> = { System: true, Microsoft: true };

function applyUsingPlacementPreference(source: string, context: RuleContext): string {
  const option = readCodeStyleOption(context.props, USING_PLACEMENT_OPTION, 'IDE0065');
  if (!option?.enforced || (option.value !== 'outside_namespace' && option.value !== 'inside_namespace')) {
    return source;
  }

  const tree = parseCSharp(source);

  try {
    const root = tree.rootNode;
    const namespaces = findAll(root, ['namespace_declaration', 'file_scoped_namespace_declaration']);
    const report = (node: Node, message: string): void => {
      context.report(describeIssue('IDE0065', USING_PLACEMENT_OPTION, source, node.startIndex, message));
    };

    if (option.value === 'inside_namespace') {
      const topUsings = root.namedChildren.filter((child) => child.type === 'using_directive' && !/^global\b/.test(child.text));
      if (topUsings.length > 0 && namespaces.length === 1) {
        report(
          topUsings[0],
          'using directives were not moved into the namespace: inside a namespace their names can bind to different types.'
        );
      }

      return source;
    }

    const insideUsings = namespaces.flatMap((namespaceNode) => {
      const body = namespaceNode.childForFieldName('body');
      const container = body?.type === 'declaration_list' ? body : namespaceNode;

      return container.namedChildren.filter((child) => child.type === 'using_directive');
    });
    if (insideUsings.length === 0) {
      return source;
    }

    if (namespaces.length > 1) {
      report(insideUsings[0], 'using directives were not moved: the file declares several namespaces.');

      return source;
    }

    const namespaceRoot = namespaces[0].childForFieldName('name')?.text.split('.')[0];
    const relative = insideUsings.filter((directive) => !isFullyQualifiedUsing(directive.text, namespaceRoot));
    if (relative.length > 0) {
      for (const directive of relative) {
        report(directive, `'${directive.text}' was not moved: outside the namespace its name may bind differently.`);
      }

      return source;
    }

    return removeBlankLinesAfterNamespaceOpening(moveUsingsOutside(source));
  } finally {
    tree.delete();
  }
}

function isFullyQualifiedUsing(text: string, namespaceRoot: string | undefined): boolean {
  const target = /^using\s+(?:static\s+)?(?:@?\w+\s*=\s*)?([\s\S]*?);$/.exec(text.trim())?.[1].trim();
  if (!target) {
    return false;
  }

  if (target.startsWith('global::')) {
    return true;
  }

  const first = target.split(/[.<:\s]/)[0];

  return WELL_KNOWN_ROOTS[first] === true || first === namespaceRoot;
}

/** Moving usings out leaves the blank line that separated them from the members; drop it. */
function removeBlankLinesAfterNamespaceOpening(source: string): string {
  const tree = parseCSharp(source);

  try {
    const edits: TextEdit[] = [];

    for (const namespaceNode of findAll(tree.rootNode, ['namespace_declaration', 'file_scoped_namespace_declaration'])) {
      const body = namespaceNode.childForFieldName('body');
      const opener =
        body?.type === 'declaration_list'
          ? body.children.find((child) => child.type === '{')
          : namespaceNode.children.find((child) => child.type === ';');
      if (!opener) {
        continue;
      }

      const lineEnd = lineEndAt(source, opener.endIndex);
      const blank = /^(?:\r?\n[ \t]*(?=\r?\n))+/.exec(source.slice(lineEnd))?.[0];
      if (blank && isBlank(source.slice(opener.endIndex, lineEnd))) {
        // Keep one blank line after a file-scoped `namespace X;`, none after `{`.
        const keep = opener.type === ';' ? newlineOf(source) : '';
        edits.push({ start: lineEnd, end: lineEnd + blank.length, text: keep });
      }
    }

    return applyEdits(source, edits);
  } finally {
    tree.delete();
  }
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
