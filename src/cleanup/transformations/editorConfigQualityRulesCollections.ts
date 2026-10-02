import { Node, TextEdit, applyEdits, walk } from '../parser';
import type { RuleContext } from './editorConfigCodeStyle';
import { FileView, countComparison, positionalArguments, viewOf } from './editorConfigQualityRulesExpressions';
import { targetFrameworksOf } from './editorConfigQualityRulesProject';
import { frameworksSupport, isGenericType, isInsideLambda, isRuleActive, simpleTypeName, unwrapParentheses } from './editorConfigQualityRulesSupport';

/**
 * Collection code-quality rules: CA1836 (IsEmpty), CA1841 (ContainsKey/ContainsValue), CA1854
 * (TryGetValue), CA1864 (TryAdd) and CA1868 (Add/Remove without Contains). A rewrite needs the
 * collection's declared type from the file and expressions whose evaluation the rewrite cannot
 * reorder; a violation found without that proof is reported.
 */

// ---------------------------------------------------------------------------------------------
// Shared syntax helpers
// ---------------------------------------------------------------------------------------------

/** `name(args)` called on a receiver: `receiver.name(args)`. */
interface MemberCall {
  readonly invocation: Node;
  readonly receiver: Node;
  readonly name: string;
  readonly args: readonly Node[];
}

function memberCall(node: Node | null | undefined): MemberCall | undefined {
  const invocation = node ? unwrapParentheses(node) : undefined;
  const callee = invocation?.type === 'invocation_expression' ? invocation.childForFieldName('function') : null;
  const receiver = callee?.type === 'member_access_expression' ? callee.childForFieldName('expression') : null;
  const name = callee?.childForFieldName('name')?.text;
  const args = invocation ? positionalArguments(invocation) : undefined;

  return invocation && receiver && name && args ? { invocation, receiver, name, args } : undefined;
}

/**
 * An expression whose evaluation has no effect and yields the same value when repeated or moved
 * across the rewritten code: a literal, a simple name, or `this.name`.
 */
export function isStableExpression(node: Node): boolean {
  const expression = unwrapParentheses(node);
  switch (expression.type) {
    case 'identifier':
    case 'string_literal':
    case 'verbatim_string_literal':
    case 'character_literal':
    case 'integer_literal':
    case 'real_literal':
    case 'boolean_literal':
    case 'null_literal':
      return true;
    case 'member_access_expression':
      return expression.childForFieldName('expression')?.type === 'this_expression' && expression.childForFieldName('name')?.type === 'identifier';
    default:
      return false;
  }
}

/** The simple name an identifier or `this.name` expression refers to. */
function referencedName(node: Node): string | undefined {
  const expression = unwrapParentheses(node);
  if (expression.type === 'identifier') {
    return expression.text;
  }

  return expression.type === 'member_access_expression' ? expression.childForFieldName('name')?.text : undefined;
}

const sameExpression = (a: Node, b: Node): boolean => unwrapParentheses(a).text.replace(/\s+/g, '') === unwrapParentheses(b).text.replace(/\s+/g, '');

/** The declared generic collection type of an expression (simple name), unless the project declares a type of that name. */
function collectionType(view: FileView, expression: Node): string | undefined {
  if (!isStableExpression(expression)) {
    return undefined;
  }

  const type = view.types.typeOf(expression);
  const name = type ? simpleTypeName(type) : undefined;

  return type && name && isGenericType(type) && !view.types.declaresType(name) ? name : undefined;
}

/** The `if` statement's condition, consequence and `else` statement. */
function ifParts(statement: Node): { condition: Node; consequence: Node; alternative?: Node } | undefined {
  const [condition, consequence, alternative] = statement.namedChildren;

  return condition && consequence ? { condition, consequence, alternative } : undefined;
}

/** The negated operand of `!operand`, if `node` is one. */
function negatedOperand(node: Node): Node | undefined {
  const expression = unwrapParentheses(node);

  return expression.type === 'prefix_unary_expression' && expression.children[0]?.type === '!' ? expression.namedChildren[0] : undefined;
}

/** The statements of a block, or the single embedded statement. */
function statementsOf(statement: Node): Node[] {
  return statement.type === 'block' ? statement.namedChildren.filter((child) => child.type !== 'comment') : [statement];
}

/** Nodes that run their body later, or more than once: a use there is not ordered with the guard. */
const DEFERRED = new Set(['lambda_expression', 'anonymous_method_expression', 'local_function_statement']);
const LOOPS = new Set(['for_statement', 'for_each_statement', 'while_statement', 'do_statement']);

