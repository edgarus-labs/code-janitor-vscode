import { EditorConfigProperties } from '../editorconfig';
import { effectiveEditorConfigValue } from '../editorConfigRegistry';
import { Node, TextEdit, applyEdits, findAll, parseCSharp } from '../parser';
import { EditorConfigIssueReporter, describeIssue, hasParseErrors } from './editorConfigSupport';
import { isInPossibleExpressionTree } from './nullCheckPatternMatching';
import { isNonNullableValueType } from './typeFacts';

/**
 * Expression-level code-style preferences. Each rewrite is made only where the result is certain
 * from syntax alone (the types involved are written in the file) and never inside a lambda that
 * could become an expression tree, where newer syntax does not compile.
 */

type ExpressionRule = (source: string, root: Node, props: EditorConfigProperties, report: EditorConfigIssueReporter) => TextEdit[];

interface PreferenceRule {
  readonly option: string;
  readonly apply: ExpressionRule;
}

export const EXPRESSION_PREFERENCES: readonly PreferenceRule[] = [
  { option: 'csharp_style_implicit_object_creation_when_type_is_apparent', apply: implicitObjectCreation },
  { option: 'csharp_prefer_simple_default_expression', apply: simpleDefaultExpression },
  { option: 'csharp_style_prefer_index_operator', apply: indexOperator },
  { option: 'csharp_style_prefer_range_operator', apply: rangeOperator },
  { option: 'csharp_style_prefer_null_check_over_type_check', apply: nullCheckOverTypeCheck },
  { option: 'csharp_style_prefer_unbound_generic_type_in_nameof', apply: unboundGenericTypeInNameof },
  { option: 'csharp_style_prefer_utf8_string_literals', apply: utf8StringLiterals },
  { option: 'csharp_style_prefer_implicitly_typed_lambda_expression', apply: implicitlyTypedLambdas },
];

/** Applies one preference when its option is `true` and enforced. */
export function applyExpressionPreference(
  rule: PreferenceRule,
  source: string,
  props: EditorConfigProperties,
  report: EditorConfigIssueReporter
): string {
  if (effectiveEditorConfigValue(props, rule.option) !== 'true') {
    return source;
  }

  const tree = parseCSharp(source);

  try {
    return applyEdits(source, rule.apply(source, tree.rootNode, props, report));
  } finally {
    tree.delete();
  }
}

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

/** The declared type of a variable, field or property whose initializer is `initializer`. */
function targetTypeOf(initializer: Node): Node | undefined {
  const parent = initializer.parent;
  if (parent?.type === 'parameter') {
    return parent.childForFieldName('type') ?? undefined;
  }

  if (parent?.type === 'equals_value_clause') {
    const declarator = parent.parent;
    if (declarator?.type === 'variable_declarator' && declarator.parent?.type === 'variable_declaration') {
      return declarator.parent.childForFieldName('type') ?? undefined;
    }

    if (declarator?.type === 'parameter') {
      return declarator.childForFieldName('type') ?? undefined;
    }

    return undefined;
  }

  if (parent?.type === 'property_declaration' && parent.childForFieldName('value') === initializer) {
    return parent.childForFieldName('type') ?? undefined;
  }

  return undefined;
}

function isExplicitType(type: Node | undefined): type is Node {
  return type !== undefined && type.type !== 'implicit_type' && type.text !== 'dynamic';
}

/** An expression evaluated without side effects worth keeping twice: `x`, `this.x`, `a.b.c`. */
export function isSimpleReceiver(node: Node): boolean {
  if (node.type === 'identifier' || node.type === 'this_expression') {
    return true;
  }

  if (node.type === 'member_access_expression') {
    const receiver = node.childForFieldName('expression');
    const name = node.childForFieldName('name');

    return receiver !== null && name?.type === 'identifier' && isSimpleReceiver(receiver);
  }

  return false;
}

/** Wraps an operand in parentheses unless it is a primary expression. */
function operand(node: Node): string {
  const primary = [
    'identifier',
    'integer_literal',
    'member_access_expression',
    'invocation_expression',
    'element_access_expression',
    'parenthesized_expression',
    'this_expression',
  ];

  return primary.includes(node.type) ? node.text : `(${node.text})`;
}

