import { EditorConfigProperties } from '../editorconfig';
import { effectiveEditorConfigValue, enforcedOptionValue } from '../editorConfigRegistry';
import { Node, TextEdit, applyEdits, findAll, parseCSharp } from '../parser';
import { RELATIONAL, UNARY, nullTest, operatorOf, precedenceOf, unparenthesized, withParentheses } from './editorConfigPrecedence';
import { hasParseErrors, lineEndAt, lineIndentAt, lineStartAt, newlineOf } from './editorConfigSupport';
import { isPlainNullComparison } from './typeFacts';
import { delegateParameterTypes, subjectTypeText } from './editorConfigExpressionPreferences';

/**
 * Statement-level code-style preferences. A group of statements is rewritten only when every
 * statement is fully parsed, no comment would be lost and each affected name is used only in the
 * ways the rewrite keeps meaning.
 */

interface StatementContext {
  readonly props: EditorConfigProperties;
  /** One indentation level for code the rule creates. */
  readonly indent: string;
}

/** Collects the edits for the statements of one block. */
type StatementRule = (source: string, block: Node, statements: readonly Node[], edits: TextEdit[], context: StatementContext) => void;

interface PreferenceRule {
  readonly option: string;
  readonly apply: StatementRule;
}

export const STATEMENT_PREFERENCES: readonly PreferenceRule[] = [
  { option: 'csharp_style_throw_expression', apply: throwExpressions },
  { option: 'csharp_style_prefer_tuple_swap', apply: tupleSwaps },
  { option: 'csharp_style_prefer_local_over_anonymous_function', apply: localFunctions },
  { option: 'csharp_style_deconstructed_variable_declaration', apply: deconstructions },
  { option: 'dotnet_style_prefer_conditional_expression_over_assignment', apply: conditionalAssignments },
  { option: 'dotnet_style_prefer_conditional_expression_over_return', apply: conditionalReturns },
  { option: 'dotnet_style_object_initializer', apply: objectInitializers },
  { option: 'dotnet_style_collection_initializer', apply: collectionInitializers },
  { option: 'csharp_style_prefer_switch_expression', apply: switchExpressions },
  { option: 'csharp_style_pattern_matching_over_as_with_null_check', apply: asWithNullCheckPatterns },
  { option: 'csharp_style_pattern_matching_over_is_with_cast_check', apply: isWithCastPatterns },
];

/** Rewrites of one rule in a row: an `if`/`return` chain folds one statement per rewrite. */
const MAX_REWRITES = 16;

/** Applies one preference when its option is `true` and enforced, again while it changes the code. */
export function applyStatementPreference(rule: PreferenceRule, source: string, props: EditorConfigProperties, indent: string): string {
  if (effectiveEditorConfigValue(props, rule.option) !== 'true') {
    return source;
  }

  let current = source;
  for (let rewrite = 0; rewrite < MAX_REWRITES; rewrite++) {
    const tree = parseCSharp(current);
    let edits: TextEdit[];
    try {
      edits = [];
      for (const block of findAll(tree.rootNode, 'block')) {
        const statements = block.namedChildren.filter((child) => child.type !== 'comment' && !child.type.startsWith('preproc'));
        rule.apply(current, block, statements, edits, { props, indent });
      }
    } finally {
      tree.delete();
    }

    const next = applyEdits(current, edits);
    if (next === current) {
      break;
    }

    current = next;
  }

  return current;
}

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

export function hasComment(source: string, start: number, end: number): boolean {
  const text = source.slice(start, end);

  return text.includes('//') || text.includes('/*') || /^\s*#/m.test(text);
}

