import { EditorConfigProperties } from '../editorconfig';
import { effectiveEditorConfigValue } from '../editorConfigRegistry';
import { Node, TextEdit, applyEdits, findAll, parseCSharp } from '../parser';
import { hasParseErrors } from './editorConfigSupport';
import { delegateParameterTypes } from './editorConfigExpressionPreferences';

/**
 * Statement-level code-style preferences. A group of statements is rewritten only when every
 * statement is fully parsed, no comment would be lost and each affected name is used only in the
 * ways the rewrite keeps meaning.
 */

type StatementRule = (source: string, block: Node, statements: readonly Node[], edits: TextEdit[]) => void;

interface PreferenceRule {
  readonly option: string;
  readonly apply: StatementRule;
}

export const STATEMENT_PREFERENCES: readonly PreferenceRule[] = [
  { option: 'csharp_style_throw_expression', apply: throwExpressions },
  { option: 'csharp_style_prefer_tuple_swap', apply: tupleSwaps },
  { option: 'csharp_style_prefer_local_over_anonymous_function', apply: localFunctions },
  { option: 'csharp_style_deconstructed_variable_declaration', apply: deconstructions },
];

/** Applies one preference when its option is `true` and enforced. */
export function applyStatementPreference(rule: PreferenceRule, source: string, props: EditorConfigProperties): string {
  if (effectiveEditorConfigValue(props, rule.option) !== 'true') {
    return source;
  }

  const tree = parseCSharp(source);

  try {
    const edits: TextEdit[] = [];
    for (const block of findAll(tree.rootNode, 'block')) {
      const statements = block.namedChildren.filter((child) => child.type !== 'comment' && !child.type.startsWith('preproc'));
      rule.apply(source, block, statements, edits);
    }

    return applyEdits(source, edits);
  } finally {
    tree.delete();
  }
}

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

function hasComment(source: string, start: number, end: number): boolean {
  const text = source.slice(start, end);

  return text.includes('//') || text.includes('/*') || /^\s*#/m.test(text);
}

/** The single declarator of a modifier-free local declaration. */
function singleLocal(statement: Node | undefined): { type: Node; declarator: Node; name: string; value?: Node } | undefined {
  if (statement?.type !== 'local_declaration_statement' || statement.namedChildren.some((child) => child.type === 'modifier')) {
    return undefined;
  }

  const declaration = statement.namedChildren.find((child) => child.type === 'variable_declaration');
  const declarators = declaration?.namedChildren.filter((child) => child.type === 'variable_declarator') ?? [];
  const type = declaration?.childForFieldName('type');
  const name = declarators[0]?.childForFieldName('name');
  if (declarators.length !== 1 || !type || name?.type !== 'identifier') {
    return undefined;
  }

  const clause = declarators[0].namedChildren.find((child) => child.type === 'equals_value_clause');

  return { type, declarator: declarators[0], name: name.text, value: clause?.namedChildren[0] };
}

/** `left = right` as an expression statement with the plain assignment operator. */
function simpleAssignment(statement: Node | undefined): { left: Node; right: Node } | undefined {
  const assignment = statement?.type === 'expression_statement' ? statement.namedChildren[0] : undefined;
  const left = assignment?.childForFieldName('left');
  const right = assignment?.childForFieldName('right');

  return assignment?.type === 'assignment_expression' && assignment.child(1)?.type === '=' && left && right
    ? { left, right }
    : undefined;
}

function isSimpleTarget(node: Node): boolean {
  if (node.type === 'identifier' || node.type === 'this_expression') {
    return true;
  }

  const receiver = node.childForFieldName('expression');

  return node.type === 'member_access_expression' && receiver !== null && isSimpleTarget(receiver);
}

/** Identifier occurrences named `name` inside `scope`, other than `except`. */
function occurrences(scope: Node, name: string, except: readonly Node[] = []): Node[] {
  return scope.descendantsOfType('identifier').filter((node) => node.text === name && !except.includes(node));
}

