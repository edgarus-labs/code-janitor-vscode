import { effectiveEditorConfigValue } from '../editorConfigRegistry';
import { Node, TextEdit, applyEdits, findAll, parseCSharp } from '../parser';
import type { Rule } from './editorConfigCodeStyle';
import { declaredTypeNode, declaredTypeText, delegateParameterTypes, isSimpleReceiver, subjectTypeText } from './editorConfigExpressionPreferences';
import { hasComment, returnType, tupleElements } from './editorConfigStatementPreferences';
import {
  RELATIONAL,
  UNARY,
  NullTest,
  nullTest,
  operatorOf,
  precedenceOf,
  requiredPrecedence,
  unparenthesized,
  withParentheses,
} from './editorConfigPrecedence';
import { EditorConfigIssueReporter, describeIssue, hasParseErrors, lineStartAt } from './editorConfigSupport';
import { NULLABLE_VALUE_TYPE, isNonNullableValueType, isPlainReferenceType, isVariable } from './typeFacts';
import { isInPossibleExpressionTree } from './nullCheckPatternMatching';

/**
 * Operator, null-check and pattern preferences. Each rewrite keeps the evaluation of every operand
 * and is made only where the types involved are certain from the file (a null check against a type
 * that may overload `==` is left alone), never inside a lambda that could become an expression tree
 * when the new syntax is not allowed there.
 */

type Collect = (source: string, root: Node) => TextEdit[];

/**
 * Parses `source` and applies the edits `collect` returns, again while nested rewrites remain
 * (overlapping edits are applied innermost first, one level per pass).
 */