/** The single declarator of a modifier-free local declaration. */
export function singleLocal(statement: Node | undefined): { type: Node; declarator: Node; name: string; value?: Node } | undefined {
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
export function simpleAssignment(statement: Node | undefined): { left: Node; right: Node } | undefined {
  const assignment = statement?.type === 'expression_statement' ? statement.namedChildren[0] : undefined;
  const left = assignment?.childForFieldName('left');
  const right = assignment?.childForFieldName('right');

  return assignment?.type === 'assignment_expression' && assignment.child(1)?.type === '=' && left && right
    ? { left, right }
    : undefined;
}

export function isSimpleTarget(node: Node): boolean {
  if (node.type === 'identifier' || node.type === 'this_expression') {
    return true;
  }

  const receiver = node.childForFieldName('expression');

  return node.type === 'member_access_expression' && receiver !== null && isSimpleTarget(receiver);
}

/** Identifier occurrences named `name` inside `scope`, other than `except`. */
export function occurrences(scope: Node, name: string, except: readonly Node[] = []): Node[] {
  return scope.descendantsOfType('identifier').filter((node) => node.text === name && !except.includes(node));
}

export function isNameOfMemberAccess(identifier: Node): boolean {
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
    let root: Node = statement;
    while (root.parent) {
      root = root.parent;
    }

    // `??` never calls a user-defined `==`, so `x == null` must be a plain null check.
    return checked?.type === 'identifier' && isPlainNullComparison(checked, root) ? checked.text : undefined;
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
export function tupleElements(tuple: Node): TupleElement[] | undefined {
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

export function enclosingMember(node: Node): Node {
  let member = node;
  for (let current: Node | null = node; current; current = current.parent) {
    member = current;
    if (/_declaration$/.test(current.type) && current.type !== 'variable_declaration') {
      break;
    }
  }

  return member;
}

// ---------------------------------------------------------------------------------------------
// IDE0045 / IDE0046 dotnet_style_prefer_conditional_expression_over_assignment / _over_return
// ---------------------------------------------------------------------------------------------

/**
 * Types for which `c ? a : b` converts to the target exactly as `a` and `b` do on their own: the
 * conditional's natural type widens integers losslessly, and `bool`/`string` have no conversions
 * to choose from. (Floating point could round through `float`, small integers and `object`
 * change type or boxing, so they are left alone.)
 */
const CONDITIONAL_TARGET_TYPES = /^(?:bool|Boolean|int|Int32|long|Int64|decimal|Decimal|string|String)\??$/;

/** The only statement of `node`: the statement itself or the single statement of a block. */
function soleStatement(node: Node | undefined): Node | undefined {
  return node?.type === 'block' ? (node.namedChildCount === 1 ? node.namedChildren[0] : undefined) : node;
}

/** `if (c) <then> else <else>` with both branches present and no `else if`. */
function ifElse(statement: Node): { condition: Node; whenTrue: Node; whenFalse?: Node } | undefined {
  const [condition, whenTrue, whenFalse] = statement.namedChildren;
  const branch = soleStatement(whenTrue);
  const other = whenFalse ? soleStatement(whenFalse) : undefined;
  if (statement.type !== 'if_statement' || !condition || !branch || (whenFalse && (!other || other.type === 'if_statement')) || statement.namedChildCount > 3) {
    return undefined;
  }

  return { condition, whenTrue: branch, whenFalse: other };
}

const BOOLEAN_TARGET = /^(?:bool|Boolean)$/;

/**
 * `c ? a : b`, parenthesizing parts that would otherwise bind differently, or `undefined` when a
 * branch is a conditional itself: nested conditionals read worse than the statements. For a
 * `bool` target, `true`/`false` branches give `c`, `!c`, `c || b`, `c && a` (and negated forms)
 * instead: the condition of an `if` and the values of a `bool` target are `bool`.
 */
function conditionalText(condition: Node, whenTrue: Node, whenFalse: Node, targetType: string): string | undefined {
  if (whenTrue.type === 'conditional_expression' || whenFalse.type === 'conditional_expression') {
    return undefined;
  }

  const literal = (node: Node): string | undefined => (unparenthesized(node).type === 'boolean_literal' ? unparenthesized(node).text : undefined);
  const [t, f] = [literal(whenTrue), literal(whenFalse)];
  if (BOOLEAN_TARGET.test(targetType) && (t !== undefined || f !== undefined)) {
    const plain = (node: Node, level: number): string => withParentheses(node.text, precedenceOf(node), level);
    const negated = `!${plain(condition, UNARY)}`;
    if (t !== undefined && f !== undefined) {
      return t === f ? undefined : t === 'true' ? condition.text : negated;
    }

    // c ? true : b -> c || b;  c ? false : b -> !c && b;  c ? a : false -> c && a;  c ? a : true -> !c || a
    const other = t !== undefined ? whenFalse : whenTrue;
    const or = (t ?? f) === 'true';
    const negate = t !== undefined ? t === 'false' : f === 'true';
    const level = or ? 3 : 4;

    return `${negate ? negated : plain(condition, level)} ${or ? '||' : '&&'} ${plain(other, level + 1)}`;
  }

  const part = (node: Node, level: number): string => withParentheses(node.text, precedenceOf(node), level);

  return `${part(condition, 2)} ? ${part(whenTrue, 1)} : ${part(whenFalse, 1)}`;
}

/**
 * `if (c) x = a; else x = b;` becomes `x = c ? a : b;`, and `T x; if (c) x = a; else x = b;`
 * becomes `T x = c ? a : b;`, when the type of `x` is one the conditional cannot change.
 */
function conditionalAssignments(source: string, _block: Node, statements: readonly Node[], edits: TextEdit[]): void {
  statements.forEach((statement, index) => {
    const parts = ifElse(statement);
    const first = simpleAssignment(parts?.whenTrue);
    const second = simpleAssignment(parts?.whenFalse);
    if (!parts || !first || !second || !isSimpleTarget(first.left) || first.left.text.replace(/\s+/g, '') !== second.left.text.replace(/\s+/g, '')) {
      return;
    }

    const declaration = singleLocal(statements[index - 1]);
    const declares = declaration !== undefined && !declaration.value && first.left.type === 'identifier' && declaration.name === first.left.text;
    const type = (declares ? declaration.type.text : subjectTypeText(first.left) ?? '').replace(/\s+/g, '');
    const text = conditionalText(parts.condition, first.right, second.right, type);
    if (
      text === undefined ||
      text.includes('\n') ||
      !CONDITIONAL_TARGET_TYPES.test(type) ||
      hasParseErrors(statement) ||
      hasComment(source, statement.startIndex, statement.endIndex)
    ) {
      return;
    }

    if (declares) {
      edits.push({ start: declaration.declarator.endIndex, end: statement.endIndex, text: ` = ${text};` });
    } else {
      edits.push({ start: statement.startIndex, end: statement.endIndex, text: `${first.left.text} = ${text};` });
    }
  });
}

/** The declared return type of the member or local function `node` returns from. */
export function returnType(node: Node): string | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === 'lambda_expression' || current.type === 'anonymous_method_expression' || current.type === 'accessor_declaration') {
      return undefined;
    }

    if (current.type === 'method_declaration' || current.type === 'local_function_statement' || current.type === 'operator_declaration') {
      const type = current.childForFieldName('type')?.text.replace(/\s+/g, '') ?? '';
      const isAsync = current.namedChildren.some((child) => child.type === 'modifier' && child.text === 'async');

      return isAsync ? /^(?:System\.Threading\.Tasks\.)?(?:Task|ValueTask)<(.+)>$/.exec(type)?.[1] : type;
    }
  }

  return undefined;
}

