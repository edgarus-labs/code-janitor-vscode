import { CODE, STRING, classifyCSharp } from '../csharpScanner';
import { EditorConfigProperties, isEnforced, resolveDiagnosticSeverity, splitOptionSeverity } from '../editorconfig';
import { Node, TextEdit, applyEdits, findAll, parseCSharp } from '../parser';
import { OPEN_BRACE_KINDS } from '../editorConfigRegistry';
import { SourceTransformation } from '../types';
import {
  EditorConfigIssueReporter,
  describeIssue,
  isBlank,
  lineIndentAt,
  newlineOf,
  parseErrorCount,
  tabWidth,
} from './editorConfigSupport';
import { applyIndentation } from './editorConfigIndentation';
import { applySpacing } from './editorConfigSpacing';
import { applyQueryClauseNewLines, applyWrapping } from './editorConfigWrapping';
import { removeTrailingWhitespace } from './text';
import { sortUsingDirectives } from './usingDirectiveOrganizer';

/**
 * Applies `.editorconfig` formatting. The core EditorConfig properties (`indent_style`,
 * `end_of_line`, `insert_final_newline`, `trim_trailing_whitespace`, `charset`) and the using
 * order options always apply. The C# formatting options only apply while IDE0055 ("Fix
 * formatting") is enforced, as in Roslyn, where they have no severity of their own. String
 * literals and comment text are never changed.
 */
export function createEditorConfigFormattingConverter(
  props: EditorConfigProperties,
  report: EditorConfigIssueReporter
): SourceTransformation {
  return {
    name: 'Apply .editorconfig formatting',
    apply(source: string): string {
      if (!source) {
        return source;
      }

      // A byte order mark would confuse the parser; formatting works on the text after it.
      const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
      let current = source.slice(bom.length);
      // IDE0055 ("Fix formatting") gates every C# formatting option, as in Roslyn. Using order has
      // no diagnostic of its own and applies whenever it is set.
      const enforced = isEnforced(resolveDiagnosticSeverity(props, 'IDE0055'));
      let formatted = applyUsingDirectiveOrder(current, props);
      if (enforced) {
        formatted = applyWrapping(formatted, props);
        formatted = applyOpenBraceNewLines(formatted, props, report);
        formatted = applyNewLinesBeforeKeywords(formatted, props);
        formatted = applySpacing(formatted, props);
        formatted = applyQueryClauseNewLines(formatted, props);
        formatted = applyIndentation(formatted, props, report);
      }

      // Only whitespace and using order change; a result the parser reads worse is dropped.
      if (formatted !== current && parseErrorCount(formatted) > parseErrorCount(current)) {
        report('IDE0055: C# formatting discarded, the reformatted code could not be verified.');
      } else {
        current = formatted;
      }

      current = applyIndentStyle(current, props);
      if (optionValue(props, 'trim_trailing_whitespace') === 'true') {
        current = removeTrailingWhitespace(current);
      }

      current = applyEndOfLine(current, props, report);
      current = applyFinalNewline(current, props);

      return optionValue(props, 'charset') === 'utf-8' ? current : bom + current;
    },
  };
}

/** A formatting option's value, lower-cased, ignoring a `:severity` suffix some files carry. */
function optionValue(props: EditorConfigProperties, key: string): string | undefined {
  const raw = props.get(key);

  return raw === undefined ? undefined : splitOptionSeverity(raw).value.toLowerCase();
}

// ---------------------------------------------------------------------------------------------
// dotnet_sort_system_directives_first / dotnet_separate_import_directive_groups
// ---------------------------------------------------------------------------------------------

/**
 * Whenever the options are set, usings are sorted (`System` first only for `true`) and groups are
 * separated by a blank line (`true`) or joined (`false`), whatever the "Sort usings" setting says.
 */
function applyUsingDirectiveOrder(source: string, props: EditorConfigProperties): string {
  let current = source;
  const systemFirst = optionValue(props, 'dotnet_sort_system_directives_first');
  if (systemFirst === 'true' || systemFirst === 'false') {
    current = sortUsingDirectives(current, systemFirst === 'true');
  }

  const separate = optionValue(props, 'dotnet_separate_import_directive_groups');
  if (separate === 'true') {
    current = separateUsingGroups(current);
  } else if (separate === 'false') {
    current = joinUsingGroups(current);
  }

  return current;
}

/** Adjacent using directives of each container (compilation unit or namespace body). */
function adjacentUsings(root: Node): [Node, Node][] {
  const pairs: [Node, Node][] = [];
  const containers = [
    root,
    ...findAll(root, ['namespace_declaration', 'file_scoped_namespace_declaration']).map((namespaceNode) => namespaceNode.childForFieldName('body') ?? namespaceNode),
  ];

  for (const container of containers) {
    const children = container.namedChildren;
    for (let i = 1; i < children.length; i++) {
      if (children[i - 1].type === 'using_directive' && children[i].type === 'using_directive') {
        pairs.push([children[i - 1], children[i]]);
      }
    }
  }

  return pairs;
}