/** The single argument expressions of an argument list, or `undefined` when one has a name or modifier. */
function plainArguments(list: Node | null): Node[] | undefined {
  if (!list) {
    return undefined;
  }

  const expressions: Node[] = [];
  for (const argument of list.namedChildren.filter((child) => child.type === 'argument')) {
    if (argument.namedChildCount !== 1 || argument.children.length !== 1) {
      return undefined;
    }

    expressions.push(argument.namedChildren[0]);
  }

  return expressions;
}

/**
 * The declared type of `identifier` when the enclosing member (or, failing that, the enclosing type)
 * declares that name exactly once, with an explicit type or as `var x = (T)value`, whose type is
 * exactly `T`. Any other kind of declaration (pattern, lambda parameter, query variable, other `var`)
 * makes the type unknown.
 */
export function declaredTypeText(identifier: Node, name = identifier.text): string | undefined {
  return declaredTypeNode(identifier, name)?.text.replace(/\s+/g, '');
}

/**
 * The type node behind {@link declaredTypeText}. `name` defaults to the identifier's text; `from`
 * can be any node the name is used in (the parser does not parse interpolation holes).
 */
export function declaredTypeNode(from: Node, name = from.text): Node | undefined {
  let member: Node | undefined;
  let type: Node | undefined;

  for (let current = from.parent; current; current = current.parent) {
    if (/_declaration$/.test(current.type) && current.type !== 'variable_declaration' && current.type !== 'local_declaration_statement') {
      member = current;
      break;
    }
  }

  const collect = (scope: Node, includeNested: boolean): { typed: Node[]; untyped: number } => {
    const typed: Node[] = [];
    let untyped = 0;
    const nodes = includeNested
      ? scope.descendantsOfType(['variable_declarator', 'parameter', 'declaration_expression', 'lambda_expression', 'pattern', 'from_clause', 'let_clause', 'join_clause', 'local_function_statement'])
      : [];

    for (const node of nodes) {
      if (node.type === 'variable_declarator' || node.type === 'parameter' || node.type === 'declaration_expression') {
        if (node.childForFieldName('name')?.text !== name) {
          continue;
        }

        const declared =
          node.type === 'variable_declarator' ? node.parent?.childForFieldName('type') : node.childForFieldName('type');
        const castType = declared?.type === 'implicit_type' && node.type === 'variable_declarator' ? initializerCastType(node) : undefined;
        if (declared && declared.type !== 'implicit_type') {
          typed.push(declared);
        } else if (castType) {
          typed.push(castType);
        } else {
          untyped++;
        }
      } else if (node.type === 'lambda_expression') {
        if (node.childForFieldName('parameters')?.text === name) {
          untyped++;
        }
      } else if (node.namedChildren.some((child) => child.type === 'identifier' && child.text === name)) {
        untyped++;
      }
    }

    return { typed, untyped };
  };

  if (member) {
    const local = collect(member, true);
    if (local.untyped > 0 || local.typed.length > 1) {
      return undefined;
    }

    type = local.typed[0];
    if (!type) {
      const owner = member.parent?.type === 'declaration_list' ? member.parent : undefined;
      const fields: Node[] = [];
      for (const sibling of owner?.namedChildren ?? []) {
        if (sibling.type === 'field_declaration') {
          const declaration = sibling.namedChildren.find((child) => child.type === 'variable_declaration');
          if (declaration?.namedChildren.some((d) => d.type === 'variable_declarator' && d.childForFieldName('name')?.text === name)) {
            fields.push(declaration.childForFieldName('type')!);
          }
        } else if (sibling.type === 'property_declaration' && sibling.childForFieldName('name')?.text === name) {
          fields.push(sibling.childForFieldName('type')!);
        } else if (sibling.childForFieldName('name')?.text === name) {
          return undefined;
        }
      }

      type = fields.length === 1 ? fields[0] : undefined;
    }
  }

  return type;
}

/** `T` of `var x = (T)value`: the variable then has exactly that type. */
function initializerCastType(declarator: Node): Node | undefined {
  let value = declarator.namedChildren.find((child) => child.type === 'equals_value_clause')?.namedChildren[0];
  while (value?.type === 'parenthesized_expression') {
    value = value.namedChildren[0];
  }

  return value?.type === 'cast_expression' ? (value.childForFieldName('type') ?? undefined) : undefined;
}