/** `node` and its ancestors of one of `types`, below `stop` (none when `node` is `stop`). */
function ancestorsWithin(node: Node, types: ReadonlySet<string>, stop?: Node): Node[] {
  const ancestors: Node[] = [];
  for (let current: Node | null = node; current && current !== stop; current = current.parent) {
    if (types.has(current.type)) {
      ancestors.push(current);
    }
  }

  return ancestors;
}

/** Expressions that may change state: calls, creations, assignments, increments and awaits. */
function isEffect(node: Node): boolean {
  switch (node.type) {
    case 'invocation_expression':
    case 'object_creation_expression':
    case 'implicit_object_creation_expression':
    case 'assignment_expression':
    case 'await_expression':
      return true;
    case 'prefix_unary_expression':
    case 'postfix_unary_expression':
      return node.children.some((child) => child.type === '++' || child.type === '--');
    default:
      return false;
  }
}

/** Whether `node` is written to: assigned, incremented, or passed by reference. */
function isWritten(node: Node): boolean {
  const parent = node.parent;
  if (!parent) {
    return false;
  }

  if (parent.type === 'assignment_expression') {
    return parent.childForFieldName('left') === node;
  }

  if (parent.type === 'prefix_unary_expression' || parent.type === 'postfix_unary_expression') {
    return parent.children.some((child) => child.type === '++' || child.type === '--');
  }

  return parent.type === 'argument' && /^(?:ref|out|in)\b/.test(parent.text);
}

/** Removes a statement, with its line when it stands alone on it. */
function removeStatementEdit(source: string, statement: Node): TextEdit {
  const lineStart = source.lastIndexOf('\n', statement.startIndex - 1) + 1;
  const lineEnd = source.indexOf('\n', statement.endIndex);
  const end = lineEnd < 0 ? source.length : lineEnd;
  if (/^\s*$/.test(source.slice(lineStart, statement.startIndex)) && /^\s*$/.test(source.slice(statement.endIndex, end))) {
    return { start: lineStart, end: lineEnd < 0 ? end : end + 1, text: '' };
  }

  const following = /^[ \t]*/.exec(source.slice(statement.endIndex))?.[0].length ?? 0;

  return { start: statement.startIndex, end: statement.endIndex + following, text: '' };
}

/**
 * A guard `if (<condition>) { <call>; ... }` rewritten to use the call's own result: the whole
 * statement becomes `<call>;` when the call is its only content, else the condition becomes the
 * call (negated when `negate`) and the call statement goes.
 */
function replaceGuard(source: string, statement: Node, consequence: Node, callStatement: Node, callText: string, negate: boolean): TextEdit[] {
  const rest = statementsOf(consequence).filter((child) => child !== callStatement);
  const remainder = source.slice(consequence.startIndex, consequence.endIndex).replace(callStatement.text, '').replace(/[{}\s]/g, '');
  if (rest.length === 0 && remainder === '' && !negate) {
    return [{ start: statement.startIndex, end: statement.endIndex, text: `${callText};` }];
  }

  const condition = statement.namedChildren[0];

  return [{ start: condition.startIndex, end: condition.endIndex, text: negate ? `!${callText}` : callText }, removeStatementEdit(source, callStatement)];
}

// ---------------------------------------------------------------------------------------------
// CA1854 Prefer the IDictionary.TryGetValue(TKey, out TValue) method
// ---------------------------------------------------------------------------------------------

const DICTIONARY_TYPES = new Set([
  'Dictionary', 'IDictionary', 'IReadOnlyDictionary', 'SortedDictionary', 'SortedList', 'ConcurrentDictionary', 'ReadOnlyDictionary',
  'ImmutableDictionary', 'IImmutableDictionary', 'ImmutableSortedDictionary', 'FrozenDictionary',
]);

/** Accessors whose body has the implicit `value` parameter. */
const VALUE_ACCESSORS = /^(?:set|init|add|remove)\b/;