/** Removes the blank lines between adjacent using directives (not across comments or directives). */
function joinUsingGroups(source: string): string {
  const tree = parseCSharp(source);

  try {
    const edits: TextEdit[] = [];
    for (const [previous, current] of adjacentUsings(tree.rootNode)) {
      const gap = source.slice(previous.endIndex, current.startIndex);
      if (isBlank(gap) && (gap.match(/\n/g) ?? []).length > 1) {
        const firstBreak = previous.endIndex + gap.indexOf('\n') + 1;
        edits.push({ start: firstBreak, end: current.startIndex, text: source.slice(lineIndentStart(source, current.startIndex), current.startIndex) });
      }
    }

    return applyEdits(source, edits);
  } finally {
    tree.delete();
  }
}

/** Start of the whitespace that indents the line containing `index`. */
function lineIndentStart(source: string, index: number): number {
  let start = index;
  while (start > 0 && (source[start - 1] === ' ' || source[start - 1] === '\t')) {
    start--;
  }

  return start;
}

/** Inserts a blank line between adjacent using directives whose first namespace segment differs. */
function separateUsingGroups(source: string): string {
  const tree = parseCSharp(source);

  try {
    const edits: TextEdit[] = [];
    for (const [previous, current] of adjacentUsings(tree.rootNode)) {
      const gap = source.slice(previous.endIndex, current.startIndex);
      if (usingGroup(previous.text) === usingGroup(current.text) || (gap.match(/\n/g) ?? []).length !== 1 || !isBlank(gap)) {
        continue;
      }

      const lineBreak = previous.endIndex + gap.indexOf('\n') + 1;
      edits.push({ start: lineBreak, end: lineBreak, text: newlineOf(source) });
    }

    return applyEdits(source, edits);
  } finally {
    tree.delete();
  }
}

function usingGroup(text: string): string {
  const match = /^(global\s+)?using\s+(static\s+)?(?:(@?\w+)\s*=\s*)?(?:global::)?([\w@]+)/.exec(text.trim());
  if (!match) {
    return text;
  }

  if (match[3]) {
    return 'alias';
  }

  return `${match[1] ? 'global ' : ''}${match[2] ? 'static ' : ''}${match[4]}`;
}

// ---------------------------------------------------------------------------------------------
// csharp_new_line_before_open_brace
// ---------------------------------------------------------------------------------------------

const CONTROL_BLOCK_OWNERS: Record<string, true> = {
  if_statement: true,
  for_statement: true,
  for_each_statement: true,
  while_statement: true,
  do_statement: true,
  using_statement: true,
  lock_statement: true,
  fixed_statement: true,
  try_statement: true,
  catch_clause: true,
  finally_clause: true,
  checked_statement: true,
  unchecked_statement: true,
  unsafe_statement: true,
  switch_statement: true,
};

const METHOD_OWNERS: Record<string, true> = {
  method_declaration: true,
  constructor_declaration: true,
  destructor_declaration: true,
  operator_declaration: true,
  conversion_operator_declaration: true,
};

const TYPE_OWNERS: Record<string, true> = {
  class_declaration: true,
  struct_declaration: true,
  record_declaration: true,
  interface_declaration: true,
  enum_declaration: true,
  namespace_declaration: true,
};

/** The `csharp_new_line_before_open_brace` kind governing an opening brace, if it is one Roslyn formats. */
function braceKind(container: Node): string | undefined {
  const owner = container.parent;
  if (!owner) {
    return undefined;
  }

  switch (container.type) {
    case 'declaration_list':
    case 'enum_member_declaration_list':
      return TYPE_OWNERS[owner.type] === true ? 'types' : undefined;

    case 'accessor_list':
      return owner.type === 'property_declaration'
        ? 'properties'
        : owner.type === 'indexer_declaration'
          ? 'indexers'
          : owner.type === 'event_declaration'
            ? 'events'
            : undefined;

    case 'switch_body':
      return owner.type === 'switch_statement' ? 'control_blocks' : undefined;

    case 'initializer_expression':
      // As in Roslyn, array initializers (`new[] {`, `new int[] {`, `int[] a = {`) keep their brace.
      if (owner.type === 'array_creation_expression' || owner.type === 'implicit_array_creation_expression' || owner.type === 'equals_value_clause') {
        return undefined;
      }

      return owner.type === 'anonymous_object_creation_expression' ? 'anonymous_types' : 'object_collection_array_initializers';

    case 'block':
      if (METHOD_OWNERS[owner.type] === true) {
        return 'methods';
      }

      if (CONTROL_BLOCK_OWNERS[owner.type] === true) {
        return 'control_blocks';
      }

      switch (owner.type) {
        case 'local_function_statement':
          return 'local_functions';
        case 'accessor_declaration':
          return 'accessors';
        case 'lambda_expression':
          return 'lambdas';
        case 'anonymous_method_expression':
          return 'anonymous_methods';
        default:
          return undefined;
      }

    default:
      return undefined;
  }
}