function rewrite(source: string, collect: Collect): string {
  let current = source;
  for (let pass = 0; pass < 4; pass++) {
    const tree = parseCSharp(current);
    let edits: TextEdit[];
    try {
      edits = collect(current, tree.rootNode).map((edit) => separatedFromNeighbors(current, edit));
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

/**
 * `edit` with a space where it would join two words: `return(x)` and `return!(x is T)` lose the
 * only thing between the keyword and the operand.
 */
function separatedFromNeighbors(source: string, edit: TextEdit): TextEdit {
  const isWord = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}_]/u.test(c);
  const before = source[edit.start - 1];
  const after = source[edit.end];
  if (edit.text === '') {
    return isWord(before) && isWord(after) && !isWord(source[edit.start]) ? { ...edit, text: ' ' } : edit;
  }

  const prefix = isWord(before) && isWord(edit.text[0]) && !isWord(source[edit.start]) ? ' ' : '';
  const suffix = isWord(after) && isWord(edit.text.at(-1)) && !isWord(source[edit.end - 1]) ? ' ' : '';

  return prefix || suffix ? { ...edit, text: `${prefix}${edit.text}${suffix}` } : edit;
}

/** A rule for a boolean option that rewrites while the option is `true` and enforced. */
function whenPreferred(option: string, collect: Collect): Rule {
  return {
    option,
    apply: (source, { props }) => (effectiveEditorConfigValue(props, option) === 'true' ? rewrite(source, collect) : source),
  };
}

function normalized(text: string): string {
  return text.replace(/\s+/g, '');
}

// ---------------------------------------------------------------------------------------------
// Types known from the file
// ---------------------------------------------------------------------------------------------

/** `condition ? whenTrue : whenFalse` of a fully parsed conditional expression. */
function conditionalParts(conditional: Node): { condition: Node; whenTrue: Node; whenFalse: Node } | undefined {
  const [condition, whenTrue, whenFalse] = conditional.namedChildren;

  return conditional.namedChildCount === 3 && condition === conditional.childForFieldName('condition') && !hasParseErrors(conditional)
    ? { condition, whenTrue, whenFalse }
    : undefined;
}

// ---------------------------------------------------------------------------------------------
// IDE0047 / IDE0048 dotnet_style_parentheses_in_*
// ---------------------------------------------------------------------------------------------

const PARENTHESES_OPTIONS = {
  arithmetic: 'dotnet_style_parentheses_in_arithmetic_binary_operators',
  relational: 'dotnet_style_parentheses_in_relational_binary_operators',
  logical: 'dotnet_style_parentheses_in_other_binary_operators',
  other: 'dotnet_style_parentheses_in_other_operators',
} as const;

type ParenthesesGroup = keyof typeof PARENTHESES_OPTIONS;

const OPERATOR_GROUPS: Record<string, ParenthesesGroup> = {
  '*': 'arithmetic',
  '/': 'arithmetic',
  '%': 'arithmetic',
  '+': 'arithmetic',
  '-': 'arithmetic',
  '<<': 'arithmetic',
  '>>': 'arithmetic',
  '>>>': 'arithmetic',
  '&': 'arithmetic',
  '^': 'arithmetic',
  '|': 'arithmetic',
  '<': 'relational',
  '>': 'relational',
  '<=': 'relational',
  '>=': 'relational',
  '==': 'relational',
  '!=': 'relational',
  '&&': 'logical',
  '||': 'logical',
  '??': 'logical',
};

/** Expressions that bind at least as tightly as any operator around them. */
const PRIMARY_EXPRESSIONS: Record<string, true> = {
  identifier: true,
  this_expression: true,
  member_access_expression: true,
  invocation_expression: true,
  element_access_expression: true,
  parenthesized_expression: true,
  object_creation_expression: true,
  string_literal: true,
  verbatim_string_literal: true,
  raw_string_literal: true,
  interpolated_string_expression: true,
  character_literal: true,
  boolean_literal: true,
  null_literal: true,
  integer_literal: true,
  real_literal: true,
  typeof_expression: true,
  default_expression: true,
  sizeof_expression: true,
  checked_expression: true,
};

/** Positions where an expression stands alone, so parentheses around it group nothing. */
function isStandalonePosition(parenthesized: Node): boolean {
  const parent = parenthesized.parent;
  switch (parent?.type) {
    case 'equals_value_clause':
    case 'return_statement':
    case 'throw_statement':
    case 'arrow_expression_clause':
    case 'parenthesized_expression':
    case 'if_statement':
    case 'while_statement':
    case 'do_statement':
      return true;
    case 'argument':
      // `F((a < b), c > (d))` must keep its parentheses: without them it reads as a generic call.
      return !/[<>]/.test(parenthesized.text);
    case 'assignment_expression':
      return parent.childForFieldName('right') === parenthesized;
    case 'lambda_expression':
      return parent.childForFieldName('body') === parenthesized;
    default:
      return false;
  }
}

function parenthesesRule(): Rule {
  return {
    option: 'dotnet_style_parentheses_in_*',
    apply: (source, { props }) => {
      const values: Record<ParenthesesGroup, string | undefined> = {
        arithmetic: effectiveEditorConfigValue(props, PARENTHESES_OPTIONS.arithmetic),
        relational: effectiveEditorConfigValue(props, PARENTHESES_OPTIONS.relational),
        logical: effectiveEditorConfigValue(props, PARENTHESES_OPTIONS.logical),
        other: effectiveEditorConfigValue(props, PARENTHESES_OPTIONS.other),
      };
      if (Object.values(values).every((value) => value === undefined)) {
        return source;
      }

      return rewrite(source, (text, root) => [...clarifyingParentheses(root, values), ...unnecessaryParentheses(text, root, values)]);
    },
  };
}

/** IDE0048: `a + b * c` becomes `a + (b * c)` for groups set to `always_for_clarity`. */
function clarifyingParentheses(root: Node, values: Record<ParenthesesGroup, string | undefined>): TextEdit[] {
  const edits: TextEdit[] = [];
  for (const binary of findAll(root, 'binary_expression')) {
    const parent = binary.parent;
    const group = OPERATOR_GROUPS[operatorOf(binary) ?? ''];
    if (parent?.type !== 'binary_expression' || !group || values[group] !== 'always_for_clarity' || hasParseErrors(parent)) {
      continue;
    }

    if (OPERATOR_GROUPS[operatorOf(parent) ?? ''] === group && precedenceOf(parent) !== precedenceOf(binary)) {
      edits.push({ start: binary.startIndex, end: binary.startIndex, text: '(' }, { start: binary.endIndex, end: binary.endIndex, text: ')' });
    }
  }

  return edits;
}

/** IDE0047: removes parentheses that group nothing, for groups set to `never_if_unnecessary`. */
function unnecessaryParentheses(source: string, root: Node, values: Record<ParenthesesGroup, string | undefined>): TextEdit[] {
  const edits: TextEdit[] = [];
  for (const parenthesized of findAll(root, 'parenthesized_expression')) {
    const inner = parenthesized.namedChildren[0];
    if (
      parenthesized.namedChildCount !== 1 ||
      hasParseErrors(parenthesized) ||
      hasComment(source, parenthesized.startIndex, inner.startIndex) ||
      hasComment(source, inner.endIndex, parenthesized.endIndex)
    ) {
      continue;
    }

    if (isUnnecessary(parenthesized, inner, values)) {
      edits.push({ start: parenthesized.startIndex, end: inner.startIndex, text: '' }, { start: inner.endIndex, end: parenthesized.endIndex, text: '' });
    }
  }

  return edits;
}

function isUnnecessary(parenthesized: Node, inner: Node, values: Record<ParenthesesGroup, string | undefined>): boolean {
  const parent = parenthesized.parent!;
  const innerGroup = OPERATOR_GROUPS[operatorOf(inner) ?? ''];

  if (innerGroup) {
    if (values[innerGroup] !== 'never_if_unnecessary') {
      return false;
    }

    if (isStandalonePosition(parenthesized)) {
      return true;
    }

    const parentOperator = operatorOf(parent) ?? '';
    if (OPERATOR_GROUPS[parentOperator] !== innerGroup) {
      return false;
    }

    // `(a * b) + c` and `(a + b) + c` (left-associative) keep their meaning; `a - (b - c)` does not.
    const isLeft = parent.childForFieldName('left') === parenthesized;

    return precedenceOf(inner) > precedenceOf(parent) || (precedenceOf(inner) === precedenceOf(parent) && isLeft && parentOperator !== '??');
  }

  if (values.other !== 'never_if_unnecessary') {
    return false;
  }

  if (PRIMARY_EXPRESSIONS[inner.type] !== true) {
    return isStandalonePosition(parenthesized);
  }

  const parentOperator = operatorOf(parent);
  const isAccessed =
    (parent.type === 'member_access_expression' || parent.type === 'element_access_expression' || parent.type === 'conditional_access_expression') &&
    parent.childForFieldName('expression') === parenthesized;

  return !(
    // `(a?.b).c` stops at `a == null`, `a?.b.c` does not: never splice into a conditional access.
    /\?[.[]/.test(inner.text) ||
    // `(1).ToString()`, `(new C())[0]`: the parentheses keep the token or construct apart.
    ((inner.type === 'integer_literal' || inner.type === 'real_literal') && isAccessed) ||
    (inner.type === 'object_creation_expression' && parent.type === 'element_access_expression') ||
    // `a < (b)` next to a `>` could read as type arguments without them.
    (parentOperator !== undefined && /[<>]/.test(parentOperator))
  );
}

// ---------------------------------------------------------------------------------------------
// IDE0054 / IDE0074 dotnet_style_prefer_compound_assignment
// ---------------------------------------------------------------------------------------------

const COMPOUND_OPERATORS: Record<string, true> = {
  '+': true,
  '-': true,
  '*': true,
  '/': true,
  '%': true,
  '&': true,
  '|': true,
  '^': true,
  '<<': true,
  '>>': true,
  '??': true,
};

/**
 * `x = x + y` becomes `x += y`, and `x = x ?? y` and `x ?? (x = y)` become `x ??= y`, for a
 * side-effect-free `x`.
 */
const compoundAssignment: Collect = (source, root) => {
  const edits: TextEdit[] = [];
  for (const coalesce of findAll(root, 'binary_expression')) {
    const left = coalesce.childForFieldName('left');
    const right = coalesce.childForFieldName('right');
    const assignment = right?.type === 'parenthesized_expression' && right.namedChildCount === 1 ? right.namedChildren[0] : undefined;
    const target = assignment?.type === 'assignment_expression' ? assignment.childForFieldName('left') : null;
    const value = assignment?.childForFieldName('right');
    if (
      operatorOf(coalesce) === '??' &&
      left &&
      isSimpleReceiver(left) &&
      target &&
      value &&
      assignment!.children.find((child) => !child.isNamed)?.type === '=' &&
      normalized(target.text) === normalized(left.text) &&
      !hasParseErrors(coalesce) &&
      !hasComment(source, coalesce.startIndex, coalesce.endIndex)
    ) {
      edits.push({ start: coalesce.startIndex, end: coalesce.endIndex, text: withParentheses(`${left.text} ??= ${value.text}`, 0, requiredPrecedence(coalesce)) });
    }
  }

  for (const assignment of findAll(root, 'assignment_expression')) {
    const left = assignment.childForFieldName('left');
    const right = assignment.childForFieldName('right');
    const operator = right ? operatorOf(right) : undefined;
    const operandLeft = right?.childForFieldName('left');
    const operandRight = right?.childForFieldName('right');
    if (
      assignment.children.find((child) => !child.isNamed)?.type !== '=' ||
      !left ||
      !isSimpleReceiver(left) ||
      !operator ||
      COMPOUND_OPERATORS[operator] !== true ||
      // `P = P ?? v` always runs P's setter, `P ??= v` only when P is null: only for variables.
      (operator === '??' && !isVariable(left)) ||
      !operandLeft ||
      !operandRight ||
      normalized(operandLeft.text) !== normalized(left.text) ||
      hasParseErrors(assignment) ||
      hasComment(source, left.endIndex, operandRight.startIndex)
    ) {
      continue;
    }

    edits.push({ start: left.endIndex, end: operandRight.startIndex, text: ` ${operator}= ` });
  }

  return edits;
};

// ---------------------------------------------------------------------------------------------
// IDE0075 dotnet_style_prefer_simplified_boolean_expressions
// ---------------------------------------------------------------------------------------------

const BOOLEAN_TYPES: Record<string, true> = { bool: true, Boolean: true, 'System.Boolean': true };
const LITERALS: Record<string, true> = {
  integer_literal: true,
  real_literal: true,
  string_literal: true,
  verbatim_string_literal: true,
  character_literal: true,
  boolean_literal: true,
  null_literal: true,
};

/** True when `node` is of type `bool` (not `bool?`) as far as syntax and declared types tell. */
function isBoolean(node: Node): boolean {
  const expression = unparenthesized(node);
  const operator = operatorOf(expression);
  switch (expression.type) {
    case 'boolean_literal':
    case 'is_pattern_expression':
    case 'is_expression':
      return true;
    case 'prefix_unary_expression':
      return expression.children[0]?.type === '!' && expression.namedChildCount === 1 && isBoolean(expression.namedChildren[0]);
    case 'binary_expression': {
      const left = expression.childForFieldName('left');
      const right = expression.childForFieldName('right');
      if (!left || !right) {
        return false;
      }

      if (operator === '&&' || operator === '||') {
        return isBoolean(left) && isBoolean(right);
      }

      return (
        (operator === '==' || operator === '!=' || operator === '<' || operator === '>' || operator === '<=' || operator === '>=') &&
        (LITERALS[unparenthesized(left).type] === true || LITERALS[unparenthesized(right).type] === true)
      );
    }
    case 'identifier':
    case 'member_access_expression':
      return BOOLEAN_TYPES[subjectTypeText(expression) ?? ''] === true;
    default:
      return false;
  }
}

function negated(node: Node): string {
  return `!${withParentheses(node.text, precedenceOf(node), UNARY)}`;
}

/**
 * `c ? true : false` becomes `c`, `c ? false : true` becomes `!c`, and `c ? true : y`,
 * `c ? y : false` (and their negated forms) become `||` / `&&` when `c` and `y` are `bool`.
 */
const simplifiedBooleans: Collect = (_source, root) => {
  const edits: TextEdit[] = [];
  for (const conditional of findAll(root, 'conditional_expression')) {
    const parts = conditionalParts(conditional);
    if (!parts || !isBoolean(parts.condition)) {
      continue;
    }

    const { condition, whenTrue, whenFalse } = parts;
    const literal = (node: Node): string | undefined => (unparenthesized(node).type === 'boolean_literal' ? unparenthesized(node).text : undefined);
    const [t, f] = [literal(whenTrue), literal(whenFalse)];
    const left = (logical: number, negate: boolean): string =>
      negate ? negated(condition) : withParentheses(condition.text, precedenceOf(condition), logical);
    const right = (node: Node, logical: number): string => withParentheses(node.text, precedenceOf(node), logical + 1);

    let text: string | undefined;
    if (t !== undefined && f !== undefined) {
      text = t === 'true' && f === 'false' ? condition.text : t === 'false' && f === 'true' ? negated(condition) : undefined;
    } else if (t !== undefined && isBoolean(whenFalse)) {
      // c ? true : y  ->  c || y;   c ? false : y  ->  !c && y
      text = t === 'true' ? `${left(3, false)} || ${right(whenFalse, 3)}` : `${left(4, true)} && ${right(whenFalse, 4)}`;
    } else if (f !== undefined && isBoolean(whenTrue)) {
      // c ? y : false  ->  c && y;   c ? y : true  ->  !c || y
      text = f === 'false' ? `${left(4, false)} && ${right(whenTrue, 4)}` : `${left(3, true)} || ${right(whenTrue, 3)}`;
    }

    if (text !== undefined) {
      edits.push({ start: conditional.startIndex, end: conditional.endIndex, text: withParentheses(text, 3, requiredPrecedence(conditional)) });
    }
  }

  return edits;
};

// ---------------------------------------------------------------------------------------------
// IDE0029 / IDE0030 dotnet_style_coalesce_expression
// ---------------------------------------------------------------------------------------------

/** `x != null ? x : y` becomes `x ?? y`; `x.HasValue ? x.Value : y` (nullable value) too. */
const coalesceExpressions: Collect = (_source, root) => {
  const edits: TextEdit[] = [];
  for (const conditional of findAll(root, 'conditional_expression')) {
    const parts = conditionalParts(conditional);
    const test = parts ? nullTest(parts.condition) ?? hasValueTest(parts.condition) : undefined;
    if (!parts || !test || !isSimpleReceiver(test.subject)) {
      continue;
    }

    const value = test.isNull ? parts.whenFalse : parts.whenTrue;
    const other = test.isNull ? parts.whenTrue : parts.whenFalse;
    const subject = normalized(test.subject.text);
    const type = subjectTypeText(test.subject);
    const valueAccess = value.type === 'member_access_expression' && value.childForFieldName('name')?.text === 'Value' ? value.childForFieldName('expression') : undefined;

    const coalesces =
      (normalized(value.text) === subject && isPlainReferenceType(type, root)) ||
      (valueAccess !== undefined && valueAccess !== null && normalized(valueAccess.text) === subject && NULLABLE_VALUE_TYPE.test(type ?? ''));
    if (coalesces) {
      edits.push({
        start: conditional.startIndex,
        end: conditional.endIndex,
        text: withParentheses(`${test.subject.text} ?? ${withParentheses(other.text, precedenceOf(other), 2)}`, 2, requiredPrecedence(conditional)),
      });
    }
  }

  return edits;
};

/** `x.HasValue` / `!x.HasValue`. */
function hasValueTest(condition: Node): NullTest | undefined {
  const test = unparenthesized(condition);
  const isNull = test.type === 'prefix_unary_expression' && test.children[0]?.type === '!';
  const access = isNull ? unparenthesized(test.namedChildren[0]) : test;
  const subject = access.type === 'member_access_expression' && access.childForFieldName('name')?.text === 'HasValue' ? access.childForFieldName('expression') : null;

  return subject ? { subject, isNull, byPattern: false } : undefined;
}

// ---------------------------------------------------------------------------------------------
// IDE0031 dotnet_style_null_propagation
// ---------------------------------------------------------------------------------------------

/** The node of `access`'s receiver chain (`x.a.b()`, `x[0]`) that is `subject`. */
function receiverInChain(access: Node, subject: string): Node | undefined {
  let current = access;
  for (;;) {
    const next =
      current.type === 'member_access_expression' || current.type === 'element_access_expression'
        ? current.childForFieldName('expression')
        : current.type === 'invocation_expression'
          ? current.childForFieldName('function')
          : null;
    if (!next) {
      return undefined;
    }

    if (normalized(next.text) === subject) {
      return current.type === 'invocation_expression' ? undefined : next;
    }

    current = next;
  }
}

/**
 * True when a value of the declared `type` may be a `Nullable<T>`: its type is unknown (`var`), ends in `?`,
 * names `Nullable<…>`, or is a `using` alias the file declares (`using N = int?;`). A named class or struct
 * written without `?`, such as `XElement` or `Lazy<string>`, never is.
 */
function mayBeNullableValueType(type: string | undefined, source: string): boolean {
  if (type === undefined || type === 'var' || type.endsWith('?') || /\bNullable\s*</.test(type)) {
    return true;
  }

  const name = /^@?([\p{L}_][\p{L}\p{N}_]*)$/u.exec(type)?.[1];

  return name !== undefined && new RegExp(`\\busing\\s+(?:static\\s+)?@?${name}\\s*=`, 'u').test(source);
}

/** `x != null ? x.Y : null` becomes `x?.Y`. */
const nullPropagation: Collect = (source, root) => {
  const edits: TextEdit[] = [];
  for (const conditional of findAll(root, 'conditional_expression')) {
    const parts = conditionalParts(conditional);
    const test = parts ? nullTest(parts.condition) : undefined;
    if (!parts || !test || !isSimpleReceiver(test.subject) || isInPossibleExpressionTree(conditional)) {
      continue;
    }

    const value = test.isNull ? parts.whenFalse : parts.whenTrue;
    const nullBranch = test.isNull ? parts.whenTrue : parts.whenFalse;
    const receiver = receiverInChain(value, normalized(test.subject.text));
    const type = subjectTypeText(test.subject);
    if (
      unparenthesized(nullBranch).type !== 'null_literal' ||
      !receiver ||
      !/^[.[]/.test(source.slice(receiver.endIndex, receiver.endIndex + 1)) ||
      /\?[.[]/.test(value.text) ||
      (!test.byPattern && !isPlainReferenceType(type, root)) ||
      // Only `Nullable<T>` has these members, and on it `x?.M` binds `M` on `T`: `x?.Value` does not compile.
      (/^\.\s*@?(?:Value|HasValue|GetValueOrDefault)\b/.test(source.slice(receiver.endIndex)) && mayBeNullableValueType(type, source) && !isPlainReferenceType(type, root))
    ) {
      continue;
    }

    const offset = receiver.endIndex - value.startIndex;
    edits.push({ start: conditional.startIndex, end: conditional.endIndex, text: `${value.text.slice(0, offset)}?${value.text.slice(offset)}` });
  }

  return edits;
};

// ---------------------------------------------------------------------------------------------
// IDE1005 csharp_style_conditional_delegate_call
// ---------------------------------------------------------------------------------------------

/** `if (handler != null) handler(args);` becomes `handler?.Invoke(args);`. */
const conditionalDelegateCalls: Collect = (source, root) => {
  const edits: TextEdit[] = [];
  for (const statement of findAll(root, 'if_statement')) {
    const [condition, body, alternative] = statement.namedChildren;
    const test = condition ? nullTest(condition) : undefined;
    const inner = body?.type === 'block' ? (body.namedChildCount === 1 ? body.namedChildren[0] : undefined) : body;
    const call = inner?.type === 'expression_statement' ? inner.namedChildren[0] : undefined;
    const callee = call?.type === 'invocation_expression' ? call.childForFieldName('function') : null;
    const invoked = callee?.type === 'member_access_expression' && callee.childForFieldName('name')?.text === 'Invoke' ? callee.childForFieldName('expression') : callee;
    const args = call?.childForFieldName('arguments');
    if (
      alternative ||
      !test ||
      test.isNull ||
      !isSimpleReceiver(test.subject) ||
      !invoked ||
      !args ||
      normalized(invoked.text) !== normalized(test.subject.text) ||
      hasParseErrors(statement) ||
      hasComment(source, statement.startIndex, statement.endIndex)
    ) {
      continue;
    }

    edits.push({ start: statement.startIndex, end: statement.endIndex, text: `${test.subject.text}?.Invoke${args.text};` });
  }

  return edits;
};

// ---------------------------------------------------------------------------------------------
// IDE0041 dotnet_style_prefer_is_null_check_over_reference_equality_method
// ---------------------------------------------------------------------------------------------

const REFERENCE_EQUALS: Record<string, true> = {
  ReferenceEquals: true,
  'object.ReferenceEquals': true,
  'Object.ReferenceEquals': true,
  'System.Object.ReferenceEquals': true,
};

/** `ReferenceEquals(x, null)` becomes `x is null`; `!ReferenceEquals(x, null)` becomes `x is not null`. */
const isNullOverReferenceEquals: Collect = (_source, root) => {
  const edits: TextEdit[] = [];
  const declaresReferenceEquals = findAll(root, ['method_declaration', 'local_function_statement']).some(
    (method) => method.childForFieldName('name')?.text === 'ReferenceEquals'
  );
  if (declaresReferenceEquals) {
    return edits;
  }

  for (const invocation of findAll(root, 'invocation_expression')) {
    const callee = invocation.childForFieldName('function');
    const args = invocation.childForFieldName('arguments')?.namedChildren ?? [];
    const values = args.map((argument) => (argument.namedChildCount === 1 && argument.children.length === 1 ? argument.namedChildren[0] : undefined));
    const subject = values[1]?.type === 'null_literal' ? values[0] : values[0]?.type === 'null_literal' ? values[1] : undefined;
    if (
      !callee ||
      REFERENCE_EQUALS[normalized(callee.text)] !== true ||
      args.length !== 2 ||
      !subject ||
      subject.type === 'null_literal' ||
      // `is null` does not compile for a non-nullable value type (CS0037), `ReferenceEquals` does.
      isNonNullableValueType(subjectTypeText(subject), root) ||
      hasParseErrors(invocation) ||
      isInPossibleExpressionTree(invocation)
    ) {
      continue;
    }

    const parent = invocation.parent;
    const isNegated = parent?.type === 'prefix_unary_expression' && parent.children[0]?.type === '!';
    const target = isNegated ? parent : invocation;
    const text = `${withParentheses(subject.text, precedenceOf(subject), RELATIONAL)} is ${isNegated ? 'not ' : ''}null`;
    edits.push({ start: target.startIndex, end: target.endIndex, text: withParentheses(text, RELATIONAL, requiredPrecedence(target)) });
  }

  return edits;
};

// ---------------------------------------------------------------------------------------------
// IDE0083 csharp_style_prefer_not_pattern
// ---------------------------------------------------------------------------------------------

const SIMPLE_PATTERNS: Record<string, true> = {
  predefined_type: true,
  identifier: true,
  qualified_name: true,
  generic_name: true,
  null_literal: true,
  integer_literal: true,
  real_literal: true,
  string_literal: true,
  character_literal: true,
  boolean_literal: true,
};

/** `!(x is T)` becomes `x is not T` for a type or constant pattern without a designation. */
const notPatterns: Collect = (source, root) => {
  const edits: TextEdit[] = [];
  for (const negation of findAll(root, 'prefix_unary_expression')) {
    const operand = negation.namedChildren[0];
    const test = operand?.type === 'parenthesized_expression' && operand.namedChildCount === 1 ? operand.namedChildren[0] : undefined;
    const pattern = test?.type === 'is_pattern_expression' ? test.childForFieldName('pattern') : null;
    const expression = test?.childForFieldName('expression');
    if (
      negation.children[0]?.type !== '!' ||
      !test ||
      !pattern ||
      !expression ||
      pattern.namedChildCount !== 1 ||
      SIMPLE_PATTERNS[pattern.namedChildren[0].type] !== true ||
      pattern.text.trim().endsWith('?') ||
      hasParseErrors(negation) ||
      hasComment(source, negation.startIndex, negation.endIndex) ||
      isInPossibleExpressionTree(negation)
    ) {
      continue;
    }

    const text = `${expression.text} is not ${pattern.text}`;
    edits.push({ start: negation.startIndex, end: negation.endIndex, text: withParentheses(text, RELATIONAL, requiredPrecedence(negation)) });
  }

  return edits;
};

// ---------------------------------------------------------------------------------------------
// IDE0078 csharp_style_prefer_pattern_matching
// ---------------------------------------------------------------------------------------------

type ConstantKind = 'int' | 'long' | 'float' | 'double' | 'decimal' | 'char' | 'string' | 'bool';

const CONSTANT_KINDS: Record<string, ConstantKind> = {
  int: 'int',
  Int32: 'int',
  long: 'long',
  Int64: 'long',
  float: 'float',
  Single: 'float',
  double: 'double',
  Double: 'double',
  decimal: 'decimal',
  Decimal: 'decimal',
  char: 'char',
  Char: 'char',
  string: 'string',
  String: 'string',
  bool: 'bool',
  Boolean: 'bool',
};

const PATTERN_OPERATORS: Record<string, string> = { '==': '', '!=': 'not ', '<': '< ', '<=': '<= ', '>': '> ', '>=': '>= ' };

/** True when the literal converts to the subject's type as a pattern constant exactly as `==` compares. */
function isConstantFor(node: Node, kind: ConstantKind, nullable: boolean): boolean {
  const literal = node.type === 'prefix_unary_expression' && node.children[0]?.type === '-' ? node.namedChildren[0] : node;
  const signed = literal !== node;
  const text = literal?.text ?? '';
  switch (literal?.type) {
    case 'integer_literal': {
      const suffix = /[uUlL]+$/.exec(text)?.[0] ?? '';
      const digits = text.slice(0, text.length - suffix.length).replace(/_/g, '');
      if (kind === 'int') {
        return suffix === '' && /^\d+$/.test(digits) && Number(digits) <= 2147483647;
      }

      return (kind === 'long' && /^[lL]?$/.test(suffix)) || ((kind === 'float' || kind === 'double' || kind === 'decimal') && suffix === '');
    }
    case 'real_literal':
      return (
        (kind === 'double' && /^[\d_.eE+-]+[dD]?$/.test(text)) ||
        (kind === 'float' && /[fF]$/.test(text)) ||
        (kind === 'decimal' && /[mM]$/.test(text))
      );
    case 'character_literal':
      return !signed && kind === 'char';
    case 'string_literal':
    case 'verbatim_string_literal':
      return !signed && kind === 'string';
    case 'boolean_literal':
      return !signed && kind === 'bool';
    case 'null_literal':
      return !signed && (nullable || kind === 'string');
    default:
      return false;
  }
}

function flattenChain(node: Node, operator: string): Node[] {
  const expression = unparenthesized(node);
  const left = expression.childForFieldName('left');
  const right = expression.childForFieldName('right');

  return operatorOf(expression) === operator && left && right ? [...flattenChain(left, operator), ...flattenChain(right, operator)] : [expression];
}

/** `x == 1 || x == 2` becomes `x is 1 or 2`; `x >= 0 && x <= 9` becomes `x is >= 0 and <= 9`. */
const patternCombinators: Collect = (_source, root) => {
  const edits: TextEdit[] = [];
  for (const chain of findAll(root, 'binary_expression')) {
    const operator = operatorOf(chain);
    if ((operator !== '||' && operator !== '&&') || operatorOf(unparenthesizedParent(chain)) === operator || hasParseErrors(chain)) {
      continue;
    }

    const comparisons = flattenChain(chain, operator);
    const subject = comparisons[0]?.childForFieldName('left');
    const type = subject && isSimpleReceiver(subject) ? subjectTypeText(subject) : undefined;
    const kind = CONSTANT_KINDS[type?.replace(/\?$/, '') ?? ''];
    if (comparisons.length < 2 || !subject || !kind || isInPossibleExpressionTree(chain)) {
      continue;
    }

    const parts: string[] = [];
    for (const comparison of comparisons) {
      const prefix = PATTERN_OPERATORS[operatorOf(comparison) ?? ''];
      const left = comparison.childForFieldName('left');
      const right = comparison.childForFieldName('right');
      if (prefix === undefined || !left || !right || normalized(left.text) !== normalized(subject.text) || !isConstantFor(right, kind, type!.endsWith('?'))) {
        break;
      }

      parts.push(`${prefix}${right.text}`);
    }

    if (parts.length === comparisons.length) {
      edits.push({ start: chain.startIndex, end: chain.endIndex, text: `${subject.text} is ${parts.join(operator === '||' ? ' or ' : ' and ')}` });
    }
  }

  return edits;
};

/** The nearest ancestor of `node` that is not a parenthesized expression around it. */
function unparenthesizedParent(node: Node): Node {
  let current = node.parent;
  while (current?.type === 'parenthesized_expression') {
    current = current.parent;
  }

  return current ?? node;
}

// ---------------------------------------------------------------------------------------------
// IDE0037 dotnet_style_prefer_inferred_tuple_names / _anonymous_type_member_names
// ---------------------------------------------------------------------------------------------

const RESERVED_TUPLE_NAMES = /^(?:Item\d+|Rest|ToString|GetHashCode|Equals|CompareTo|Deconstruct|GetType)$/;

/** The member name C# infers from `x` or `a.b.x`. */
function inferredName(value: Node): string | undefined {
  if (value.type === 'identifier') {
    return value.text;
  }

  const name = value.type === 'member_access_expression' ? value.childForFieldName('name') : null;

  return name?.type === 'identifier' ? name.text : undefined;
}

/** `(x: x, y: p.y)` becomes `(x, p.y)` when C# infers the same, unique element names. */
const inferredTupleNames: Collect = (source, root) => {
  const edits: TextEdit[] = [];
  for (const tuple of findAll(root, 'tuple_expression')) {
    const elements = hasParseErrors(tuple) ? undefined : tupleElements(tuple);
    if (!elements) {
      continue;
    }

    const names = elements.map((element) => element.name ?? inferredName(element.value));
    for (const element of elements) {
      const inferred = inferredName(element.value);
      const unique = names.filter((name) => name === element.name).length === 1;
      if (
        element.name !== undefined &&
        element.nameNode &&
        inferred === element.name &&
        unique &&
        !RESERVED_TUPLE_NAMES.test(inferred) &&
        !hasComment(source, element.nameNode.startIndex, element.value.startIndex)
      ) {
        edits.push({ start: element.nameNode.startIndex, end: element.value.startIndex, text: '' });
      }
    }
  }

  return edits;
};

/** `new { X = p.X }` becomes `new { p.X }`. */
const inferredAnonymousNames: Collect = (source, root) => {
  const edits: TextEdit[] = [];
  for (const creation of findAll(root, 'anonymous_object_creation_expression')) {
    const initializer = creation.namedChildren.find((child) => child.type === 'initializer_expression');
    for (const member of initializer?.namedChildren ?? []) {
      const left = member.type === 'assignment_expression' ? member.childForFieldName('left') : null;
      const right = member.childForFieldName('right');
      if (left?.type === 'identifier' && right && inferredName(right) === left.text && !hasParseErrors(member) && !hasComment(source, left.startIndex, right.startIndex)) {
        edits.push({ start: left.startIndex, end: right.startIndex, text: '' });
      }
    }
  }

  return edits;
};

// ---------------------------------------------------------------------------------------------
// IDE0049 dotnet_style_predefined_type_for_*
// ---------------------------------------------------------------------------------------------

const FRAMEWORK_TYPES: Record<string, string> = {
  Boolean: 'bool',
  Byte: 'byte',
  SByte: 'sbyte',
  Char: 'char',
  Decimal: 'decimal',
  Double: 'double',
  Single: 'float',
  Int16: 'short',
  UInt16: 'ushort',
  Int32: 'int',
  UInt32: 'uint',
  Int64: 'long',
  UInt64: 'ulong',
  Object: 'object',
  String: 'string',
};

/** Parents in which a name can only be a type. */
const TYPE_POSITIONS: Record<string, true> = {
  type_argument_list: true,
  array_type: true,
  nullable_type: true,
  typeof_expression: true,
  default_expression: true,
  sizeof_expression: true,
  pattern: true,
  as_expression: true,
  is_expression: true,
};

/** Names the file declares (types, members, locals, parameters, type parameters, aliases). */
function declaredNames(root: Node): Set<string> {
  const names = new Set<string>();
  for (const node of findAll(root, ['variable_declarator', 'parameter', 'type_parameter_list', 'using_directive'])) {
    if (node.type === 'type_parameter_list') {
      node.namedChildren.forEach((child) => names.add(child.text));
    } else if (node.type === 'using_directive') {
      const alias = /^using\s+(\w+)\s*=/.exec(node.text);
      if (alias) {
        names.add(alias[1]);
      }
    } else {
      names.add(node.childForFieldName('name')?.text ?? '');
    }
  }

  for (const node of findAll(root, 'identifier')) {
    if (node.parent?.childForFieldName('name') === node && node.parent.type !== 'member_access_expression' && node.parent.type !== 'qualified_name') {
      names.add(node.text);
    }
  }

  return names;
}

/** `Int32 x`, `String.Empty` become `int x`, `string.Empty` (bare names only with `using System;`). */
function predefinedTypes(forDeclarations: boolean, forMemberAccess: boolean): Collect {
  return (_source, root) => {
    const edits: TextEdit[] = [];
    const declared = declaredNames(root);
    const importsSystem = findAll(root, 'using_directive').some((using) => /^(?:global\s+)?using\s+System\s*;$/.test(using.text));

    for (const identifier of findAll(root, 'identifier')) {
      const keyword = FRAMEWORK_TYPES[identifier.text];
      if (!keyword || declared.has(identifier.text) || hasAncestorOfType(identifier, ['using_directive', 'attribute']) || isInNameof(identifier)) {
        continue;
      }

      let node: Node = identifier;
      let parent = identifier.parent;
      const qualifier = parent?.type === 'qualified_name' || parent?.type === 'member_access_expression' ? parent.namedChildren[0] : undefined;
      if (qualifier && qualifier !== identifier) {
        if (qualifier.text !== 'System' || parent!.parent?.type === 'qualified_name') {
          continue;
        }

        node = parent!;
        parent = parent!.parent;
      } else if (!importsSystem) {
        continue;
      }

      const isMemberAccess = parent?.type === 'member_access_expression' && parent.childForFieldName('expression') === node;
      const isType =
        !isMemberAccess &&
        (TYPE_POSITIONS[parent?.type ?? ''] === true ||
          (parent?.childForFieldName('type') === node && parent.type !== 'member_access_expression') ||
          parent?.type === 'qualified_name');
      if ((isMemberAccess && forMemberAccess) || (isType && forDeclarations && node.type !== 'member_access_expression')) {
        edits.push({ start: node.startIndex, end: node.endIndex, text: keyword });
      }
    }

    return edits;
  };
}

function hasAncestorOfType(node: Node, types: readonly string[]): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (types.includes(current.type)) {
      return true;
    }
  }

  return false;
}

function isInNameof(node: Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === 'invocation_expression' && current.childForFieldName('function')?.text === 'nameof') {
      return true;
    }
  }

  return false;
}


