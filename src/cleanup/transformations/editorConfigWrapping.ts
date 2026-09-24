import { EditorConfigProperties, splitOptionSeverity } from '../editorconfig';
import { Node, TextEdit, applyEdits, findAll, parseCSharp } from '../parser';
import { isRecoveredNode, lineIndentAt, lineStartAt, newlineOf } from './editorConfigSupport';

/**
 * The C# formatting options that move code onto new lines, applied as Roslyn's formatter applies
 * them: `csharp_preserve_single_line_blocks`, `csharp_preserve_single_line_statements`,
 * `csharp_new_line_before_members_in_object_initializers`,
 * `csharp_new_line_before_members_in_anonymous_types` and
 * `csharp_new_line_between_query_expression_clauses` (see `applyQueryClauseNewLines`). Only line breaks are inserted, and only in
 * gaps holding nothing but spaces: a comment keeps the code around it on one line. The new lines
 * get their final indentation from the indentation pass that follows.
 */

function optionValue(props: EditorConfigProperties, key: string): string | undefined {
  const raw = props.get(key);

  return raw === undefined ? undefined : splitOptionSeverity(raw).value.toLowerCase();
}

export function applyWrapping(source: string, props: EditorConfigProperties): string {
  let current = source;
  if (optionValue(props, 'csharp_preserve_single_line_blocks') === 'false') {
    current = withTree(current, expandSingleLineBlocks);
  }

  if (optionValue(props, 'csharp_preserve_single_line_statements') === 'false') {
    current = withTree(current, splitStatements);
  }

  const objectMembers = optionValue(props, 'csharp_new_line_before_members_in_object_initializers') === 'true';
  const anonymousMembers = optionValue(props, 'csharp_new_line_before_members_in_anonymous_types') === 'true';
  if (objectMembers || anonymousMembers) {
    current = withTree(current, (text, root) => splitInitializerMembers(text, root, objectMembers, anonymousMembers));
  }

  return current;
}

/**
 * `csharp_new_line_between_query_expression_clauses`: runs after spacing, as clauses line up with
 * the column of the first `from`.
 */
export function applyQueryClauseNewLines(source: string, props: EditorConfigProperties): string {
  return optionValue(props, 'csharp_new_line_between_query_expression_clauses') === 'true' ? withTree(source, splitQueryClauses) : source;
}

function withTree(source: string, edit: (source: string, root: Node) => TextEdit[]): string {
  const tree = parseCSharp(source);

  try {
    return applyEdits(source, edit(source, tree.rootNode));
  } finally {
    tree.delete();
  }
}

/** A line break (indented like the line at `indentFrom`) replacing a gap of plain spaces on one line. */
function breakGap(source: string, start: number, end: number, indentFrom: number, edits: TextEdit[]): void {
  if (end > start ? /^[ \t]*$/.test(source.slice(start, end)) : end === start) {
    edits.push({ start, end, text: `${newlineOf(source)}${lineIndentAt(source, indentFrom)}` });
  }
}

function sameLine(source: string, start: number, end: number): boolean {
  return !source.slice(start, end).includes('\n');
}

function lastToken(node: Node): Node {
  let last = node;
  while (last.children.length > 0) {
    last = last.children[last.children.length - 1];
  }

  return last;
}

// ---------------------------------------------------------------------------------------------
// csharp_preserve_single_line_blocks = false
// ---------------------------------------------------------------------------------------------

const EXPANDED_BLOCK_OWNERS: Record<string, true> = {
  method_declaration: true,
  constructor_declaration: true,
  destructor_declaration: true,
  operator_declaration: true,
  conversion_operator_declaration: true,
  local_function_statement: true,
  anonymous_method_expression: true,
  block: true,
  switch_body: true,
  if_statement: true,
  while_statement: true,
  for_statement: true,
  for_each_statement: true,
  do_statement: true,
  using_statement: true,
  lock_statement: true,
  fixed_statement: true,
  try_statement: true,
  checked_statement: true,
  unchecked_statement: true,
  unsafe_statement: true,
};

