import { EditorConfigProperties } from '../editorconfig';
import { Node, TextEdit, applyEdits, findAll, parseCSharp } from '../parser';
import { Token, lex } from '../syntax/lexer';
import {
  CodeStyleOption,
  EditorConfigIssueReporter,
  describeIssue,
  hasModifier,
  hasParseErrors,
  readCodeStyleOption,
} from './editorConfigSupport';

type MemberKind = 'field' | 'property' | 'method' | 'event';

const OPTION_BY_KIND: Record<MemberKind, string> = {
  field: 'dotnet_style_qualification_for_field',
  property: 'dotnet_style_qualification_for_property',
  method: 'dotnet_style_qualification_for_method',
  event: 'dotnet_style_qualification_for_event',
};

/** Types whose members can be qualified with `this.`. */
const INSTANCE_TYPES: Record<string, true> = {
  class_declaration: true,
  struct_declaration: true,
  record_declaration: true,
};

const TYPE_DECLARATIONS: Record<string, true> = {
  class_declaration: true,
  struct_declaration: true,
  record_declaration: true,
  interface_declaration: true,
  enum_declaration: true,
};

/** Declarations whose body runs with a `this` (unless `static`). */
const MEMBER_DECLARATIONS: Record<string, true> = {
  method_declaration: true,
  constructor_declaration: true,
  destructor_declaration: true,
  property_declaration: true,
  indexer_declaration: true,
  event_declaration: true,
  operator_declaration: true,
  conversion_operator_declaration: true,
  field_declaration: true,
  event_field_declaration: true,
};

/** Parts of a member that are its executable body - not parameters, attributes or initializers. */
const MEMBER_BODIES: Record<string, true> = {
  block: true,
  arrow_expression_clause: true,
  accessor_list: true,
};

/** Words after which an identifier is an expression, never the name of a new declaration. */
const EXPRESSION_KEYWORDS: Record<string, true> = {
  return: true, new: true, is: true, as: true, case: true, in: true, out: true, ref: true, await: true,
  throw: true, else: true, when: true, and: true, or: true, not: true, typeof: true, sizeof: true,
  nameof: true, goto: true, yield: true, using: true, lock: true, params: true, this: true, base: true,
  where: true, select: true, on: true, equals: true, orderby: true, ascending: true, descending: true,
  by: true, group: true, checked: true, unchecked: true, default: true, delegate: true, fixed: true,
  while: true, if: true, do: true, switch: true, for: true, foreach: true, catch: true, try: true,
  with: true, async: true, operator: true, unsafe: true, get: true, set: true, init: true, add: true,
  remove: true, global: true, static: true, const: true, readonly: true, scoped: true,
};

/** Words that introduce a query range variable (`from x in`, `let x =`, `into x`). */
const RANGE_VARIABLE_KEYWORDS: Record<string, true> = { from: true, let: true, join: true, into: true, var: true };

/** Tokens that can follow the designation of a property pattern (`is { } x)`, `{ } x &&`, ...). */
const PATTERN_DESIGNATION_FOLLOWERS: Record<string, true> = {
  ')': true,
  '&&': true,
  '||': true,
  '=>': true,
  ',': true,
  ':': true,
  ']': true,
  when: true,
  and: true,
  or: true,
};

interface MemberInfo {
  readonly kind: MemberKind;
  readonly isStatic: boolean;
  /** Declared type, used to recognize the `Color Color` case. */
  readonly typeText?: string;
}

interface QualificationOptions {
  readonly byKind: Partial<Record<MemberKind, CodeStyleOption>>;
}

/**
 * Applies `dotnet_style_qualification_for_field/property/method/event` (IDE0003 remove `this.`,
 * IDE0009 add `this.`). Both directions only touch members declared in the same type in this file:
 * without a semantic model, an inherited member, an extension method or a member of another
 * partial part cannot be told apart. References whose name is also declared as a local,
 * parameter, range variable or type parameter anywhere in the member are left alone, as are
 * members the parser could not fully read.
 */