// ---------------------------------------------------------------------------------------------
// IDE0033 dotnet_style_explicit_tuple_names
// ---------------------------------------------------------------------------------------------

/** `t.Item1` becomes `t.count` when `t` is declared in the file with the tuple type `(int count, ...)`. */
const explicitTupleNames: Collect = (_source, root) => {
  const edits: TextEdit[] = [];
  for (const access of findAll(root, 'member_access_expression')) {
    const receiver = access.childForFieldName('expression');
    const name = access.childForFieldName('name');
    const item = name ? /^Item(\d+)$/.exec(name.text) : null;
    const type = receiver?.type === 'identifier' && item ? declaredTypeNode(receiver) : undefined;
    const elements = type?.type === 'tuple_type' ? tupleElements(type) : undefined;
    const element = elements?.[Number(item?.[1]) - 1];
    if (element?.name && name) {
      edits.push({ start: name.startIndex, end: name.endIndex, text: element.name });
    }
  }

  return edits;
};

// ---------------------------------------------------------------------------------------------
// IDE0071 dotnet_style_prefer_simplified_interpolation
// ---------------------------------------------------------------------------------------------

const STRING_TYPES = /^(?:string|String|System\.String)\??$/;

/**
 * True when the interpolated string is known to become a `string` (not a `FormattableString` or
 * an interpolated string handler, which would receive the hole values themselves).
 */