/**
 * Which single-line `{ }` constructs Roslyn expands: bodies of members, local functions,
 * anonymous methods and statements (lambda bodies, empty `catch`/`finally` blocks and event
 * accessors stay on one line), type and enum bodies, property and indexer accessor lists, `switch`
 * statements and anonymous objects. Object, collection and array initializers are never expanded.
 */
function isExpandable(container: Node): boolean {
  const owner = container.parent;
  switch (container.type) {
    case 'block': {
      if (!owner) {
        return false;
      }

      if (owner.type === 'catch_clause' || owner.type === 'finally_clause') {
        return container.namedChildren.some((child) => child.type !== 'comment');
      }

      if (owner.type === 'accessor_declaration') {
        return owner.parent?.parent?.type !== 'event_declaration';
      }

      return EXPANDED_BLOCK_OWNERS[owner.type] === true;
    }
    case 'declaration_list':
    case 'enum_member_declaration_list':
      return true;
    case 'accessor_list':
      // An auto-property with an initializer (`{ get; set; } = 4;`) stays on one line, as in Roslyn.
      return owner?.type === 'indexer_declaration' || (owner?.type === 'property_declaration' && !owner.childForFieldName('value'));
    case 'switch_body':
      return owner?.type === 'switch_statement';
    case 'initializer_expression':
      return owner?.type === 'anonymous_object_creation_expression';
    default:
      return false;
  }
}

function expandSingleLineBlocks(source: string, root: Node): TextEdit[] {
  const edits: TextEdit[] = [];
  for (const container of findAll(root, ['block', 'declaration_list', 'enum_member_declaration_list', 'accessor_list', 'switch_body', 'initializer_expression'])) {
    const open = container.children[0];
    const close = container.children[container.children.length - 1];
    if (open?.type !== '{' || close?.type !== '}' || !sameLine(source, open.startIndex, close.endIndex) || !isExpandable(container) || isRecoveredNode(container)) {
      continue;
    }

    const inner = container.children.slice(1, -1);
    if (inner.some((child) => child.type === 'comment')) {
      continue;
    }

    if (inner.length === 0) {
      breakGap(source, open.endIndex, close.startIndex, open.startIndex, edits);
      continue;
    }

    breakGap(source, open.endIndex, inner[0].startIndex, open.startIndex, edits);
    breakGap(source, lastToken(inner[inner.length - 1]).endIndex, close.startIndex, open.startIndex, edits);
  }

  return edits;
}

// ---------------------------------------------------------------------------------------------
// csharp_preserve_single_line_statements = false
// ---------------------------------------------------------------------------------------------

const EMBEDDING: Record<string, true> = {
  if_statement: true,
  while_statement: true,
  for_statement: true,
  for_each_statement: true,
  using_statement: true,
  lock_statement: true,
  fixed_statement: true,
  do_statement: true,
};

function isStatement(node: Node): boolean {
  return node.isNamed && node.type !== 'comment' && !node.type.startsWith('preproc') && (node.type.endsWith('_statement') || node.type === 'block');
}

function splitStatements(source: string, root: Node): TextEdit[] {
  const edits: TextEdit[] = [];

  // Statements (and a statement after a label) sharing a line in a block or a switch section.
  for (const container of findAll(root, ['block', 'switch_body'])) {
    if (isRecoveredNode(container)) {
      continue;
    }

    let previousEnd: number | undefined;
    for (const child of container.children.slice(1, -1)) {
      if (child.type === 'comment' || child.type.startsWith('preproc')) {
        previousEnd = undefined;
        continue;
      }

      if (container.type === 'switch_body' && child.type === ':') {
        previousEnd = child.endIndex;
        continue;
      }

      if (!isStatement(child)) {
        previousEnd = undefined;
        continue;
      }

      if (previousEnd !== undefined && sameLine(source, previousEnd, child.startIndex)) {
        breakGap(source, previousEnd, child.startIndex, lineStartAt(source, previousEnd), edits);
      }

      previousEnd = isRecoveredNode(child) ? undefined : lastToken(child).endIndex;
    }
  }

  // Embedded statements (`if (x) A();`), `else` after them, and `while` after a `do` body.
  for (const statement of findAll(root, Object.keys(EMBEDDING))) {
    if (isRecoveredNode(statement)) {
      continue;
    }

    const children = statement.children;
    children.forEach((child, index) => {
      const previous = children[index - 1];
      if (!previous) {
        return;
      }

      const embedded =
        isStatement(child) &&
        child.type !== 'block' &&
        (previous.type === ')' || previous.type === 'do' || (previous.type === 'else' && child.type !== 'if_statement'));
      const keywordAfterBody = (child.type === 'else' || (child.type === 'while' && statement.type === 'do_statement')) && lastToken(previous).type === ';';
      if ((embedded || keywordAfterBody) && sameLine(source, previous.endIndex, child.startIndex)) {
        breakGap(source, lastToken(previous).endIndex, child.startIndex, statement.startIndex, edits);
      }
    });
  }

  return edits;
}