function applyOpenBraceNewLines(source: string, props: EditorConfigProperties, report: EditorConfigIssueReporter): string {
  const value = optionValue(props, 'csharp_new_line_before_open_brace');
  if (value === undefined) {
    return source;
  }

  const wanted = new Set(
    value === 'all' ? OPEN_BRACE_KINDS : value === 'none' ? [] : value.split(',').map((kind) => kind.trim()).filter(Boolean)
  );
  const tree = parseCSharp(source);

  try {
    const kinds = classifyCSharp(source);
    const newline = newlineOf(source);
    const edits: TextEdit[] = [];

    for (const open of tree.rootNode.descendantsOfType('{')) {
      const container = open.parent;
      const close = container?.children[container.children.length - 1];
      const kind = container ? braceKind(container) : undefined;
      if (!container || !kind || close?.type !== '}' || !source.slice(open.endIndex, close.startIndex).includes('\n')) {
        // Single-line constructs (`{ get; set; }`, `new[] { 1, 2 }`) keep their layout.
        continue;
      }

      const previousEnd = previousTokenEnd(source, open.startIndex);
      if (previousEnd === 0) {
        continue;
      }

      const onOwnLine = source.slice(previousEnd, open.startIndex).includes('\n');
      if (wanted.has(kind) === onOwnLine) {
        continue;
      }

      if (!endsInCode(source, kinds, previousEnd)) {
        report(
          describeIssue(
            'IDE0055',
            'csharp_new_line_before_open_brace',
            source,
            open.startIndex,
            'brace not moved: a comment or directive precedes it.'
          )
        );
        continue;
      }

      // A brace moved to its own line takes the indentation of the `else` before an `else` block,
      // otherwise of the line where the construct owning the brace starts.
      const anchor =
        container.parent?.type === 'if_statement' && /\belse$/.test(source.slice(0, previousEnd))
          ? previousEnd - 4
          : (container.parent?.startIndex ?? previousEnd);
      edits.push({
        start: previousEnd,
        end: open.startIndex,
        text: onOwnLine ? ' ' : `${newline}${lineIndentAt(source, anchor)}`,
      });
    }

    return applyEdits(source, edits);
  } finally {
    tree.delete();
  }
}

/** Index of the `{` matching the code `}` at `close` (0 when unbalanced). */
function matchingOpenBrace(source: string, kinds: Uint8Array, close: number): number {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (kinds[i] !== CODE) {
      continue;
    }

    if (source[i] === '}') {
      depth++;
    } else if (source[i] === '{' && --depth === 0) {
      return i;
    }
  }

  return 0;
}

/** End of the last non-whitespace character before `index`; 0 at the start of the file. */
function previousTokenEnd(source: string, index: number): number {
  let i = index;
  while (i > 0 && /\s/.test(source[i - 1])) {
    i--;
  }

  return i;
}

/** True when a brace may be joined to the line ending at `end`: it ends in code, not a comment or directive. */
function endsInCode(source: string, kinds: Uint8Array, end: number): boolean {
  return end > 0 && kinds[end - 1] === CODE && !/^[ \t]*#/.test(source.slice(source.lastIndexOf('\n', end - 1) + 1, end));
}

// ---------------------------------------------------------------------------------------------
// csharp_new_line_before_else / _catch / _finally
// ---------------------------------------------------------------------------------------------