function isStringInterpolation(interpolation: Node): boolean {
  const parent = interpolation.parent;
  if (parent?.type === 'binary_expression' && operatorOf(parent) === '+') {
    return true;
  }

  if (parent?.type === 'return_statement') {
    return STRING_TYPES.test(returnType(parent) ?? '');
  }

  const declaration = parent?.type === 'equals_value_clause' ? parent.parent?.parent : undefined;
  const type = declaration?.type === 'variable_declaration' ? declaration.childForFieldName('type') : null;

  return type !== null && type !== undefined && (type.type === 'implicit_type' || STRING_TYPES.test(type.text));
}

/** The `{...}` holes of a regular `$"..."` string: offsets of the hole content within `text`. */
function interpolationHoles(text: string): { start: number; end: number }[] | undefined {
  const holes: { start: number; end: number }[] = [];
  for (let i = 2; i < text.length - 1; i++) {
    if (text[i] === '\\') {
      i++;
    } else if (text[i] === '{' && text[i + 1] === '{') {
      i++;
    } else if (text[i] === '{') {
      let depth = 0;
      let j = i + 1;
      for (; j < text.length - 1; j++) {
        const ch = text[j];
        if (ch === '"' || ch === "'") {
          const end = text.indexOf(ch, j + 1);
          if (end < 0 || text.slice(j + 1, end).includes('\\')) {
            return undefined;
          }

          j = end;
        } else if (ch === '(' || ch === '[' || ch === '{') {
          depth++;
        } else if (ch === ')' || ch === ']' || (ch === '}' && depth > 0)) {
          depth--;
        } else if (ch === '}') {
          break;
        }
      }

      if (j >= text.length - 1) {
        return undefined;
      }

      holes.push({ start: i + 1, end: j });
      i = j;
    }
  }

  return holes;
}

