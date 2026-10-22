import { CODE, STRING, classifyCSharp } from './scanner';
import { Node, TextEdit, applyEdits, findAll, parseCSharp } from './parser';
import { FormattingOptions, lineIndentAt, newlineOf, optionValue, parseErrorCount, tabWidth } from './formattingSupport';
import { applyIndentation } from './indentation';
import { applySpacing } from './spacing';
import { applyQueryClauseNewLines, applyWrapping } from './wrapping';

/**
 * Whitespace-only C# formatting with the `.editorconfig` C# formatting options (`csharp_new_line_*`,
 * `csharp_space_*`, `csharp_indent_*`, `csharp_preserve_*`) and `indent_style`. String literals and
 * comment text are never changed, and a result the parser reads worse than the input is dropped.
 */
export function formatCSharp(source: string, props: FormattingOptions): string {
  let formatted = applyWrapping(source, props);
  formatted = applyOpenBraceNewLines(formatted, props);
  formatted = applyNewLinesBeforeKeywords(formatted, props);
  formatted = applySpacing(formatted, props);
  formatted = applyQueryClauseNewLines(formatted, props);
  formatted = applyIndentation(formatted, props);

  return applyIndentStyle(parseErrorCount(formatted) > parseErrorCount(source) ? source : formatted, props);
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

    case 'initializer_expression': {
      if (owner.type === 'anonymous_object_creation_expression') {
        return 'anonymous_types';
      }

      // As dotnet format does, only the object initializer of a creation (`new T {`, `new() {`) or of
      // `with {` moves. Array, collection (`new List<int> { 1 }`), nested (`Inner = {`) and element
      // (`{ 1, 2 }` of a dictionary) initializers keep their brace where it is.
      const isObjectInitializer = container.namedChildren.every((item) => item.type === 'assignment_expression' || item.type === 'comment');
      const isCreation =
        owner.type === 'object_creation_expression' || owner.type === 'implicit_object_creation_expression' || owner.type === 'with_expression';

      return isCreation && isObjectInitializer ? 'object_collection_array_initializers' : undefined;
    }

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

function applyOpenBraceNewLines(source: string, props: FormattingOptions): string {
  const value = optionValue(props, 'csharp_new_line_before_open_brace');
  if (value === undefined) {
    return source;
  }

  const wanted = new Set(value.split(',').map((kind) => kind.trim()));
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

      // A comment or directive before the brace keeps it where it is.
      if (!endsInCode(source, kinds, previousEnd)) {
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

function applyNewLinesBeforeKeywords(source: string, props: FormattingOptions): string {
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
// indent_style
// ---------------------------------------------------------------------------------------------

/**
 * `indent_style`: rewrites the leading whitespace of each line as tabs (`tab`) or spaces (`space`)
 * keeping its visual width (`tab_width`, else `indent_size`). Lines starting inside a string
 * literal or a block comment keep their whitespace.
 */
function applyIndentStyle(source: string, props: FormattingOptions): string {
  const style = optionValue(props, 'indent_style');
  if (style !== 'tab' && style !== 'space') {
    return source;
  }

  const width = tabWidth(props);
  const kinds = classifyCSharp(source);
  const edits: TextEdit[] = [];

  for (let lineStart = 0; lineStart < source.length;) {
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