function isNameOfMemberAccess(identifier: Node): boolean {
  return identifier.parent?.type === 'member_access_expression' && identifier.parent.childForFieldName('name') === identifier;
}

// ---------------------------------------------------------------------------------------------
// IDE0016 csharp_style_throw_expression
// ---------------------------------------------------------------------------------------------

/** `if (x == null) throw e; target = x;` becomes `target = x ?? throw e;`. */
function throwExpressions(source: string, block: Node, statements: readonly Node[], edits: TextEdit[]): void {
  for (let i = 0; i + 1 < statements.length; i++) {
    const check = statements[i];
    const checked = nullCheckedIdentifier(check);
    const thrown = checked ? thrownExpression(check) : undefined;
    const assignment = simpleAssignment(statements[i + 1]);
    if (!checked || !thrown || !assignment || assignment.right.type !== 'identifier' || assignment.right.text !== checked) {
      continue;
    }

    if (!isLocalOrParameter(block, checked) || hasParseErrors(check) || hasComment(source, check.startIndex, statements[i + 1].startIndex)) {
      continue;
    }

    edits.push({ start: check.startIndex, end: statements[i + 1].startIndex, text: '' });
    edits.push({ start: assignment.right.startIndex, end: assignment.right.endIndex, text: `${checked} ?? throw ${thrown.text}` });
    i++;
  }
}

function nullCheckedIdentifier(statement: Node): string | undefined {
  if (statement.type !== 'if_statement' || statement.children.some((child) => child.type === 'else')) {
    return undefined;
  }

  const condition = statement.namedChildren[0];
  if (condition?.type === 'binary_expression' && condition.child(1)?.type === '==') {
    const left = condition.childForFieldName('left');
    const right = condition.childForFieldName('right');
    const checked = right?.type === 'null_literal' ? left : left?.type === 'null_literal' ? right : undefined;

    return checked?.type === 'identifier' ? checked.text : undefined;
  }

  if (condition?.type === 'is_pattern_expression' && condition.childForFieldName('pattern')?.text === 'null') {
    const checked = condition.childForFieldName('expression');

    return checked?.type === 'identifier' ? checked.text : undefined;
  }

  return undefined;
}

function thrownExpression(statement: Node): Node | undefined {
  let body: Node | undefined = statement.namedChildren[1];
  if (body?.type === 'block') {
    body = body.namedChildren.length === 1 ? body.namedChildren[0] : undefined;
  }

  return body?.type === 'throw_statement' ? body.namedChildren[0] : undefined;
}

/** True when a parameter or local of the enclosing member is named `name`. */
function isLocalOrParameter(block: Node, name: string): boolean {
  for (let current: Node | null = block; current; current = current.parent) {
    if (/_declaration$/.test(current.type) || current.type === 'local_function_statement' || current.type === 'lambda_expression') {
      return current
        .descendantsOfType(['parameter', 'variable_declarator'])
        .some((node) => node.childForFieldName('name')?.text === name);
    }
  }

  return false;
}

// ---------------------------------------------------------------------------------------------
// IDE0180 csharp_style_prefer_tuple_swap
// ---------------------------------------------------------------------------------------------