/**
 * `$"{x.ToString()}"` becomes `$"{x}"` and `$"{x.ToString("N2")}"` becomes `$"{x:N2}"` when `x`
 * is declared as a built-in value type or an enum: a hole formats a null reference as an empty
 * string where `ToString()` throws, and a type's own `IFormattable.ToString` may differ from its
 * `ToString()` (https://learn.microsoft.com/dotnet/csharp/language-reference/tokens/interpolated#structure-of-an-interpolated-string).
 */
function simplifiedInterpolations(report: EditorConfigIssueReporter): Collect {
  return (source, root) => {
    const edits: TextEdit[] = [];
    for (const interpolation of findAll(root, 'interpolated_string_expression')) {
      const text = interpolation.text;
      const holes = text.startsWith('$"') && !text.startsWith('$"""') && isStringInterpolation(interpolation) ? interpolationHoles(text) : undefined;
      for (const hole of holes ?? []) {
        const content = text.slice(hole.start, hole.end);
        const match = /^\s*((?:this|[A-Za-z_]\w*)(?:\.[A-Za-z_]\w*)*)\.ToString\(\s*(?:"([^"\\{}]*)")?\s*\)\s*$/.exec(content);
        if (!match || match[2] === '') {
          continue;
        }

        const start = interpolation.startIndex + hole.start;
        const end = interpolation.startIndex + hole.end;
        // The parser keeps holes as text: the receiver is looked up by name from the string.
        const type = /^[A-Za-z_]\w*$/.test(match[1]) ? declaredTypeText(interpolation, match[1]) : undefined;
        const formattable = findAll(root, 'struct_declaration').some(
          (declaration) => declaration.childForFieldName('name')?.text === type && /\bIFormattable\b/.test(declaration.text)
        );
        if (!isNonNullableValueType(type, root) || formattable) {
          report(
            describeIssue(
              'IDE0071',
              'dotnet_style_prefer_simplified_interpolation',
              source,
              start,
              `'${content.trim()}' was kept: '${match[1]}' is not declared as a built-in value type or enum, so without ToString() the hole could format it differently or not throw on null.`
            )
          );
          continue;
        }

        edits.push({ start, end, text: match[2] === undefined ? match[1] : `${match[1]}:${match[2]}` });
      }
    }

    return edits;
  };
}