function returnedValue(statement: Node | undefined): Node | undefined {
  return statement?.type === 'return_statement' && statement.namedChildCount === 1 ? statement.namedChildren[0] : undefined;
}

/**
 * `if (c) return a; else return b;` and `if (c) return a; return b;` become `return c ? a : b;`
 * when the return type is one the conditional cannot change.
 */
function conditionalReturns(source: string, _block: Node, statements: readonly Node[], edits: TextEdit[]): void {
  for (let i = 0; i < statements.length; i++) {
    const parts = ifElse(statements[i]);
    const first = returnedValue(parts?.whenTrue);
    const next = parts && !parts.whenFalse ? statements[i + 1] : undefined;
    const second = returnedValue(parts?.whenFalse ?? next);
    const type = parts ? returnType(statements[i]) ?? '' : '';
    if (!parts || !first || !second || !CONDITIONAL_TARGET_TYPES.test(type)) {
      continue;
    }

    const end = (next ?? statements[i]).endIndex;
    const text = conditionalText(parts.condition, first, second, type);
    if (text === undefined || text.includes('\n') || hasParseErrors(statements[i]) || (next && hasParseErrors(next)) || hasComment(source, statements[i].startIndex, end)) {
      continue;
    }

    edits.push({ start: statements[i].startIndex, end, text: `return ${text};` });
    i += next ? 1 : 0;
  }
}