export function applyTryGetValue(source: string, context: RuleContext): string {
  if (!isRuleActive(context, 'CA1854', source) || !/\.\s*ContainsKey\s*\(/.test(source)) {
    return source;
  }

  const view = viewOf(source, context);
  const oldLanguage = context.project?.languageVersion !== undefined && context.project.languageVersion < 7;
  const claimed = new Map<Node, Set<string>>();
  for (const node of walk(view.model.root)) {
    const guard = node.type === 'if_statement' ? ifParts(node) : undefined;
    const conditional = node.type === 'conditional_expression' ? node.namedChildren : undefined;
    const condition = guard?.condition ?? conditional?.[0];
    const guarded = guard?.consequence ?? conditional?.[1];
    const call = memberCall(condition);
    if (!condition || !guarded || !call || call.name !== 'ContainsKey' || call.args.length !== 1 || unwrapParentheses(condition) !== call.invocation) {
      continue;
    }

    const key = call.args[0];
    const reads = walk(guarded).filter(
      (candidate) =>
        candidate.type === 'element_access_expression' &&
        sameExpression(candidate.childForFieldName('expression') ?? candidate, call.receiver) &&
        (candidate.childForFieldName('subscript')?.namedChildren.length ?? 0) === 1 &&
        sameExpression(candidate.childForFieldName('subscript')?.namedChildren[0] ?? candidate, key)
    );
    if (reads.length === 0 || reads.every(isWritten) || view.suppressions.isSuppressed('CA1854', node)) {
      continue;
    }

    const describe = `${call.invocation.text} guards ${reads[0].text}`;
    const type = collectionType(view, call.receiver);
    const problem =
      type === undefined || !DICTIONARY_TYPES.has(type)
        ? `the type of ${call.receiver.text} cannot be determined syntactically`
        : oldLanguage
          ? 'the project\'s C# version has no out variables'
          : !isStableExpression(key)
            ? `${key.text} may not evaluate to the same key twice`
            : tryGetValueBlocker(guarded, reads, call.receiver, key, node);
    if (problem) {
      view.report('CA1854', node, `${describe}, but ${problem}; it was kept.`);
      continue;
    }

    const member = enclosingMember(node);
    const taken = claimed.get(member) ?? new Set<string>();
    claimed.set(member, taken);
    const name = freeValueName(member, node, taken);
    taken.add(name);
    view.edits.push({ start: call.invocation.startIndex, end: call.invocation.endIndex, text: `${call.receiver.text}.TryGetValue(${key.text}, out var ${name})` });
    for (const read of reads) {
      view.edits.push({ start: read.startIndex, end: read.endIndex, text: name });
    }
  }

  return applyEdits(source, view.edits);
}

/** Why the guarded reads cannot become one TryGetValue, or `undefined` when they can. */
function tryGetValueBlocker(guarded: Node, reads: readonly Node[], dictionary: Node, key: Node, guard: Node): string | undefined {
  if (ancestorsWithin(guard, new Set(['query_expression'])).length > 0) {
    return 'out variables are not allowed in a query';
  }

  // A statement lambda is never an expression tree; an expression-bodied one may be.
  if (guard.type === 'conditional_expression' && isInsideLambda(guard)) {
    return 'it is inside a lambda that may be an expression tree, which cannot declare an out variable';
  }

  if (reads.some(isWritten)) {
    return `${reads[0].text} is also assigned`;
  }

  if (reads.some((read) => ancestorsWithin(read, DEFERRED, guarded).length > 0)) {
    return `${reads[0].text} is read in a lambda or local function, which may run after the dictionary changed`;
  }

  if (reads.length > 1 && reads.some((read) => read.parent?.type === 'member_access_expression' || read.parent?.type === 'invocation_expression')) {
    return `a member of ${reads[0].text} is used, and a struct value copied once could observe its own changes`;
  }

  const dictionaryName = referencedName(dictionary);
  const keyName = referencedName(key);
  const readNodes = new Set(reads.flatMap((read) => walk(read)));
  for (const candidate of walk(guarded)) {
    if (candidate.type === 'identifier' && !readNodes.has(candidate)) {
      if (candidate.text === dictionaryName) {
        return `${dictionary.text} is used otherwise in the guarded code`;
      }

      if (candidate.text === keyName && isWritten(candidate)) {
        return `${key.text} is changed in the guarded code`;
      }
    }
  }

  // The value is read once, at the guard: nothing may run between the guard and a read, and in a
  // loop that reads it, nothing may run at all, since the next iteration reads it again.
  const lastRead = Math.max(...reads.map((read) => read.startIndex));
  const loopsWithRead = reads.flatMap((read) => ancestorsWithin(read, LOOPS, guarded));
  for (const candidate of walk(guarded)) {
    if (!isEffect(candidate)) {
      continue;
    }

    const repeatedRead = loopsWithRead.some((loop) => isAncestor(loop, candidate));
    const beforeRead = candidate.endIndex <= lastRead && !reads.some((read) => isAncestor(candidate, read));
    if (repeatedRead || beforeRead) {
      return `${candidate.text} runs between the guard and a read and may change the dictionary`;
    }
  }

  return undefined;
}

function isAncestor(ancestor: Node, node: Node): boolean {
  for (let current: Node | null = node; current; current = current.parent) {
    if (current === ancestor) {
      return true;
    }
  }

  return false;
}

const MEMBER_DECLARATIONS = new Set([
  'method_declaration', 'constructor_declaration', 'destructor_declaration', 'operator_declaration', 'conversion_operator_declaration',
  'property_declaration', 'indexer_declaration', 'event_declaration', 'field_declaration', 'accessor_declaration', 'local_function_statement',
]);

/** The member (or accessor) declaring the node: the scope an out variable name must be unique in. */
function enclosingMember(node: Node): Node {
  let root = node;
  for (let current = node.parent; current; current = current.parent) {
    if (MEMBER_DECLARATIONS.has(current.type) && current.type !== 'accessor_declaration' && current.type !== 'local_function_statement') {
      return current;
    }

    root = current;
  }

  return root;
}

/** `value`, else `value1`, `value2`...: a name no identifier of the member uses. */
function freeValueName(member: Node, node: Node, taken: ReadonlySet<string>): string {
  const used = new Set(walk(member).filter((candidate) => candidate.type === 'identifier').map((candidate) => candidate.text));
  let implicitValue = member.type === 'indexer_declaration' || member.type === 'event_declaration';
  for (let current = node.parent; current && current !== member; current = current.parent) {
    implicitValue ||= current.type === 'accessor_declaration' && VALUE_ACCESSORS.test(current.text);
  }

  for (let index = 0; ; index++) {
    const name = index === 0 ? 'value' : `value${index}`;
    if (!used.has(name) && !taken.has(name) && !(name === 'value' && implicitValue)) {
      return name;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// CA1841 Prefer Dictionary.Contains methods
// ---------------------------------------------------------------------------------------------

/** Dictionaries whose Keys/Values collections answer Contains exactly as ContainsKey/ContainsValue. */
const CONTAINS_FIXABLE = new Set(['Dictionary', 'SortedDictionary']);
const HAS_CONTAINS_VALUE = new Set(['Dictionary', 'SortedDictionary', 'SortedList', 'ImmutableDictionary', 'ImmutableSortedDictionary']);

export function applyDictionaryContains(source: string, context: RuleContext): string {
  if (!isRuleActive(context, 'CA1841', source) || !/\.\s*(?:Keys|Values)\s*\.\s*Contains\s*\(/.test(source)) {
    return source;
  }

  const view = viewOf(source, context);
  for (const node of walk(view.model.root)) {
    const call = node.type === 'invocation_expression' ? memberCall(node) : undefined;
    const collection = call?.receiver.type === 'member_access_expression' ? call.receiver : undefined;
    const property = collection?.childForFieldName('name')?.text;
    const dictionary = collection?.childForFieldName('expression');
    if (!call || call.name !== 'Contains' || call.args.length !== 1 || !dictionary || (property !== 'Keys' && property !== 'Values')) {
      continue;
    }

    const type = collectionType(view, dictionary);
    if (!type || !DICTIONARY_TYPES.has(type) || (property === 'Values' && !HAS_CONTAINS_VALUE.has(type)) || view.suppressions.isSuppressed('CA1841', node)) {
      continue;
    }

    const method = property === 'Keys' ? 'ContainsKey' : 'ContainsValue';
    if (!CONTAINS_FIXABLE.has(type)) {
      view.report('CA1841', node, `${node.text} could call ${method}, but the ${property} collection of ${type} may not compare like ${method}; it was kept.`);
      continue;
    }

    view.edits.push({ start: node.startIndex, end: node.endIndex, text: `${dictionary.text}.${method}(${call.args[0].text})` });
  }

  return applyEdits(source, view.edits);
}

// ---------------------------------------------------------------------------------------------
// CA1836 Prefer IsEmpty over Count when available
// ---------------------------------------------------------------------------------------------

/** Types with an `IsEmpty` property, by the property their size is read from. */
const IS_EMPTY_TYPES: Record<string, 'Count' | 'Length'> = {
  ConcurrentQueue: 'Count',
  ConcurrentStack: 'Count',
  ConcurrentBag: 'Count',
  ConcurrentDictionary: 'Count',
  ImmutableList: 'Count',
  ImmutableHashSet: 'Count',
  ImmutableSortedSet: 'Count',
  ImmutableDictionary: 'Count',
  ImmutableSortedDictionary: 'Count',
  ImmutableArray: 'Length',
  Span: 'Length',
  ReadOnlySpan: 'Length',
  Memory: 'Length',
  ReadOnlyMemory: 'Length',
};

export function applyPreferIsEmpty(source: string, context: RuleContext): string {
  if (!isRuleActive(context, 'CA1836', source) || !/\b(?:Count|Length)\b/.test(source)) {
    return source;
  }

  const view = viewOf(source, context);
  for (const node of walk(view.model.root)) {
    let receiver: Node | null | undefined;
    let size: string | undefined;
    if (node.type === 'member_access_expression' && node.parent?.type !== 'invocation_expression') {
      receiver = node.childForFieldName('expression');
      size = node.childForFieldName('name')?.text;
    } else if (node.type === 'invocation_expression') {
      const call = memberCall(node);
      receiver = call?.name === 'Count' && call.args.length === 0 ? call.receiver : undefined;
      size = receiver ? 'Count()' : undefined;
    }

    const type = receiver ? collectionType(view, receiver) : undefined;
    const property = type ? IS_EMPTY_TYPES[type] : undefined;
    if (!receiver || !property || (size !== property && size !== 'Count()')) {
      continue;
    }

    const comparison = countComparison(node);
    if (!comparison || view.suppressions.isSuppressed('CA1836', comparison.comparison)) {
      continue;
    }

    view.edits.push({ start: comparison.comparison.startIndex, end: comparison.comparison.endIndex, text: `${comparison.empty ? '' : '!'}${receiver.text}.IsEmpty` });
  }

  return applyEdits(source, view.edits);
}

// ---------------------------------------------------------------------------------------------
// CA1864 Prefer the IDictionary.TryAdd(TKey, TValue) method
// CA1868 Unnecessary call to 'Contains' for sets
// ---------------------------------------------------------------------------------------------

/** Collections whose `Add` returns whether the item was added / whose `Remove` whether it was removed. */
const SET_ADD_TYPES = new Set(['HashSet', 'SortedSet']);
const REMOVE_TYPES = new Set(['HashSet', 'SortedSet', 'List']);

export function applyGuardedAdds(source: string, context: RuleContext): string {
  const tryAdd = isRuleActive(context, 'CA1864', source);
  const contains = isRuleActive(context, 'CA1868', source);
  if ((!tryAdd && !contains) || !/\.\s*(?:ContainsKey|Contains)\s*\(/.test(source)) {
    return source;
  }

  const view = viewOf(source, context);
  const tryAddSupport = frameworksSupport(targetFrameworksOf(context.project), 'coreApis');
  for (const statement of walk(view.model.root)) {
    const parts = statement.type === 'if_statement' ? ifParts(statement) : undefined;
    if (!parts || parts.alternative) {
      continue;
    }

    const negated = negatedOperand(parts.condition);
    const guard = memberCall(negated ?? parts.condition);
    const first = statementsOf(parts.consequence)[0];
    const action = first?.type === 'expression_statement' ? memberCall(first.namedChildren[0]) : undefined;
    if (!guard || !action || !first || guard.args.length !== 1 || !sameExpression(guard.receiver, action.receiver) || !sameExpression(guard.args[0], action.args[0] ?? guard.receiver)) {
      continue;
    }

    const type = collectionType(view, guard.receiver);
    if (tryAdd && negated && guard.name === 'ContainsKey' && action.name === 'Add' && action.args.length === 2 && !view.suppressions.isSuppressed('CA1864', statement)) {
      if (type !== 'Dictionary' || tryAddSupport === false) {
        continue;
      }

      const value = action.args[1];
      const problem = !isStableExpression(guard.args[0])
        ? `${guard.args[0].text} may not evaluate to the same key twice`
        : !isStableExpression(value)
          ? `TryAdd would evaluate ${value.text} even when the key is present`
          : tryAddSupport === undefined
            ? "the project's target framework is unknown, so TryAdd may not exist"
            : undefined;
      if (problem) {
        view.report('CA1864', statement, `${guard.receiver.text}.Add is guarded by ContainsKey, but ${problem}; it was kept.`);
        continue;
      }

      view.edits.push(...replaceGuard(source, statement, parts.consequence, first, `${guard.receiver.text}.TryAdd(${guard.args[0].text}, ${value.text})`, false));
      continue;
    }

    const setAdd = negated && action.name === 'Add' && type !== undefined && SET_ADD_TYPES.has(type);
    const remove = !negated && action.name === 'Remove' && type !== undefined && REMOVE_TYPES.has(type);
    if (!contains || guard.name !== 'Contains' || action.args.length !== 1 || (!setAdd && !remove) || view.suppressions.isSuppressed('CA1868', statement)) {
      continue;
    }

    if (!isStableExpression(guard.args[0])) {
      view.report('CA1868', statement, `${action.invocation.text} is guarded by Contains, but ${guard.args[0].text} may not evaluate to the same item twice; it was kept.`);
      continue;
    }

    view.edits.push(...replaceGuard(source, statement, parts.consequence, first, action.invocation.text, false));
  }

  return applyEdits(source, view.edits);
}