// ---------------------------------------------------------------------------------------------
// IDE0170 csharp_style_prefer_extended_property_pattern
// ---------------------------------------------------------------------------------------------

/** Splits `text` at commas that are not nested in braces, brackets or parentheses. */
function topLevelParts(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if ('{[('.includes(text[i])) {
      depth++;
    } else if ('}])'.includes(text[i])) {
      depth--;
    } else if (text[i] === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }

  parts.push(text.slice(start));

  return parts;
}

/** `{ A: { B: p } }` becomes `{ A.B: p }` when the nested pattern has no type, designation or other member. */
function extendPropertyPatterns(pattern: string): string {
  let current = pattern;
  for (let changed = true; changed; ) {
    changed = false;
    const opener = /([{,]\s*)([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*:\s*\{/g;
    for (let match = opener.exec(current); match; match = opener.exec(current)) {
      const open = match.index + match[0].length - 1;
      let depth = 0;
      let close = open;
      for (; close < current.length; close++) {
        depth += current[close] === '{' ? 1 : current[close] === '}' ? -1 : 0;
        if (depth === 0) {
          break;
        }
      }

      const inner = current.slice(open + 1, close);
      const parts = topLevelParts(inner);
      const member = parts.length === 1 ? /^\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*:\s*([\s\S]+?)\s*$/.exec(parts[0]) : null;
      const after = current.slice(close + 1).trimStart();
      if (!member || !/^[,}]/.test(after)) {
        continue;
      }

      const nameStart = match.index + match[1].length;
      current = `${current.slice(0, nameStart)}${match[2]}.${member[1]}: ${member[2]}${current.slice(close + 1)}`;
      changed = true;
      break;
    }
  }

  return current;
}

const extendedPropertyPatterns: Collect = (_source, root) => {
  const edits: TextEdit[] = [];
  for (const pattern of findAll(root, 'pattern')) {
    if (/["'/]/.test(pattern.text) || pattern.parent?.type !== 'is_pattern_expression' || hasParseErrors(pattern)) {
      continue;
    }

    const rewritten = extendPropertyPatterns(pattern.text);
    if (rewritten !== pattern.text) {
      edits.push({ start: pattern.startIndex, end: pattern.endIndex, text: rewritten });
    }
  }

  return edits;
};

// ---------------------------------------------------------------------------------------------
// IDE0200 csharp_style_prefer_method_group_conversion
// ---------------------------------------------------------------------------------------------

const METHOD_GROUP_OPTION = 'csharp_style_prefer_method_group_conversion';

/** The lambda's parameter names and explicit types, or `undefined` when one has a modifier. */
function forwardedParameters(lambda: Node): { name: string; type?: string }[] | undefined {
  const list = lambda.childForFieldName('parameters');
  if (list?.type === 'identifier') {
    return [{ name: list.text }];
  }

  const parameters = list?.namedChildren.filter((child) => child.type === 'parameter') ?? [];
  if (!list || parameters.some((parameter) => parameter.children.length !== (parameter.childForFieldName('type') ? 2 : 1))) {
    return undefined;
  }

  return parameters.map((parameter) => ({ name: parameter.childForFieldName('name')?.text ?? '', type: parameter.childForFieldName('type')?.text.replace(/\s+/g, '') }));
}

/**
 * `x => M(x)` becomes `M` when `M` is the file's only method or local function of that name,
 * not generic, and its parameter and return types equal the delegate's (written as `Func`/`Action`
 * of the variable, or as the lambda's parameter types for a `void` method). Other lambdas that
 * only forward their parameters are reported.
 */
function methodGroups(report: EditorConfigIssueReporter): Collect {
  return (source, root) => {
    const edits: TextEdit[] = [];
    const methods = findAll(root, ['method_declaration', 'local_function_statement']);
    for (const lambda of findAll(root, 'lambda_expression')) {
      const body = lambda.childForFieldName('body');
      const callee = body?.type === 'invocation_expression' ? body.childForFieldName('function') : null;
      const args = body?.childForFieldName('arguments')?.namedChildren ?? [];
      const parameters = forwardedParameters(lambda);
      const forwards =
        parameters !== undefined &&
        args.length === parameters.length &&
        args.every((argument, index) => argument.text === parameters[index].name) &&
        (callee?.type === 'identifier' || callee?.type === 'member_access_expression');
      const modifiers = /\b(?:async|static)\s*$/.test(source.slice(lineStartAt(source, lambda.startIndex), lambda.startIndex));
      if (!forwards || modifiers || !callee || isInPossibleExpressionTree(lambda) || hasParseErrors(lambda)) {
        continue;
      }

      const declared = lambda.parent?.type === 'equals_value_clause' ? lambda.parent.parent?.parent?.childForFieldName('type') : undefined;
      const delegateTypes = delegateParameterTypes(declared ?? undefined)?.map((type) => type.replace(/\s+/g, ''));
      const typeArgs = declared?.namedChildren.find((child) => child.type === 'type_argument_list')?.namedChildren ?? [];
      const returns = declared?.namedChildren[0]?.text === 'Func' ? typeArgs[typeArgs.length - 1]?.text.replace(/\s+/g, '') : delegateTypes ? 'void' : undefined;
      const parameterTypes = delegateTypes ?? (parameters!.every((parameter) => parameter.type) ? parameters!.map((parameter) => parameter.type!) : undefined);
      const candidates = callee.type === 'identifier' ? methods.filter((method) => method.childForFieldName('name')?.text === callee.text) : [];
      const method = candidates.length === 1 ? candidates[0] : undefined;
      const methodParameters = method?.childForFieldName('parameters')?.namedChildren.filter((child) => child.type === 'parameter') ?? [];
      const methodReturns = method?.childForFieldName('type')?.text.replace(/\s+/g, '');
      const matches =
        method !== undefined &&
        !method.namedChildren.some((child) => child.type === 'type_parameter_list' || child.type === 'attribute_list') &&
        parameterTypes !== undefined &&
        methodParameters.length === parameterTypes.length &&
        methodParameters.every(
          (parameter, index) => parameter.children.length === 2 && parameter.childForFieldName('type')?.text.replace(/\s+/g, '') === parameterTypes[index]
        ) &&
        (returns === undefined ? methodReturns === 'void' : methodReturns === returns);
      if (matches) {
        edits.push({ start: lambda.startIndex, end: lambda.endIndex, text: callee.text });
      } else {
        report(
          describeIssue('IDE0200', METHOD_GROUP_OPTION, source, lambda.startIndex, `the lambda was not replaced by '${callee.text}': the delegate and method types are not both known from the file.`)
        );
      }
    }

    return edits;
  };
}

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

export const OPERATOR_RULES: readonly Rule[] = [
  whenPreferred('dotnet_style_prefer_is_null_check_over_reference_equality_method', isNullOverReferenceEquals),
  whenPreferred('csharp_style_prefer_not_pattern', notPatterns),
  whenPreferred('csharp_style_prefer_pattern_matching', patternCombinators),
  whenPreferred('dotnet_style_coalesce_expression', coalesceExpressions),
  whenPreferred('dotnet_style_null_propagation', nullPropagation),
  whenPreferred('csharp_style_conditional_delegate_call', conditionalDelegateCalls),
  whenPreferred('dotnet_style_prefer_simplified_boolean_expressions', simplifiedBooleans),
  whenPreferred('dotnet_style_prefer_compound_assignment', compoundAssignment),
  whenPreferred('dotnet_style_prefer_inferred_tuple_names', inferredTupleNames),
  whenPreferred('dotnet_style_prefer_inferred_anonymous_type_member_names', inferredAnonymousNames),
  {
    option: 'dotnet_style_predefined_type_for_*',
    apply: (source, { props }) => {
      const forDeclarations = effectiveEditorConfigValue(props, 'dotnet_style_predefined_type_for_locals_parameters_members') === 'true';
      const forMemberAccess = effectiveEditorConfigValue(props, 'dotnet_style_predefined_type_for_member_access') === 'true';

      return forDeclarations || forMemberAccess ? rewrite(source, predefinedTypes(forDeclarations, forMemberAccess)) : source;
    },
  },
  parenthesesRule(),
  whenPreferred('dotnet_style_explicit_tuple_names', explicitTupleNames),
  {
    option: 'dotnet_style_prefer_simplified_interpolation',
    // Reports as it goes, so it makes one pass: its rewrites never nest.
    apply: (source, { props, report }) => {
      if (effectiveEditorConfigValue(props, 'dotnet_style_prefer_simplified_interpolation') !== 'true') {
        return source;
      }

      const tree = parseCSharp(source);
      try {
        return applyEdits(source, simplifiedInterpolations(report)(source, tree.rootNode));
      } finally {
        tree.delete();
      }
    },
  },
  whenPreferred('csharp_style_prefer_extended_property_pattern', extendedPropertyPatterns),
  {
    option: METHOD_GROUP_OPTION,
    // Reports as it goes, so it makes one pass: the rewrite it does never enables another.
    apply: (source, { props, report }) => {
      if (effectiveEditorConfigValue(props, METHOD_GROUP_OPTION) !== 'true') {
        return source;
      }

      const tree = parseCSharp(source);
      try {
        return applyEdits(source, methodGroups(report)(source, tree.rootNode));
      } finally {
        tree.delete();
      }
    },
  },
];