// ---------------------------------------------------------------------------------------------
// IDE0017 / IDE0028 dotnet_style_object_initializer / dotnet_style_collection_initializer
// ---------------------------------------------------------------------------------------------

/** `var x = new T(...);` without an initializer. */
function createdLocal(statement: Node | undefined): { name: string; creation: Node } | undefined {
  const local = singleLocal(statement);
  const creation = local?.value;
  const isCreation = creation?.type === 'object_creation_expression' || creation?.type === 'implicit_object_creation_expression';
  if (!local || !creation || !isCreation || creation.namedChildren.some((child) => child.type === 'initializer_expression')) {
    return undefined;
  }

  return { name: local.name, creation };
}

/** Replaces the creation of `local` and the statements after it with an initializer of `elements`. */
function initializerEdit(source: string, local: { creation: Node }, statements: readonly Node[], elements: readonly string[], indent: string): TextEdit {
  const newline = newlineOf(source);
  const lineIndent = lineIndentAt(source, statements[0].startIndex);
  const body = elements.map((element) => `${lineIndent}${indent}${element}`).join(`,${newline}`);

  return {
    start: local.creation.endIndex,
    end: statements[statements.length - 1].endIndex,
    text: `${newline}${lineIndent}{${newline}${body}${newline}${lineIndent}};`,
  };
}

/**
 * `var c = new C(); c.A = 1; c.B = 2;` becomes `var c = new C { A = 1, B = 2 };` for the
 * assignments right after the creation that do not use `c` themselves.
 */
function objectInitializers(source: string, _block: Node, statements: readonly Node[], edits: TextEdit[], { indent }: StatementContext): void {
  for (let i = 0; i < statements.length; i++) {
    const local = createdLocal(statements[i]);
    if (!local) {
      continue;
    }

    const members: string[] = [];
    let j = i + 1;
    for (; j < statements.length; j++) {
      const assignment = simpleAssignment(statements[j]);
      const target = assignment?.left.type === 'member_access_expression' ? assignment.left : undefined;
      const member = target?.childForFieldName('name');
      const valid =
        assignment &&
        target?.childForFieldName('expression')?.text === local.name &&
        member?.type === 'identifier' &&
        !members.includes(member.text) &&
        occurrences(assignment.right, local.name).length === 0 &&
        !assignment.right.text.includes('\n') &&
        !hasParseErrors(statements[j]);
      if (!valid) {
        break;
      }

      members.push(member!.text);
    }

    const group = statements.slice(i, j);
    if (members.length === 0 || hasComment(source, statements[i].startIndex, group[group.length - 1].endIndex) || hasParseErrors(statements[i])) {
      continue;
    }

    const elements = group.slice(1).map((statement) => {
      const assignment = simpleAssignment(statement)!;

      return `${assignment.left.childForFieldName('name')!.text} = ${assignment.right.text}`;
    });
    edits.push(initializerEdit(source, local, group, elements, indent));
    i = j - 1;
  }
}

/** Collections whose `Add` a collection initializer calls: `Add(item)`, or `Add(key, value)` for dictionaries. */
const COLLECTION_TYPES: Record<string, 1 | 2> = {
  List: 1,
  HashSet: 1,
  SortedSet: 1,
  Collection: 1,
  ObservableCollection: 1,
  Dictionary: 2,
  SortedDictionary: 2,
  SortedList: 2,
};