/** `var t = a; a = b; b = t;` becomes `(a, b) = (b, a);` when `t` is used nowhere else. */
function tupleSwaps(source: string, block: Node, statements: readonly Node[], edits: TextEdit[]): void {
  for (let i = 0; i + 2 < statements.length; i++) {
    const temp = singleLocal(statements[i]);
    const first = simpleAssignment(statements[i + 1]);
    const second = simpleAssignment(statements[i + 2]);
    if (!temp?.value || !first || !second) {
      continue;
    }

    const a = temp.value;
    const b = first.right;
    const swaps =
      isSimpleTarget(a) &&
      isSimpleTarget(b) &&
      a.text !== b.text &&
      first.left.text === a.text &&
      second.left.text === b.text &&
      second.right.type === 'identifier' &&
      second.right.text === temp.name;
    const tempName = temp.declarator.childForFieldName('name')!;
    if (!swaps || occurrences(block, temp.name, [tempName, second.right]).length > 0) {
      continue;
    }

    const end = statements[i + 2].endIndex;
    if (hasComment(source, statements[i].startIndex, end) || statements.slice(i, i + 3).some(hasParseErrors)) {
      continue;
    }

    edits.push({ start: statements[i].startIndex, end, text: `(${a.text}, ${b.text}) = (${b.text}, ${a.text});` });
    i += 2;
  }
}

// ---------------------------------------------------------------------------------------------
// IDE0039 csharp_style_prefer_local_over_anonymous_function
// ---------------------------------------------------------------------------------------------

/** `Func<int, int> f = x => x + 1;` becomes `int f(int x) => x + 1;` when `f` is only called. */
function localFunctions(source: string, block: Node, statements: readonly Node[], edits: TextEdit[]): void {
  for (const statement of statements) {
    const local = singleLocal(statement);
    const lambda = local?.value;
    const parameterTypes = delegateParameterTypes(local?.type);
    if (!local || lambda?.type !== 'lambda_expression' || !parameterTypes || hasParseErrors(statement)) {
      continue;
    }

    const isAsyncOrStatic = /\b(?:async|static)\s*$/.test(source.slice(local.declarator.startIndex, lambda.startIndex));
    const parameters = lambdaParameters(lambda);
    const body = lambda.childForFieldName('body');
    if (isAsyncOrStatic || !parameters || !body || parameters.length !== parameterTypes.length) {
      continue;
    }

    const names = parameters.map((parameter) => parameter.name);
    const nameNode = local.declarator.childForFieldName('name')!;
    const onlyCalled = occurrences(block, local.name, [nameNode]).every(
      (use) => use.parent?.type === 'invocation_expression' && use.parent.childForFieldName('function') === use
    );
    const redeclared = block
      .descendantsOfType(['variable_declarator', 'parameter', 'local_function_statement'])
      .some((node) => node !== local.declarator && node.childForFieldName('name')?.text === local.name);
    if (!onlyCalled || redeclared || new Set(names).size !== names.length || hasComment(source, statement.startIndex, lambda.startIndex)) {
      continue;
    }

    const typeArgs = local.type.namedChildren.find((child) => child.type === 'type_argument_list')?.namedChildren ?? [];
    const returnType = local.type.namedChildren[0]?.text === 'Func' ? typeArgs[typeArgs.length - 1].text : 'void';
    const signature = parameters.map((parameter, index) => `${parameter.type ?? parameterTypes[index]} ${parameter.name}`).join(', ');
    const bodyText = body.type === 'block' ? body.text : `=> ${body.text};`;

    edits.push({ start: statement.startIndex, end: statement.endIndex, text: `${returnType} ${local.name}(${signature}) ${bodyText}` });
  }
}

/** The lambda's parameters with their explicit types, or `undefined` when one has a modifier. */
function lambdaParameters(lambda: Node): { name: string; type?: string }[] | undefined {
  const list = lambda.childForFieldName('parameters');
  if (list?.type === 'identifier') {
    return [{ name: list.text }];
  }

  const parameters: { name: string; type?: string }[] = [];
  for (const parameter of list?.namedChildren.filter((child) => child.type === 'parameter') ?? []) {
    const name = parameter.childForFieldName('name');
    const type = parameter.childForFieldName('type');
    if (!name || parameter.children.length !== (type ? 2 : 1)) {
      return undefined;
    }

    parameters.push({ name: name.text, type: type?.text });
  }

  return list ? parameters : undefined;
}