// ---------------------------------------------------------------------------------------------
// csharp_new_line_before_members_in_object_initializers / _anonymous_types
// ---------------------------------------------------------------------------------------------

function splitInitializerMembers(source: string, root: Node, objects: boolean, anonymous: boolean): TextEdit[] {
  const edits: TextEdit[] = [];
  for (const initializer of findAll(root, 'initializer_expression')) {
    const owner = initializer.parent?.type;
    const items = initializer.namedChildren.filter((child) => child.type !== 'comment');
    const isAnonymous = owner === 'anonymous_object_creation_expression';
    const isObject =
      (owner === 'object_creation_expression' || owner === 'implicit_object_creation_expression') &&
      items.length > 0 &&
      items.every((item) => item.type === 'assignment_expression');
    const open = initializer.children[0];
    const close = initializer.children[initializer.children.length - 1];
    if (!(isAnonymous ? anonymous : isObject && objects) || open?.type !== '{' || close?.type !== '}' || sameLine(source, open.startIndex, close.endIndex)) {
      continue;
    }

    // Each member, and the closing brace, on a line of its own.
    if (items.length > 0 && sameLine(source, open.endIndex, items[0].startIndex)) {
      breakGap(source, open.endIndex, items[0].startIndex, open.startIndex, edits);
    }

    for (const comma of initializer.children.filter((child) => child.type === ',')) {
      const next = items.find((item) => item.startIndex >= comma.endIndex);
      if (next && sameLine(source, comma.endIndex, next.startIndex)) {
        breakGap(source, comma.endIndex, next.startIndex, next.startIndex, edits);
      }
    }

    const beforeClose = lastToken(initializer.children[initializer.children.length - 2]);
    if (items.length > 0 && beforeClose !== open && sameLine(source, beforeClose.endIndex, close.startIndex)) {
      breakGap(source, beforeClose.endIndex, close.startIndex, open.startIndex, edits);
    }
  }

  return edits;
}

// ---------------------------------------------------------------------------------------------
// csharp_new_line_between_query_expression_clauses = true
// ---------------------------------------------------------------------------------------------

function splitQueryClauses(source: string, root: Node): TextEdit[] {
  const edits: TextEdit[] = [];
  for (const query of findAll(root, 'query_expression')) {
    if (sameLine(source, query.startIndex, query.endIndex) || isRecoveredNode(query)) {
      continue;
    }

    const clauses = query.namedChildren.filter((child) => child.type !== 'comment' && child.type !== 'query_continuation');
    const first = clauses[0];
    if (!first) {
      continue;
    }

    // Clauses line up with the first `from`.
    const lineStart = lineStartAt(source, first.startIndex);
    const alignment = source.slice(lineStart, first.startIndex).replace(/[^\t]/g, ' ');
    for (let index = 1; index < clauses.length; index++) {
      const previousEnd = lastToken(clauses[index - 1]).endIndex;
      const clauseStart = clauses[index].startIndex;
      const gap = source.slice(previousEnd, clauseStart);
      if (!gap.includes('\n') && /^[ \t]*$/.test(gap)) {
        edits.push({ start: previousEnd, end: clauseStart, text: `${newlineOf(source)}${alignment}` });
      } else if (/^[ \t]*$/.test(source.slice(lineStartAt(source, clauseStart), clauseStart))) {
        // A clause already on its own line is aligned too.
        edits.push({ start: lineStartAt(source, clauseStart), end: clauseStart, text: alignment });
      }
    }
  }

  return edits;
}