/**
 * `var list = new List<int>(); list.Add(1); list.Add(2);` becomes `var list = new List<int> { 1, 2 };`
 * for the well-known collection types (a type of the same name declared in the file is skipped).
 * With collection expressions preferred, only `var` locals are changed: an explicitly typed local
 * would take a collection expression instead.
 */
function collectionInitializers(source: string, block: Node, statements: readonly Node[], edits: TextEdit[], { props, indent }: StatementContext): void {
  let fileRoot: Node = block;
  while (fileRoot.parent) {
    fileRoot = fileRoot.parent;
  }

  const collectionExpressions = enforcedOptionValue(props, 'dotnet_style_prefer_collection_expression');
  const explicitTypeAllowed = collectionExpressions === undefined || collectionExpressions === 'false' || collectionExpressions === 'never';

  for (let i = 0; i < statements.length; i++) {
    const local = createdLocal(statements[i]);
    const type = local?.creation.childForFieldName('type');
    if (!explicitTypeAllowed && singleLocal(statements[i])?.type.type !== 'implicit_type') {
      continue;
    }

    const name = (type?.type === 'generic_name' ? type.namedChildren[0]?.text : undefined) ?? '';
    const arity = COLLECTION_TYPES[name];
    const declaredInFile = fileRoot.descendantsOfType(['class_declaration', 'struct_declaration', 'record_declaration']).some((declaration) => declaration.childForFieldName('name')?.text === name);
    if (!local || !arity || declaredInFile) {
      continue;
    }

    const elements: string[] = [];
    let j = i + 1;
    for (; j < statements.length; j++) {
      const call = statements[j].type === 'expression_statement' ? statements[j].namedChildren[0] : undefined;
      const callee = call?.type === 'invocation_expression' ? call.childForFieldName('function') : null;
      const args = call?.childForFieldName('arguments')?.namedChildren ?? [];
      const values = args.map((argument) => (argument.namedChildCount === 1 && argument.children.length === 1 ? argument.namedChildren[0] : undefined));
      const valid =
        callee?.type === 'member_access_expression' &&
        callee.childForFieldName('expression')?.text === local.name &&
        callee.childForFieldName('name')?.text === 'Add' &&
        values.length === arity &&
        values.every((value) => value !== undefined && occurrences(value, local.name).length === 0 && !value.text.includes('\n')) &&
        !hasParseErrors(statements[j]);
      if (!valid) {
        break;
      }

      elements.push(arity === 1 ? values[0]!.text : `{ ${values.map((value) => value!.text).join(', ')} }`);
    }

    const group = statements.slice(i, j);
    if (elements.length === 0 || hasComment(source, statements[i].startIndex, group[group.length - 1].endIndex) || hasParseErrors(statements[i])) {
      continue;
    }

    edits.push(initializerEdit(source, local, group, elements, indent));
    i = j - 1;
  }
}

// ---------------------------------------------------------------------------------------------
// IDE0066 csharp_style_prefer_switch_expression
// ---------------------------------------------------------------------------------------------

interface SwitchSection {
  /** The pattern of each `case` label (`_` for `default`). */
  readonly patterns: string[];
  readonly statements: Node[];
}

/** The sections of a switch statement's body, or `undefined` when a label is not plain. */
function switchSections(source: string, body: Node): SwitchSection[] | undefined {
  const sections: SwitchSection[] = [];
  const children = body.children.slice(1, -1);
  let section: { patterns: string[]; statements: Node[] } | undefined;
  let i = 0;
  while (i < children.length) {
    const child = children[i];
    if (child.type === 'case' || child.type === 'default') {
      if (!section || section.statements.length > 0) {
        section = { patterns: [], statements: [] };
        sections.push(section);
      }

      let j = i + 1;
      while (j < children.length && children[j].type !== ':') {
        j++;
      }

      const label = child.type === 'default' ? '_' : source.slice(child.endIndex, children[j]?.startIndex ?? child.endIndex).trim();
      if (j >= children.length || !label || label.includes('?') || label.includes(':')) {
        return undefined;
      }

      section.patterns.push(label);
      i = j + 1;
    } else if (child.isNamed && section) {
      section.statements.push(child);
      i++;
    } else {
      return undefined;
    }
  }

  return sections;
}