function applyNewLinesBeforeKeywords(source: string, props: EditorConfigProperties): string {
  const settings: [string, string][] = [
    ['else', 'csharp_new_line_before_else'],
    ['catch', 'csharp_new_line_before_catch'],
    ['finally', 'csharp_new_line_before_finally'],
  ];
  const wanted = new Map(
    settings
      .map(([keyword, option]) => [keyword, optionValue(props, option)] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] === 'true' || entry[1] === 'false')
  );
  if (wanted.size === 0) {
    return source;
  }

  const tree = parseCSharp(source);

  try {
    const kinds = classifyCSharp(source);
    const newline = newlineOf(source);
    const edits: TextEdit[] = [];
    const keywords = [
      ...findAll(tree.rootNode, 'if_statement').flatMap((statement) => statement.children.filter((child) => child.type === 'else')),
      ...findAll(tree.rootNode, ['catch_clause', 'finally_clause']).map((clause) => clause.children[0]),
    ];

    for (const keyword of keywords) {
      const preference = wanted.get(keyword.type);
      if (!preference) {
        continue;
      }

      const previousEnd = previousTokenEnd(source, keyword.startIndex);
      if (source[previousEnd - 1] !== '}' || kinds[previousEnd - 1] !== CODE) {
        continue;
      }

      if (source.slice(previousEnd, keyword.startIndex).includes('\n') === (preference === 'true')) {
        continue;
      }

      // As in Roslyn, `try { A(); } catch { }` written on one line stays on one line.
      if (preference === 'true' && !source.slice(matchingOpenBrace(source, kinds, previousEnd - 1), previousEnd).includes('\n')) {
        continue;
      }

      edits.push({
        start: previousEnd,
        end: keyword.startIndex,
        text: preference === 'true' ? `${newline}${lineIndentAt(source, previousEnd - 1)}` : ' ',
      });
    }

    return applyEdits(source, edits);
  } finally {
    tree.delete();
  }
}

// ---------------------------------------------------------------------------------------------
// Core EditorConfig properties
// ---------------------------------------------------------------------------------------------

/**
 * `indent_style`: rewrites the leading whitespace of each line as tabs (`tab`) or spaces (`space`)
 * keeping its visual width (`tab_width`, else `indent_size`). Lines starting inside a string
 * literal or a block comment keep their whitespace.
 */
function applyIndentStyle(source: string, props: EditorConfigProperties): string {
  const style = optionValue(props, 'indent_style');
  if (style !== 'tab' && style !== 'space') {
    return source;
  }

  const width = tabWidth(props);
  const kinds = classifyCSharp(source);
  const edits: TextEdit[] = [];

  for (let lineStart = 0; lineStart < source.length; ) {
    let end = lineStart;
    while (source[end] === ' ' || source[end] === '\t') {
      end++;
    }

    if (end > lineStart && kinds[lineStart] === CODE && (lineStart === 0 || kinds[lineStart - 1] !== STRING)) {
      const indentation = source.slice(lineStart, end);
      const columns = visualWidth(indentation, width);
      const rewritten = style === 'space' ? ' '.repeat(columns) : '\t'.repeat(Math.floor(columns / width)) + ' '.repeat(columns % width);
      if (rewritten !== indentation) {
        edits.push({ start: lineStart, end, text: rewritten });
      }
    }

    const next = source.indexOf('\n', end);
    if (next < 0) {
      break;
    }

    lineStart = next + 1;
  }

  return applyEdits(source, edits);
}

function visualWidth(indentation: string, width: number): number {
  let columns = 0;
  for (const char of indentation) {
    columns = char === '\t' ? columns + width - (columns % width) : columns + 1;
  }

  return columns;
}

const LINE_BREAKS: Record<string, string> = { lf: '\n', crlf: '\r\n', cr: '\r' };

/** `end_of_line`: normalizes every line break outside string literals, reporting those left inside strings. */
function applyEndOfLine(source: string, props: EditorConfigProperties, report: EditorConfigIssueReporter): string {
  const target = LINE_BREAKS[optionValue(props, 'end_of_line') ?? ''];
  if (!target) {
    return source;
  }

  const kinds = classifyCSharp(source);
  let result = '';
  let copied = 0;
  let keptInString = -1;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char !== '\r' && char !== '\n') {
      continue;
    }

    const lineBreak = char === '\r' && source[i + 1] === '\n' ? '\r\n' : char;
    if (lineBreak !== target) {
      if (kinds[i] === STRING) {
        keptInString = keptInString < 0 ? i : keptInString;
      } else {
        result += source.slice(copied, i) + target;
        copied = i + lineBreak.length;
      }
    }

    i += lineBreak.length - 1;
  }

  if (keptInString >= 0) {
    report(
      describeIssue(
        'EditorConfig',
        'end_of_line',
        source,
        keptInString,
        'line breaks inside a multi-line string literal were kept; changing them would change the string.'
      )
    );
  }

  return copied === 0 ? source : result + source.slice(copied);
}

/** `insert_final_newline`: `true` ends the file with a line break, `false` removes trailing line breaks. */
function applyFinalNewline(source: string, props: EditorConfigProperties): string {
  const value = optionValue(props, 'insert_final_newline');
  if (value === 'false') {
    return source.replace(/(?:\r\n|\r|\n)+$/, '');
  }

  if (value !== 'true' || /[\r\n]$/.test(source)) {
    return source;
  }

  return source + (LINE_BREAKS[optionValue(props, 'end_of_line') ?? ''] ?? newlineOf(source));
}