// ---------------------------------------------------------------------------------------------
// IDE0042 csharp_style_deconstructed_variable_declaration
// ---------------------------------------------------------------------------------------------

/**
 * `var point = (x: 1, y: 2);` becomes `var (x, y) = (1, 2);` and `(int x, int y) point = Get();`
 * becomes `(int x, int y) = Get();` when the variable is only used through its element names and
 * those names are not used for anything else in the member.
 */
function deconstructions(source: string, block: Node, statements: readonly Node[], edits: TextEdit[]): void {
  for (const statement of statements) {
    const local = singleLocal(statement);
    if (!local?.value || hasParseErrors(statement)) {
      continue;
    }

    const literal = local.type.type === 'implicit_type' && local.value.type === 'tuple_expression' ? tupleElements(local.value) : undefined;
    const typed = local.type.type === 'tuple_type' ? tupleElements(local.type) : undefined;
    const elements = literal ?? typed;
    const names = elements?.map((element) => element.name);
    if (!elements || !names || names.some((name) => name === undefined) || new Set(names).size !== names.length) {
      continue;
    }

    const nameNode = local.declarator.childForFieldName('name')!;
    const uses = occurrences(block, local.name, [nameNode]);
    const usedByName = uses.every((use) => {
      const access = use.parent;

      return access?.type === 'member_access_expression' && access.childForFieldName('expression') === use && names.includes(access.childForFieldName('name')?.text);
    });

    const member = enclosingMember(block);
    const elementNameNodes = elements.map((element) => element.nameNode!);
    const clash = (names as string[]).some((name) =>
      occurrences(member, name, elementNameNodes).some((node) => !isNameOfMemberAccess(node))
    );
    if (!usedByName || clash || hasComment(source, statement.startIndex, statement.endIndex)) {
      continue;
    }

    if (literal) {
      edits.push({ start: local.type.startIndex, end: nameNode.endIndex, text: `var (${names.join(', ')})` });
      for (const element of literal) {
        edits.push({ start: element.nameNode!.startIndex, end: element.value.startIndex, text: '' });
      }
    } else {
      edits.push({ start: local.type.startIndex, end: nameNode.endIndex, text: local.type.text });
    }

    for (const use of uses) {
      const access = use.parent!;
      edits.push({ start: access.startIndex, end: access.endIndex, text: access.childForFieldName('name')!.text });
    }
  }
}

interface TupleElement {
  readonly name?: string;
  readonly nameNode?: Node;
  /** The element's value (tuple literal) or type (tuple type). */
  readonly value: Node;
}

/** The elements of a tuple literal (`(x: 1, 2)`) or tuple type (`(int x, int)`). */
function tupleElements(tuple: Node): TupleElement[] | undefined {
  const elements: TupleElement[] = [];
  let parts: Node[] = [];
  const flush = (): boolean => {
    const named = tuple.type === 'tuple_expression' ? parts.length === 3 && parts[1].type === ':' : parts.length === 2;
    if (named && parts[tuple.type === 'tuple_expression' ? 0 : 1].type === 'identifier') {
      const nameNode = tuple.type === 'tuple_expression' ? parts[0] : parts[1];
      elements.push({ name: nameNode.text, nameNode, value: tuple.type === 'tuple_expression' ? parts[2] : parts[0] });
    } else if (parts.length === 1) {
      elements.push({ value: parts[0] });
    } else {
      return false;
    }

    parts = [];

    return true;
  };

  for (const child of tuple.children.slice(1, -1)) {
    if (child.type === ',') {
      if (!flush()) {
        return undefined;
      }
    } else {
      parts.push(child);
    }
  }

  return flush() && elements.length > 1 ? elements : undefined;
}

function enclosingMember(node: Node): Node {
  let member = node;
  for (let current: Node | null = node; current; current = current.parent) {
    member = current;
    if (/_declaration$/.test(current.type) && current.type !== 'variable_declaration') {
      break;
    }
  }

  return member;
}