/** `true` when the pattern binds nothing and can be combined with `or`. */
function isCombinablePattern(pattern: string): boolean {
  return /^(?:-?[\w.]+|'(?:[^'\\]|\\.)+'|"(?:[^"\\]|\\.)*"|null)$/.test(pattern);
}

/** Enums declared in the file: switch arms of one enum keep their type. */
function isEnumOfFile(type: string, anyNode: Node): boolean {
  let root = anyNode;
  while (root.parent) {
    root = root.parent;
  }

  return findAll(root, 'enum_declaration').some((declaration) => declaration.childForFieldName('name')?.text === type.replace(/\?$/, ''));
}

/**
 * A `switch` whose sections each only `return` (or `throw`), or only assign one variable and
 * `break`, becomes a `return`/assignment of a switch expression. Without a `default` section, a
 * `return`/`throw` right after the switch becomes the `_` arm (returns only). The target type
 * must be one the arms' common type cannot change (as for conditional expressions) or an enum of
 * the file.
 */
function switchExpressions(source: string, _block: Node, statements: readonly Node[], edits: TextEdit[], { indent }: StatementContext): void {
  for (let i = 0; i < statements.length; i++) {
    const statement = statements[i];
    const subject = statement.type === 'switch_statement' ? statement.namedChildren[0] : undefined;
    const body = statement.namedChildren.find((child) => child.type === 'switch_body');
    const sections = body && subject ? switchSections(source, body) : undefined;
    if (!sections || sections.length === 0 || hasParseErrors(statement) || hasComment(source, statement.startIndex, statement.endIndex)) {
      continue;
    }

    const arm = (section: SwitchSection, form: 'return' | 'assign'): { value: string; target?: string } | undefined => {
      const [first, second] = section.statements;
      if (section.statements.length === 1 && first.type === 'throw_statement' && first.namedChildCount === 1) {
        return { value: `throw ${first.namedChildren[0].text}` };
      }

      if (form === 'return') {
        const value = section.statements.length === 1 ? returnedValue(first) : undefined;

        return value ? { value: value.text } : undefined;
      }

      const assignment = section.statements.length === 2 && second.type === 'break_statement' ? simpleAssignment(first) : undefined;

      return assignment && isSimpleTarget(assignment.left) ? { value: assignment.right.text, target: assignment.left.text.replace(/\s+/g, '') } : undefined;
    };

    const form = sections.some((section) => section.statements.some((node) => node.type === 'return_statement')) ? 'return' : 'assign';
    const arms = sections.map((section) => arm(section, form));
    const targets = new Set(arms.map((result) => result?.target).filter((target) => target !== undefined));
    if (arms.some((result) => !result) || (form === 'assign' && targets.size !== 1)) {
      continue;
    }

    let defaultValue = sections.findIndex((section) => section.patterns.includes('_'));
    let consumed = statement;
    const armTexts: string[] = [];
    sections.forEach((section, index) => {
      if (index !== defaultValue) {
        const patterns = section.patterns.length > 1 && section.patterns.every(isCombinablePattern) ? [section.patterns.join(' or ')] : section.patterns;
        patterns.forEach((pattern) => armTexts.push(`${pattern} => ${arms[index]!.value}`));
      }
    });
    if (sections.some((section) => section.patterns.length > 1 && !section.patterns.every(isCombinablePattern))) {
      continue;
    }

    if (defaultValue >= 0) {
      armTexts.push(`_ => ${arms[defaultValue]!.value}`);
    } else {
      const next = statements[i + 1];
      const fallback = form === 'return' ? returnedValue(next) : undefined;
      const thrown = next?.type === 'throw_statement' && next.namedChildCount === 1 ? `throw ${next.namedChildren[0].text}` : undefined;
      if (!fallback && !thrown) {
        continue;
      }

      armTexts.push(`_ => ${fallback?.text ?? thrown}`);
      consumed = next;
      defaultValue = sections.length;
    }

    const target = [...targets][0];
    const declaration = form === 'assign' ? singleLocal(statements[i - 1]) : undefined;
    const declares = declaration !== undefined && !declaration.value && declaration.name === target;
    const type = (form === 'return' ? returnType(statement) : declares ? declaration.type.text : subjectTypeText(findTargetNode(sections)!)) ?? '';
    if (
      !(CONDITIONAL_TARGET_TYPES.test(type.replace(/\s+/g, '')) || isEnumOfFile(type, statement)) ||
      armTexts.some((text) => text.includes('\n')) ||
      (consumed !== statement && (hasParseErrors(consumed) || hasComment(source, statement.endIndex, consumed.endIndex)))
    ) {
      continue;
    }

    const lineIndent = lineIndentAt(source, statement.startIndex);
    const newline = newlineOf(source);
    const switchText = `${withParentheses(subject!.text, precedenceOf(subject!), UNARY)} switch${newline}${lineIndent}{${newline}${armTexts
      .map((text) => `${lineIndent}${indent}${text},`)
      .join(newline)}${newline}${lineIndent}}`;
    if (declares) {
      edits.push({ start: declaration.declarator.endIndex, end: consumed.endIndex, text: ` = ${switchText};` });
    } else {
      const prefix = form === 'return' ? 'return' : `${target} =`;
      edits.push({ start: statement.startIndex, end: consumed.endIndex, text: `${prefix} ${switchText};` });
    }

    i += consumed === statement ? 0 : 1;
  }
}