/** The declared type of `x` or `this.x`, when the file declares it exactly once with a type. */
export function subjectTypeText(subject: Node): string | undefined {
  if (subject.type === 'identifier') {
    return declaredTypeText(subject);
  }

  const name = subject.childForFieldName('name');
  if (subject.type !== 'member_access_expression' || subject.childForFieldName('expression')?.type !== 'this_expression' || name?.type !== 'identifier') {
    return undefined;
  }

  let owner: Node | null = subject.parent;
  while (owner && owner.type !== 'declaration_list') {
    owner = owner.parent;
  }

  const types: string[] = [];
  for (const member of owner?.namedChildren ?? []) {
    if (member.type === 'field_declaration') {
      const declaration = member.namedChildren.find((child) => child.type === 'variable_declaration');
      if (declaration?.namedChildren.some((d) => d.type === 'variable_declarator' && d.childForFieldName('name')?.text === name.text)) {
        types.push(declaration.childForFieldName('type')?.text ?? '');
      }
    } else if (member.childForFieldName('name')?.text === name.text) {
      types.push(member.type === 'property_declaration' ? member.childForFieldName('type')?.text ?? '' : '');
    }
  }

  return types.length === 1 && types[0] ? types[0].replace(/\s+/g, '') : undefined;
}

// ---------------------------------------------------------------------------------------------
// IDE0090 csharp_style_implicit_object_creation_when_type_is_apparent
// ---------------------------------------------------------------------------------------------

function implicitObjectCreation(_source: string, root: Node): TextEdit[] {
  const edits: TextEdit[] = [];

  for (const creation of findAll(root, 'object_creation_expression')) {
    const createdType = creation.childForFieldName('type');
    const declaredType = targetTypeOf(creation);
    if (!createdType || !isExplicitType(declaredType) || declaredType.text !== createdType.text || hasParseErrors(creation)) {
      continue;
    }

    // `new()` for `int?` creates an `int` (0), where `new int?()` is null; a type parameter needs
    // its `new()` constraint spelled out (https://learn.microsoft.com/dotnet/csharp/language-reference/operators/new-operator#constructor-invocation).
    const typeName = createdType.text.replace(/\s+/g, '');
    if (typeName.endsWith('?') || /^(?:System\.)?Nullable</.test(typeName) || typeParameterNames(creation).includes(typeName)) {
      continue;
    }

    const args = creation.childForFieldName('arguments');
    edits.push({
      start: creation.startIndex,
      end: (args ?? createdType).endIndex,
      text: `new${args ? args.text : '()'}`,
    });
  }

  return edits;
}

/** Type parameters in scope at `node` (of the enclosing types and methods). */
function typeParameterNames(node: Node): string[] {
  const names: string[] = [];
  for (let current = node.parent; current; current = current.parent) {
    const list = current.namedChildren.find((child) => child.type === 'type_parameter_list');
    list?.namedChildren.forEach((parameter) => names.push(parameter.text.replace(/^(?:in|out)\s+/, '')));
  }

  return names;
}

// ---------------------------------------------------------------------------------------------
// IDE0034 csharp_prefer_simple_default_expression
// ---------------------------------------------------------------------------------------------

const FUNCTION_LIKE: Record<string, true> = {
  method_declaration: true,
  local_function_statement: true,
  operator_declaration: true,
  conversion_operator_declaration: true,
  lambda_expression: true,
  anonymous_method_expression: true,
  accessor_declaration: true,
  property_declaration: true,
  indexer_declaration: true,
  constructor_declaration: true,
};

function simpleDefaultExpression(_source: string, root: Node): TextEdit[] {
  const edits: TextEdit[] = [];

  for (const expression of findAll(root, 'default_expression')) {
    const type = expression.namedChildren[0];
    if (!type) {
      continue;
    }

    const target = targetTypeOf(expression) ?? returnTypeOf(expression);
    if (isExplicitType(target) && target.text === type.text) {
      edits.push({ start: expression.startIndex, end: expression.endIndex, text: 'default' });
    }
  }

  return edits;
}