export function applyQualificationPreferences(
  source: string,
  props: EditorConfigProperties,
  report: EditorConfigIssueReporter
): string {
  const options: QualificationOptions = { byKind: {} };
  for (const kind of Object.keys(OPTION_BY_KIND) as MemberKind[]) {
    const option = readCodeStyleOption(props, OPTION_BY_KIND[kind], (value) => (value === 'true' ? 'IDE0009' : 'IDE0003'));
    if (option?.enforced && (option.value === 'true' || option.value === 'false')) {
      options.byKind[kind] = option;
    }
  }

  if (Object.keys(options.byKind).length === 0) {
    return source;
  }

  const tree = parseCSharp(source);

  try {
    const analysis = new QualificationAnalysis(source);
    const edits: TextEdit[] = [];

    for (const type of findAll(tree.rootNode, Object.keys(INSTANCE_TYPES))) {
      const members = declaredMembers(type);
      if (members.size === 0) {
        continue;
      }

      collectRemovals(source, type, members, options, analysis, report, edits);
      collectAdditions(type, members, options, analysis, edits);
    }

    return applyEdits(source, edits);
  } finally {
    tree.delete();
  }
}

function collectRemovals(
  source: string,
  type: Node,
  members: ReadonlyMap<string, MemberInfo>,
  options: QualificationOptions,
  analysis: QualificationAnalysis,
  report: EditorConfigIssueReporter,
  edits: TextEdit[]
): void {
  for (const access of type.descendantsOfType('member_access_expression')) {
    const receiver = access.childForFieldName('expression');
    const nameNode = access.childForFieldName('name');
    if (receiver?.type !== 'this_expression' || !nameNode || nearestType(access) !== type) {
      continue;
    }

    const name = nameNode.type === 'generic_name' ? (nameNode.namedChild(0)?.text ?? nameNode.text) : nameNode.text;
    const member = members.get(name);
    if (!member) {
      const removalOptions = Object.values(options.byKind).filter((option) => option.value === 'false');
      if (removalOptions.length > 0) {
        report(
          describeIssue(
            'IDE0003',
            'dotnet_style_qualification_*',
            source,
            access.startIndex,
            `'this.${name}' was not simplified: '${name}' is not declared in this type in this file (inherited, extension or partial member).`
          )
        );
      }

      continue;
    }

    if (options.byKind[member.kind]?.value !== 'false') {
      continue;
    }

    const context = analysis.memberContext(access, type);
    if (!context || context.shadowed.has(name)) {
      continue;
    }

    // `(this.X)(5)` would become `(X)(5)`, a cast: C# reads `(Name)` (also `(A.B)`) as one before
    // `(`, `!`, `~`, a name, a literal or a keyword other than `is` and `as`.
    let chain = access;
    while (chain.parent?.type === 'member_access_expression' && chain.parent.childForFieldName('expression') === chain) {
      chain = chain.parent;
    }

    if (chain.parent?.type === 'parenthesized_expression' && /^\s*(?:[(!~"'@$]|(?!(?:is|as)\b)\w)/.test(source.slice(chain.parent.endIndex))) {
      continue;
    }

    edits.push({ start: receiver.startIndex, end: nameNode.startIndex, text: '' });
  }
}

function collectAdditions(
  type: Node,
  members: ReadonlyMap<string, MemberInfo>,
  options: QualificationOptions,
  analysis: QualificationAnalysis,
  edits: TextEdit[]
): void {
  for (const identifier of type.descendantsOfType('identifier')) {
    const member = members.get(identifier.text);
    if (!member || member.isStatic || options.byKind[member.kind]?.value !== 'true') {
      continue;
    }

    if (nearestType(identifier) !== type || !isUnqualifiedReference(identifier, member)) {
      continue;
    }

    const context = analysis.memberContext(identifier, type);
    if (!context || context.isStatic || context.shadowed.has(identifier.text)) {
      continue;
    }

    edits.push({ start: identifier.startIndex, end: identifier.startIndex, text: 'this.' });
  }
}

/**
 * True when `identifier` is a simple name in an expression position where it can only mean a
 * member of the enclosing type: not a member-access name, a declaration, a named argument, an
 * object-initializer target, a type or a pattern.
 */
function isUnqualifiedReference(identifier: Node, member: MemberInfo): boolean {
  const parent = identifier.parent;
  if (!parent) {
    return false;
  }

  const field = fieldNameOf(parent, identifier);

  switch (parent.type) {
    case 'assignment_expression':
      return !(field === 'left' && parent.parent?.type === 'initializer_expression');

    case 'binary_expression': {
      const operator = parent.child(1)?.type;

      return !(field === 'right' && (operator === 'is' || operator === 'as'));
    }

    case 'argument': {
      const invocation = parent.parent?.parent;
      const isNameOf =
        invocation?.type === 'invocation_expression' && invocation.childForFieldName('function')?.text === 'nameof';

      return field !== 'name' && !isNameOf;
    }

    case 'invocation_expression':
      return field === 'function';

    case 'member_access_expression':
      // `Color.Red` where the member `Color` has type `Color` may mean the type; leave it alone.
      return field === 'expression' && member.typeText?.split('.').pop() !== identifier.text;

    case 'conditional_access_expression':
    case 'element_access_expression':
      return field === 'expression';

    case 'cast_expression':
      return field === 'value';

    case 'lambda_expression':
      return field === 'body';

    case 'is_pattern_expression':
      return field === 'expression';

    case 'initializer_expression':
      return parent.parent?.type !== 'anonymous_object_creation_expression';

    case 'tuple_expression':
      // `(X: 1, Y: 2)` names the tuple elements.
      return parent.children[parent.children.indexOf(identifier) + 1]?.type !== ':';

    case 'prefix_unary_expression':
    case 'postfix_unary_expression':
    case 'conditional_expression':
    case 'parenthesized_expression':
    case 'return_statement':
    case 'arrow_expression_clause':
    case 'if_statement':
    case 'while_statement':
    case 'do_statement':
    case 'switch_statement':
    case 'lock_statement':
    case 'throw_statement':
    case 'throw_expression':
    case 'await_expression':
    case 'for_each_statement':
      return true;

    case 'equals_value_clause':
      return parent.parent?.type === 'variable_declarator';

    default:
      return false;
  }
}

function fieldNameOf(parent: Node, child: Node): string | undefined {
  for (const [name, node] of parent.fields ?? []) {
    if (node === child) {
      return name;
    }
  }

  return undefined;
}

function nearestType(node: Node): Node | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (TYPE_DECLARATIONS[current.type] === true) {
      return current;
    }
  }

  return undefined;
}

/** Members declared directly in `type`, by name. Names declared more than once ambiguously are dropped. */
function declaredMembers(type: Node): Map<string, MemberInfo> {
  const members = new Map<string, MemberInfo>();
  const ambiguous = new Set<string>();
  const body = type.childForFieldName('body');

  const add = (name: string | undefined, info: MemberInfo): void => {
    if (!name) {
      return;
    }

    const existing = members.get(name);
    if (existing && (existing.kind !== info.kind || existing.isStatic !== info.isStatic || info.kind !== 'method')) {
      ambiguous.add(name);
    }

    members.set(name, info);
  };

  for (const member of body?.namedChildren ?? []) {
    const isStatic = hasModifier(member, 'static') || hasModifier(member, 'const');

    switch (member.type) {
      case 'field_declaration':
      case 'event_field_declaration': {
        const declaration = member.namedChildren.find((child) => child.type === 'variable_declaration');
        const typeText = declaration?.childForFieldName('type')?.text;
        for (const declarator of declaration?.namedChildren ?? []) {
          if (declarator.type === 'variable_declarator') {
            add(declarator.childForFieldName('name')?.text, {
              kind: member.type === 'field_declaration' ? 'field' : 'event',
              isStatic,
              typeText,
            });
          }
        }

        break;
      }

      case 'property_declaration':
        add(member.childForFieldName('name')?.text, {
          kind: 'property',
          isStatic,
          typeText: member.childForFieldName('type')?.text,
        });
        break;

      case 'event_declaration':
        add(member.childForFieldName('name')?.text ?? member.namedChildren.find((c) => c.type === 'identifier')?.text, {
          kind: 'event',
          isStatic,
        });
        break;

      case 'method_declaration':
        if (!member.namedChildren.some((child) => child.type === 'explicit_interface_specifier')) {
          add(member.childForFieldName('name')?.text, { kind: 'method', isStatic });
        }

        break;

      default:
        if (TYPE_DECLARATIONS[member.type] === true || member.type === 'delegate_declaration') {
          const name = member.childForFieldName('name')?.text;
          if (name) {
            ambiguous.add(name);
          }
        }

        break;
    }
  }

  for (const name of ambiguous) {
    members.delete(name);
  }

  return members;
}

interface MemberContext {
  readonly isStatic: boolean;
  /** Names declared anywhere in the member (or its type's primary constructor) that could shadow a member. */
  readonly shadowed: ReadonlySet<string>;
}

/** Caches, per member declaration, whether it runs with a `this` and which names it declares. */
class QualificationAnalysis {
  private readonly tokens: Token[];
  private readonly contexts = new Map<number, MemberContext | undefined>();

  constructor(private readonly source: string) {
    this.tokens = lex(source).tokens;
  }

  /**
   * The context of the member whose body contains `node`, or `undefined` when `node` is not in an
   * executable member body of `type` (e.g. a field initializer or a constructor initializer) or the
   * member could not be parsed completely.
   */
  memberContext(node: Node, type: Node): MemberContext | undefined {
    let bodyPart: Node | undefined;
    let member: Node | undefined;
    let isStatic = false;

    for (let current: Node | null = node; current?.parent; current = current.parent) {
      const parent: Node = current.parent;
      if (parent.type === 'local_function_statement' && hasModifier(parent, 'static')) {
        isStatic = true;
      }

      if ((parent.type === 'lambda_expression' || parent.type === 'anonymous_method_expression') && this.isStaticLambda(parent)) {
        isStatic = true;
      }

      if (MEMBER_DECLARATIONS[parent.type] === true) {
        bodyPart = current;
        member = parent;
        break;
      }
    }

    if (!member || !bodyPart || MEMBER_BODIES[bodyPart.type] !== true || member.parent?.parent !== type) {
      return undefined;
    }

    if (!this.contexts.has(member.id)) {
      this.contexts.set(member.id, hasParseErrors(member) ? undefined : this.analyze(member, type));
    }

    const context = this.contexts.get(member.id);

    return context && isStatic ? { ...context, isStatic: true } : context;
  }

  private analyze(member: Node, type: Node): MemberContext {
    const shadowed = new Set<string>();

    for (const node of member.descendantsOfType([
      'parameter',
      'variable_declarator',
      'declaration_expression',
      'local_function_statement',
      'lambda_expression',
      'pattern',
      'switch_body',
      'type_parameter_list',
      'from_clause',
      'let_clause',
      'join_clause',
      'join_into_clause',
      'invocation_expression',
      'accessor_declaration',
    ])) {
      collectDeclaredNames(node, shadowed);
    }

    for (let current: Node | null = type; current; current = current.parent) {
      const typeParameters = current.namedChildren.find((child) => child.type === 'type_parameter_list');
      if (typeParameters) {
        collectDeclaredNames(typeParameters, shadowed);
      }

      const primaryConstructor = TYPE_DECLARATIONS[current.type] === true ? current.childForFieldName('parameters') : null;
      for (const parameter of primaryConstructor?.namedChildren ?? []) {
        collectDeclaredNames(parameter, shadowed);
      }
    }

    this.collectDeclarationLikeTokens(member, shadowed);

    const isStatic =
      hasModifier(member, 'static') ||
      member.type === 'operator_declaration' ||
      member.type === 'conversion_operator_declaration';

    return { isStatic, shadowed };
  }

  /**
   * Token fallback for declarations the parser does not model (tuple deconstruction, patterns
   * inside switch expressions, static lambdas): an identifier right after a type-like token
   * (`int x`, `List<int> x`, `} x`) or right before `=>` is treated as declared.
   */
  private collectDeclarationLikeTokens(member: Node, shadowed: Set<string>): void {
    const source = this.source;
    // The member's own name and parameters are in its header; the parser already reports parameters.
    const bodyStart = Math.min(
      ...member.namedChildren.filter((child) => MEMBER_BODIES[child.type] === true).map((child) => child.startIndex),
      member.endIndex
    );

    for (let i = 1; i < this.tokens.length; i++) {
      const token = this.tokens[i];
      if (token.start < bodyStart || token.end > member.endIndex || token.type !== 'identifier') {
        continue;
      }

      const name = source.slice(token.start, token.end);
      const previous = this.tokens[i - 1];
      const previousText = source.slice(previous.start, previous.end);
      const next = this.tokens[i + 1];

      const afterWord = /^[A-Za-z_@][\w]*$/.test(previousText) && EXPRESSION_KEYWORDS[previousText] !== true;
      const afterRangeKeyword = RANGE_VARIABLE_KEYWORDS[previousText] === true;
      const afterTypeSuffix =
        (previousText === '>' || previousText === '?' || previousText === '*') && !/\s/.test(source[previous.start - 1] ?? ' ');
      const nextText = next === undefined ? '' : source.slice(next.start, next.end);
      // `int[] x`; `is { } x` (a `}` before a statement, as in `} x = 1;`, is not a declaration).
      const afterBracket = previousText === ']' || (previousText === '}' && PATTERN_DESIGNATION_FOLLOWERS[nextText] === true);
      const beforeArrow = nextText === '=>';

      if (afterWord || afterRangeKeyword || afterTypeSuffix || afterBracket || beforeArrow) {
        shadowed.add(name);
      }
    }
  }

  /** `static x => ...` and `static delegate { }`; the parser leaves `static` in front of the lambda. */
  private isStaticLambda(lambda: Node): boolean {
    return /\bstatic\s*$/.test(this.source.slice(Math.max(0, lambda.startIndex - 16), lambda.startIndex));
  }
}

function collectDeclaredNames(node: Node, names: Set<string>): void {
  switch (node.type) {
    case 'parameter':
    case 'variable_declarator':
    case 'declaration_expression':
    case 'local_function_statement':
    case 'from_clause':
    case 'let_clause':
    case 'join_clause':
    case 'join_into_clause': {
      const name = node.childForFieldName('name');
      if (name) {
        names.add(name.text);
      }

      break;
    }

    case 'lambda_expression': {
      const parameters = node.childForFieldName('parameters');
      if (parameters?.type === 'identifier') {
        names.add(parameters.text);
      }

      break;
    }

    case 'pattern':
    case 'switch_body':
    case 'type_parameter_list':
      for (const child of node.namedChildren) {
        if (child.type === 'identifier') {
          names.add(child.text);
        }
      }

      break;

    case 'invocation_expression':
      // `var (a, b) = ...` is parsed as a call of `var`; every name inside is a new local.
      if (node.childForFieldName('function')?.text === 'var') {
        for (const identifier of node.descendantsOfType('identifier')) {
          names.add(identifier.text);
        }
      }

      break;

    case 'accessor_declaration':
      // `set`, `init`, `add` and `remove` declare the implicit `value` parameter.
      if (node.children.some((child) => ['set', 'init', 'add', 'remove'].includes(child.type))) {
        names.add('value');
      }

      break;
  }
}