/** The assignment target node of the first assigning section. */
function findTargetNode(sections: readonly SwitchSection[]): Node | undefined {
  for (const section of sections) {
    const assignment = simpleAssignment(section.statements[0]);
    if (assignment) {
      return assignment.left;
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------------------------
// IDE0019 / IDE0020 csharp_style_pattern_matching_over_as_with_null_check / _is_with_cast_check
// ---------------------------------------------------------------------------------------------

/** True when `name` is declared by exactly `declarations` in `member` (no other variable of that name). */
function declaredOnlyBy(member: Node, name: string, declarations: number): boolean {
  const others = member
    .descendantsOfType(['variable_declarator', 'parameter', 'declaration_expression', 'local_function_statement'])
    .filter((node) => node.childForFieldName('name')?.text === name).length;
  const patterns = member.descendantsOfType('pattern').filter((pattern) => pattern.namedChildren.some((child) => child.type === 'identifier' && child.text === name)).length;

  return others === declarations && patterns === 0;
}

/** True when an identifier `name` inside `scope` is assigned (`name = `, `name++`, `ref`/`out name`). */
function isAssignedIn(scope: Node, name: string): boolean {
  return occurrences(scope, name).some((use) => {
    const parent = use.parent;

    return (
      (parent?.type === 'assignment_expression' && parent.childForFieldName('left') === use) ||
      parent?.type === 'postfix_unary_expression' ||
      (parent?.type === 'prefix_unary_expression' && /^(?:\+\+|--)/.test(parent.text)) ||
      (parent?.type === 'argument' && /^(?:ref|out)\b/.test(parent.text))
    );
  });
}

/** The left-most operand of a `&&` chain (the whole condition when it is not one). */
function leftmostConjunct(condition: Node): Node {
  let current = unparenthesized(condition);
  while (operatorOf(current) === '&&') {
    current = unparenthesized(current.childForFieldName('left')!);
  }

  return current;
}

/**
 * `var s = o as T; if (s != null ...) { ... }` becomes `if (o is T s ...) { ... }` when `s` is
 * used only inside the `if` (not in `else`, not after it) and never assigned.
 */
function asWithNullCheckPatterns(source: string, block: Node, statements: readonly Node[], edits: TextEdit[]): void {
  for (let i = 0; i + 1 < statements.length; i++) {
    const local = singleLocal(statements[i]);
    const value = local?.value ? unparenthesized(local.value) : undefined;
    const statement = statements[i + 1];
    const condition = statement.type === 'if_statement' ? statement.namedChildren[0] : undefined;
    const test = condition ? leftmostConjunct(condition) : undefined;
    const check = test ? nullTest(test) : undefined;
    if (!local || value?.type !== 'binary_expression' || operatorOf(value) !== 'as' || !check || check.isNull) {
      continue;
    }

    const operand = value.childForFieldName('left')!;
    const type = value.childForFieldName('right')!;
    const alternative = statement.namedChildren[2];
    const member = enclosingMember(block);
    const usedOutside =
      statements.slice(i + 2).some((later) => occurrences(later, local.name).length > 0) || (alternative !== undefined && occurrences(alternative, local.name).length > 0);
    if (
      check.subject.type !== 'identifier' ||
      check.subject.text !== local.name ||
      (local.type.type !== 'implicit_type' && local.type.text.replace(/\s+/g, '') !== type.text.replace(/\s+/g, '')) ||
      type.text.trim().endsWith('?') ||
      usedOutside ||
      isAssignedIn(statement, local.name) ||
      !declaredOnlyBy(member, local.name, 1) ||
      hasParseErrors(statements[i]) ||
      hasParseErrors(statement) ||
      hasComment(source, statements[i].startIndex, test!.endIndex)
    ) {
      continue;
    }

    edits.push({ start: statements[i].startIndex, end: statement.startIndex, text: '' });
    edits.push({ start: test!.startIndex, end: test!.endIndex, text: `${withParentheses(operand.text, precedenceOf(operand), RELATIONAL)} is ${type.text} ${local.name}` });
    i++;
  }
}

/** `if (o is T) { var t = (T)o; ... }` becomes `if (o is T t) { ... }` when `t` is never assigned. */
function isWithCastPatterns(source: string, block: Node, statements: readonly Node[], edits: TextEdit[]): void {
  for (const statement of statements) {
    const condition = statement.type === 'if_statement' ? statement.namedChildren[0] : undefined;
    const test = condition ? leftmostConjunct(condition) : undefined;
    const pattern = test?.type === 'is_pattern_expression' ? test.childForFieldName('pattern') : null;
    const subject = test?.childForFieldName('expression');
    const then = statement.namedChildren[1];
    const local = then?.type === 'block' ? singleLocal(then.namedChildren[0]) : undefined;
    const cast = local?.value ? unparenthesized(local.value) : undefined;
    if (!pattern || !subject || !local || cast?.type !== 'cast_expression' || pattern.namedChildCount !== 1 || !isSimpleTarget(subject)) {
      continue;
    }

    const castType = cast.childForFieldName('type')!.text.replace(/\s+/g, '');
    const castValue = cast.childForFieldName('value')!;
    if (
      castType !== pattern.text.replace(/\s+/g, '') ||
      castType.endsWith('?') ||
      castValue.text.replace(/\s+/g, '') !== subject.text.replace(/\s+/g, '') ||
      (local.type.type !== 'implicit_type' && local.type.text.replace(/\s+/g, '') !== castType) ||
      isAssignedIn(then, local.name) ||
      !declaredOnlyBy(enclosingMember(block), local.name, 1) ||
      hasParseErrors(statement) ||
      hasComment(source, test!.startIndex, local.declarator.endIndex)
    ) {
      continue;
    }

    const declaration = then.namedChildren[0];
    const lineStart = lineStartAt(source, declaration.startIndex);
    const removeStart = source.slice(lineStart, declaration.startIndex).trim() === '' ? lineStart : declaration.startIndex;
    const lineEnd = lineEndAt(source, declaration.endIndex);
    const removeEnd = source.slice(declaration.endIndex, lineEnd).trim() === '' ? (source.startsWith('\r\n', lineEnd) ? lineEnd + 2 : lineEnd + 1) : declaration.endIndex;
    edits.push({ start: pattern.endIndex, end: pattern.endIndex, text: ` ${local.name}` });
    edits.push({ start: removeStart, end: removeEnd, text: '' });
  }
}