/** The return type of the method or local function `expression` is directly returned from. */
function returnTypeOf(expression: Node): Node | undefined {
  const parent = expression.parent;
  if (parent?.type !== 'return_statement' && parent?.type !== 'arrow_expression_clause') {
    return undefined;
  }

  for (let current = parent.parent; current; current = current.parent) {
    if (FUNCTION_LIKE[current.type] === true) {
      const isMethod = current.type === 'method_declaration' || current.type === 'local_function_statement';
      const async = current.namedChildren.some((child) => child.type === 'modifier' && child.text === 'async');

      return isMethod && !async ? (current.childForFieldName('type') ?? undefined) : undefined;
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------------------------
// IDE0056 csharp_style_prefer_index_operator
// ---------------------------------------------------------------------------------------------

/**
 * Declared types that are countable with an `int` indexer, so `x[^n]` means `x[x.Length - n]`
 * (https://learn.microsoft.com/dotnet/csharp/tutorials/ranges-indexes#type-support-for-indices-and-ranges).
 */
const INDEX_TYPE = /^(?:string|String|System\.String|[\w.<>,?]+\[\]|(?:System\.Collections\.Generic\.)?(?:List|IList|IReadOnlyList)<.+>|(?:System\.)?(?:ReadOnly)?Span<.+>)$/;

function indexOperator(source: string, root: Node, _props: EditorConfigProperties, report: EditorConfigIssueReporter): TextEdit[] {
  const edits: TextEdit[] = [];

  for (const access of findAll(root, 'element_access_expression')) {
    const receiver = access.childForFieldName('expression');
    const args = plainArguments(access.childForFieldName('subscript'));
    const index = args?.length === 1 ? args[0] : undefined;
    if (!receiver || !index || index.type !== 'binary_expression' || index.child(1)?.type !== '-') {
      continue;
    }

    const length = index.childForFieldName('left');
    const offset = index.childForFieldName('right');
    const lengthName = length?.type === 'member_access_expression' ? length.childForFieldName('name')?.text : undefined;
    if (
      !offset ||
      (lengthName !== 'Length' && lengthName !== 'Count') ||
      !isSimpleReceiver(receiver) ||
      length?.childForFieldName('expression')?.text !== receiver.text ||
      isInPossibleExpressionTree(access)
    ) {
      continue;
    }

    if (receiver.type !== 'identifier' || !INDEX_TYPE.test(declaredTypeText(receiver) ?? '')) {
      report(
        describeIssue(
          'IDE0056',
          'csharp_style_prefer_index_operator',
          source,
          access.startIndex,
          `'${access.text}' was not changed to an index from the end: '${receiver.text}' is not declared as an array, string or list in this member or type.`
        )
      );
      continue;
    }

    edits.push({ start: index.startIndex, end: index.endIndex, text: `^${operand(offset)}` });
  }

  return edits;
}

// ---------------------------------------------------------------------------------------------
// IDE0057 csharp_style_prefer_range_operator
// ---------------------------------------------------------------------------------------------

/** Declared types whose `Substring`/`Slice` has the same meaning as a range. */
const RANGE_TYPES: Record<string, 'Substring' | 'Slice'> = { string: 'Substring', String: 'Substring', 'System.String': 'Substring' };
const SLICE_TYPE = /^(?:System\.)?(?:ReadOnly)?(?:Span|Memory)<.+>$/;

function rangeOperator(source: string, root: Node, _props: EditorConfigProperties, report: EditorConfigIssueReporter): TextEdit[] {
  const edits: TextEdit[] = [];

  for (const invocation of findAll(root, 'invocation_expression')) {
    const callee = invocation.childForFieldName('function');
    const method = callee?.type === 'member_access_expression' ? callee.childForFieldName('name')?.text : undefined;
    const receiver = callee?.childForFieldName('expression');
    if ((method !== 'Substring' && method !== 'Slice') || !receiver || receiver.type !== 'identifier') {
      continue;
    }

    const args = plainArguments(invocation.childForFieldName('arguments'));
    if (!args || args.length < 1 || args.length > 2 || isInPossibleExpressionTree(invocation)) {
      continue;
    }

    const typeText = declaredTypeText(receiver);
    const provable = typeText !== undefined && (RANGE_TYPES[typeText] === method || (method === 'Slice' && SLICE_TYPE.test(typeText)));
    if (!provable) {
      if (method === 'Substring') {
        report(
          describeIssue(
            'IDE0057',
            'csharp_style_prefer_range_operator',
            source,
            invocation.startIndex,
            `'${invocation.text}' was not changed to a range: '${receiver.text}' is not declared as a string in this member or type.`
          )
        );
      }

      continue;
    }

    const range = rangeFor(receiver.text, args);
    if (range) {
      edits.push({ start: invocation.startIndex, end: invocation.endIndex, text: `${receiver.text}[${range}]` });
    }
  }

  return edits;
}

/** The range equivalent to `Substring(start[, length])`, when it is simple. */
function rangeFor(receiver: string, [start, length]: Node[]): string | undefined {
  const from = start.type === 'integer_literal' && start.text === '0' ? '' : operand(start);
  if (!length) {
    return `${from}..`;
  }

  if (length.type === 'binary_expression' && length.child(1)?.type === '-') {
    const left = length.childForFieldName('left');
    const right = length.childForFieldName('right');
    if (!left || !right) {
      return undefined;
    }

    // Substring(a, b - a) == [a..b]
    if (right.text === start.text) {
      return left.text === `${receiver}.Length` ? `${from}..` : `${from}..${operand(left)}`;
    }

    // Substring(a, s.Length - c) == [a..^(c - a)] for literals c >= a
    if (left.text === `${receiver}.Length` && start.type === 'integer_literal' && right.type === 'integer_literal') {
      const fromEnd = Number(right.text) - Number(start.text);

      return fromEnd === 0 ? `${from}..` : fromEnd > 0 ? `${from}..^${fromEnd}` : undefined;
    }

    return undefined;
  }

  return from === '' ? `..${operand(length)}` : undefined;
}

// ---------------------------------------------------------------------------------------------
// IDE0150 csharp_style_prefer_null_check_over_type_check
// ---------------------------------------------------------------------------------------------

const OBJECT_TYPES: Record<string, true> = { object: true, Object: true, 'System.Object': true };

function nullCheckOverTypeCheck(_source: string, root: Node): TextEdit[] {
  const edits: TextEdit[] = [];

  for (const check of findAll(root, 'is_pattern_expression')) {
    const pattern = check.childForFieldName('pattern');
    const parts = pattern?.namedChildren ?? [];
    const subject = check.childForFieldName('expression');
    // `is null` does not compile for a non-nullable value type (CS0037); `is object` does.
    if (!pattern || !subject || isInPossibleExpressionTree(check) || isNonNullableValueType(subjectTypeText(subject), root)) {
      continue;
    }

    if (parts.length === 1 && OBJECT_TYPES[parts[0].text] === true) {
      edits.push({ start: pattern.startIndex, end: pattern.endIndex, text: 'not null' });
    } else if (parts.length === 2 && parts[0].text === 'not' && OBJECT_TYPES[parts[1].text] === true) {
      edits.push({ start: pattern.startIndex, end: pattern.endIndex, text: 'null' });
    }
  }

  return edits;
}

// ---------------------------------------------------------------------------------------------
// IDE0340 csharp_style_prefer_unbound_generic_type_in_nameof
// ---------------------------------------------------------------------------------------------

const NAME_PARTS: Record<string, true> = {
  identifier: true,
  generic_name: true,
  member_access_expression: true,
  qualified_name: true,
  alias_qualified_name: true,
};

function unboundGenericTypeInNameof(_source: string, root: Node): TextEdit[] {
  const edits: TextEdit[] = [];

  for (const invocation of findAll(root, 'invocation_expression')) {
    const args = plainArguments(invocation.childForFieldName('arguments'));
    if (invocation.childForFieldName('function')?.text !== 'nameof' || args?.length !== 1) {
      continue;
    }

    const name = args[0];
    if (!isNameChain(name)) {
      continue;
    }

    for (const generic of [name, ...name.descendantsOfType('generic_name')].filter((node) => node.type === 'generic_name')) {
      const list = generic.namedChildren.find((child) => child.type === 'type_argument_list');
      const count = list?.namedChildren.length ?? 0;
      if (list && count > 0 && isOutermostList(list, name)) {
        edits.push({ start: list.startIndex, end: list.endIndex, text: `<${','.repeat(count - 1)}>` });
      }
    }
  }

  return edits;
}

function isNameChain(node: Node): boolean {
  if (node.type === 'generic_name') {
    return true;
  }

  return NAME_PARTS[node.type] === true && node.namedChildren.every((child) => child.type === 'type_argument_list' || isNameChain(child));
}

/** Type argument lists nested inside another list are removed with it. */
function isOutermostList(list: Node, name: Node): boolean {
  for (let current = list.parent; current && current !== name.parent; current = current.parent) {
    if (current !== list && current.type === 'type_argument_list') {
      return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------------------------
// IDE0230 csharp_style_prefer_utf8_string_literals
// ---------------------------------------------------------------------------------------------

const ESCAPES: Record<number, string> = { 9: '\\t', 10: '\\n', 13: '\\r', 34: '\\"', 92: '\\\\' };

function utf8StringLiterals(_source: string, root: Node): TextEdit[] {
  const edits: TextEdit[] = [];

  for (const creation of findAll(root, 'array_creation_expression')) {
    const arrayType = creation.namedChildren.find((child) => child.type === 'array_type');
    const initializer = creation.namedChildren.find((child) => child.type === 'initializer_expression');
    if (arrayType?.text.replace(/\s+/g, '') !== 'byte[]' || !initializer || initializer.namedChildCount === 0) {
      continue;
    }

    let text = '';
    for (const element of initializer.namedChildren) {
      const value = element.type === 'integer_literal' ? Number(element.text.replace(/_/g, '')) : Number.NaN;
      const printable = value >= 0x20 && value <= 0x7e;
      if (!printable && ESCAPES[value] === undefined) {
        text = '';
        break;
      }

      text += ESCAPES[value] ?? String.fromCharCode(value);
    }

    const insideAttribute = creation.parent !== null && hasAncestor(creation, 'attribute_list');
    if (!text || insideAttribute || isInPossibleExpressionTree(creation)) {
      continue;
    }

    const target = targetTypeOf(creation)?.text.replace(/\s+/g, '');
    const span = target === 'ReadOnlySpan<byte>' || target === 'System.ReadOnlySpan<byte>';
    edits.push({ start: creation.startIndex, end: creation.endIndex, text: `"${text}"u8${span ? '' : '.ToArray()'}` });
  }

  return edits;
}

export function hasAncestor(node: Node, type: string): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === type) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------------------------
// IDE0350 csharp_style_prefer_implicitly_typed_lambda_expression
// ---------------------------------------------------------------------------------------------

function implicitlyTypedLambdas(source: string, root: Node, _props: EditorConfigProperties, report: EditorConfigIssueReporter): TextEdit[] {
  const edits: TextEdit[] = [];

  for (const lambda of findAll(root, 'lambda_expression')) {
    const list = lambda.childForFieldName('parameters');
    const parameters = list?.type === 'parameter_list' ? list.namedChildren.filter((child) => child.type === 'parameter') : [];
    if (!list || parameters.length === 0 || parameters.some((parameter) => !parameter.childForFieldName('type'))) {
      continue;
    }

    const plain = parameters.every(
      (parameter) => parameter.namedChildren.length === 2 && parameter.children.length === 2
    );
    const delegateTypes = delegateParameterTypes(targetTypeOf(lambda));
    const matches =
      delegateTypes !== undefined &&
      delegateTypes.length === parameters.length &&
      parameters.every((parameter, index) => parameter.childForFieldName('type')?.text === delegateTypes[index]);

    if (!plain) {
      continue;
    }

    if (!matches) {
      report(
        describeIssue(
          'IDE0350',
          'csharp_style_prefer_implicitly_typed_lambda_expression',
          source,
          lambda.startIndex,
          'lambda parameter types were not removed: without them a different overload or delegate type could be chosen.'
        )
      );
      continue;
    }

    const names = parameters.map((parameter) => parameter.childForFieldName('name')!.text);
    edits.push({ start: list.startIndex, end: list.endIndex, text: names.length === 1 ? names[0] : `(${names.join(', ')})` });
  }

  return edits;
}

/** The parameter types of a `Func<...>`/`Action<...>` declared type. */
export function delegateParameterTypes(type: Node | undefined): string[] | undefined {
  if (!type) {
    return undefined;
  }

  if (type.type === 'identifier' && (type.text === 'Action' || type.text === 'System.Action')) {
    return [];
  }

  const name = type.type === 'generic_name' ? type.namedChildren[0]?.text : undefined;
  const list = type.namedChildren.find((child) => child.type === 'type_argument_list');
  const args = list?.namedChildren.map((child) => child.text) ?? [];
  if (name === 'Func' && args.length > 0) {
    return args.slice(0, -1);
  }

  return name === 'Action' ? args : undefined;
}
