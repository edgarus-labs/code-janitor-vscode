import { Node } from '../cleanup/parser';

/**
 * Field and property initializers of a type run in declaration order - static ones in the static
 * constructor, instance ones in every constructor. Moving a member with an initializer can change
 * what another initializer sees, so the reorganizer derives from the syntax which members must
 * keep their relative order (see {@link mustKeepOrder}) and only reorders the rest.
 */

export interface InitInfo {
  /** Declares a static field, property or event with an initializer (constants do not count). */
  staticInit: boolean;
  instanceInit: boolean;
  /** A static initializer that runs code (calls, constructors, property reads) and may observe any other static initializer. */
  staticOpaque: boolean;
  /** An instance initializer that runs code. */
  instanceOpaque: boolean;
  /** An instance initializer that reads a field of this type (static state an instance initializer running code may change). */
  instanceReadsState: boolean;
  /** Names of the members declared with an initializer. */
  declares: ReadonlySet<string>;
  /** Names of members of the same type the initializers read. */
  refs: ReadonlySet<string>;
}

export const NO_INIT: InitInfo = {
  staticInit: false,
  instanceInit: false,
  staticOpaque: false,
  instanceOpaque: false,
  instanceReadsState: false,
  declares: new Set<string>(),
  refs: new Set<string>(),
};

/** What the members of the type are named, to tell a read of a field from a call of code. */
export type MemberNameClass = 'initialized' | 'plain' | 'constant' | 'method' | 'computed';

export interface InitContext {
  typeName: string;
  names: ReadonlyMap<string, MemberNameClass>;
  /** The declared types of the fields and properties. */
  types: ReadonlyMap<string, string>;
}

/** BCL types whose constructors have no side effect on state of the program being initialized. */
const PURE_CONSTRUCTED_TYPES = new Set([
  'object', 'List', 'Dictionary', 'HashSet', 'SortedDictionary', 'SortedSet', 'SortedList', 'Queue', 'Stack', 'LinkedList',
  'StringBuilder', 'ConcurrentDictionary', 'ConcurrentQueue', 'ConcurrentStack', 'ConcurrentBag', 'Lazy', 'ThreadLocal',
  'SemaphoreSlim', 'ManualResetEvent', 'ManualResetEventSlim', 'AutoResetEvent', 'ReaderWriterLockSlim', 'Mutex', 'Lock',
  'Regex', 'Version', 'TimeSpan', 'DateTime', 'DateTimeOffset', 'Uri', 'Guid', 'Random', 'Stopwatch', 'CultureInfo',
  'KeyValuePair', 'Tuple', 'ValueTuple', 'BitArray', 'string', 'StringComparer', 'ArrayList', 'Hashtable',
  'Exception', 'ArgumentException', 'InvalidOperationException', 'NotSupportedException', 'NotImplementedException',
  'Func', 'Action', 'EventHandler', 'Predicate', 'Comparison',
]);

/** Static classes whose methods only compute from their arguments. */
const PURE_STATIC_TYPES = new Set([
  'Math', 'MathF', 'Array', 'Enum', 'TimeSpan', 'DateTime', 'DateTimeOffset', 'Guid', 'Path', 'Regex', 'String', 'Convert',
  'BitConverter', 'Encoding', 'Enumerable', 'ImmutableArray', 'ImmutableList', 'ImmutableDictionary', 'ImmutableHashSet',
  'Environment', 'Type', 'Uri', 'Version', 'Char', 'Int32', 'Int64', 'Double', 'Decimal', 'Boolean', 'Byte', 'UInt32', 'UInt64',
  'Comparer', 'EqualityComparer', 'StringComparer', 'CultureInfo', 'NumberFormatInfo', 'ArrayPool', 'Buffer', 'BigInteger',
]);

/** BCL enums: reading their values runs no code. */
const LIBRARY_ENUMS = new Set([
  'RegexOptions', 'StringComparison', 'StringSplitOptions', 'BindingFlags', 'DateTimeKind', 'DateTimeStyles', 'NumberStyles',
  'CompareOptions', 'MidpointRounding', 'DayOfWeek', 'UriKind', 'FileMode', 'FileAccess', 'FileShare', 'FileOptions',
  'FileAttributes', 'SearchOption', 'SeekOrigin', 'ConsoleColor', 'EnvironmentVariableTarget', 'LazyThreadSafetyMode',
  'TaskCreationOptions', 'TaskContinuationOptions', 'MethodImplOptions', 'AttributeTargets', 'HttpStatusCode',
  'Base64FormattingOptions', 'TimeSpanStyles', 'UnicodeCategory', 'JsonIgnoreCondition', 'JsonValueKind', 'JsonTokenType',
]);

const LITERAL_TYPES = new Set([
  'string_literal',
  'verbatim_string_literal',
  'raw_string_literal',
  'character_literal',
  'integer_literal',
  'real_literal',
  'boolean_literal',
  'null_literal',
]);

/**
 * Syntax without side effects whose value is computed from its children. Operators, indexers, conditions,
 * conversions and member reads are not here: on a value of a type declared in the program they run its code.
 */
const PURE_CONTAINERS = new Set([
  'parenthesized_expression',
  'checked_expression',
  'argument',
  'argument_list',
  'initializer_expression',
  'collection_expression',
  'tuple_expression',
  'array_creation_expression',
  'implicit_array_creation_expression',
  'array_rank_specifier',
  'equals_value_clause',
  'bracketed_argument_list',
  'range_expression',
  'pattern',
  'anonymous_object_creation_expression',
  'switch_expression',
  'switch_expression_arm',
  'with_expression',
  'this_expression',
  'base_expression',
]);

const TYPE_NODES = new Set([
  'predefined_type',
  'generic_name',
  'array_type',
  'nullable_type',
  'qualified_name',
  'tuple_type',
  'pointer_type',
  'alias_qualified_name',
  'type_argument_list',
  'implicit_type',
]);

/** Syntax whose children are types only: `typeof(T)`, `sizeof(T)`, `default(T)`. */
const TYPE_ONLY = new Set(['typeof_expression', 'sizeof_expression', 'default_expression']);

const DEFERRED = new Set(['lambda_expression', 'anonymous_method_expression']);

const TYPE_DECLARATIONS = new Set([
  'class_declaration', 'struct_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration',
  'record_struct_declaration', 'delegate_declaration',
]);

interface Scan {
  refs: Set<string>;
  opaque: boolean;
  /** Reads a field or auto-property of this type, with or without initializer. */
  readsState: boolean;
}

/** What the initializers of one member declaration (field, event field or property) need. */
export function analyzeInitializers(declaration: Node, isStatic: boolean, context: InitContext): InitInfo {
  const declares = new Set<string>();
  const scan: Scan = { refs: new Set<string>(), opaque: false, readsState: false };

  for (const { name, value, typeName } of initializersOf(declaration)) {
    declares.add(name);
    scanExpression(value, context, typeName, scan);
    if (mayRunUserConversion(value, typeName, declaration, context)) {
      scan.opaque = true;
    }
  }

  if (declares.size === 0) {
    return NO_INIT;
  }

  // A member initializing itself from its own name (`int a = a`) is not a dependency on another member.
  for (const name of declares) {
    scan.refs.delete(name);
  }

  return {
    staticInit: isStatic,
    instanceInit: !isStatic,
    staticOpaque: isStatic && scan.opaque,
    instanceOpaque: !isStatic && scan.opaque,
    instanceReadsState: !isStatic && scan.readsState,
    declares,
    refs: scan.refs,
  };
}

export function mergeInitInfo(infos: readonly InitInfo[]): InitInfo {
  const nonEmpty = infos.filter((info) => info !== NO_INIT);
  if (nonEmpty.length === 0) {
    return NO_INIT;
  }

  return {
    staticInit: nonEmpty.some((info) => info.staticInit),
    instanceInit: nonEmpty.some((info) => info.instanceInit),
    staticOpaque: nonEmpty.some((info) => info.staticOpaque),
    instanceOpaque: nonEmpty.some((info) => info.instanceOpaque),
    instanceReadsState: nonEmpty.some((info) => info.instanceReadsState),
    declares: new Set(nonEmpty.flatMap((info) => [...info.declares])),
    refs: new Set(nonEmpty.flatMap((info) => [...info.refs])),
  };
}

/**
 * Whether two members with initializers must keep their relative order (`first` is declared
 * before `second`): one reads what the other initializes, or one runs code that may observe the
 * state the other initializes (or both run code that can have side effects on each other).
 */
export function mustKeepOrder(first: InitInfo, second: InitInfo): boolean {
  if ((first.staticOpaque && second.staticInit) || (second.staticOpaque && first.staticInit)) {
    return true;
  }

  // An instance initializer cannot touch `this`, but one that runs code may change static state that
  // another instance initializer reads or that its code observes.
  const firstObserves = first.instanceOpaque || first.instanceReadsState;
  const secondObserves = second.instanceOpaque || second.instanceReadsState;
  if ((first.instanceOpaque && secondObserves) || (second.instanceOpaque && firstObserves)) {
    return true;
  }

  return intersects(second.refs, first.declares) || intersects(first.refs, second.declares);
}

function intersects(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const item of a) {
    if (b.has(item)) {
      return true;
    }
  }

  return false;
}

/** Predefined value types and `string`: the language defines their operators. */
const PRIMITIVE_TYPES = new Set([
  'bool', 'byte', 'sbyte', 'char', 'decimal', 'double', 'float', 'int', 'uint', 'nint', 'nuint', 'long', 'ulong', 'short', 'ushort',
  'string',
]);

/** Binary operators that yield `bool` when the language defines them. */
const BOOLEAN_OPERATORS = new Set(['==', '!=', '<', '>', '<=', '>=', '&&', '||']);

/**
 * What the syntax proves about the type of a value: `primitive` (a predefined value type, `string` or an
 * enum), `library` (`object` or a known library type, with known library type arguments) or `array`. The
 * operators, indexers, conversions and accessors of these types are the language's or the library's. A value
 * of any other type (`undefined`) may be of a type declared in the program, whose user-defined operators,
 * indexers, conversions and accessors run its code, which may read this type's statics.
 */
type ValueKind = 'primitive' | 'library' | 'array' | undefined;

function kindOfType(typeText: string, node: Node): ValueKind {
  // `int?` is `Nullable<int>`: its lifted operators are the language's.
  const text = typeText.trim().replace(/\s*\?$/, '');
  if (/\[[\s,]*\]$/.test(text)) {
    return 'array';
  }

  if (PRIMITIVE_TYPES.has(text) || isEnumName(text, node)) {
    return 'primitive';
  }

  // Every type named, `List` and its type arguments alike, must be known (a tuple names its elements too).
  const names = text.match(/[A-Za-z_]\w*(?:\s*(?:\.|::)\s*[A-Za-z_]\w*)*/g) ?? [];
  const isLibrary = (name: string): boolean => {
    const last = lastIdentifier(name.replace(/^.*::/, ''));

    return last === 'object' || PRIMITIVE_TYPES.has(last) || PURE_CONSTRUCTED_TYPES.has(last) || PURE_STATIC_TYPES.has(last) || isEnumName(name, node);
  };

  return names.length > 0 && names.every(isLibrary) ? 'library' : undefined;
}

function isEnumName(name: string, node: Node): boolean {
  return LIBRARY_ENUMS.has(lastIdentifier(name)) || isDeclaredEnum(node, name);
}

/** Both values are of known types: `primitive` if both are, else `library`. */
function joinKinds(a: ValueKind, b: ValueKind): ValueKind {
  if (a === undefined || b === undefined) {
    return undefined;
  }

  return a === 'primitive' && b === 'primitive' ? 'primitive' : 'library';
}

/** The kind of the declared type of a field or property of this type read by name. */
function kindOfMember(name: string, node: Node, context: InitContext): ValueKind {
  const type = context.types.get(name);

  return type === undefined ? undefined : kindOfType(type, node);
}

/**
 * The kinds already computed for the nodes of each container: the operator checks ask for the kinds of the
 * operands at every level of an expression, so each subtree is analysed once rather than once per level.
 */
const KIND_CACHE = new WeakMap<InitContext, Map<Node, ValueKind>>();

function kindOfValue(node: Node, context: InitContext): ValueKind {
  let kinds = KIND_CACHE.get(context);
  if (!kinds) {
    kinds = new Map();
    KIND_CACHE.set(context, kinds);
  }

  if (kinds.has(node)) {
    return kinds.get(node);
  }

  const kind = computeKind(node, context);
  kinds.set(node, kind);

  return kind;
}

function computeKind(node: Node, context: InitContext): ValueKind {
  if (LITERAL_TYPES.has(node.type)) {
    return node.type === 'null_literal' ? 'library' : 'primitive';
  }

  switch (node.type) {
    case 'interpolated_string_expression':
    case 'sizeof_expression':
    case 'is_pattern_expression':
      return 'primitive';

    case 'typeof_expression':
    case 'lambda_expression':
    case 'anonymous_method_expression':
      return 'library';

    case 'identifier':
      return kindOfMember(node.text, node, context);

    case 'member_access_expression':
      return kindOfMemberAccess(node, context);

    case 'parenthesized_expression':
    case 'checked_expression': {
      const inner = node.namedChildren[0];

      return inner ? kindOfValue(inner, context) : undefined;
    }

    case 'prefix_unary_expression':
    case 'postfix_unary_expression': {
      // `-x`, `!x`, `x!`: the operators of a known type are the language's or the library's.
      const operand = node.namedChildren[0];

      return operand ? kindOfValue(operand, context) : undefined;
    }

    case 'cast_expression':
    case 'default_expression': {
      const type = node.type === 'cast_expression' ? node.childForFieldName('type') : node.namedChildren[0];

      return type ? kindOfType(type.text, node) : undefined;
    }

    case 'binary_expression': {
      const operator = binaryOperator(node);
      const right = node.childForFieldName('right');
      if (operator === 'as') {
        return right ? kindOfType(right.text, node) : undefined;
      }

      if (binaryRunsUserCode(node, context)) {
        return undefined;
      }

      if (BOOLEAN_OPERATORS.has(operator)) {
        return 'primitive';
      }

      const left = node.childForFieldName('left');

      return left && right ? joinKinds(kindOfValue(left, context), kindOfValue(right, context)) : undefined;
    }

    case 'conditional_expression': {
      const [, consequence, alternative] = node.namedChildren;

      return !conditionalRunsUserCode(node, context) && consequence && alternative ? joinKinds(kindOfValue(consequence, context), kindOfValue(alternative, context)) : undefined;
    }

    case 'range_expression':
      return rangeRunsUserCode(node, context) ? undefined : 'primitive';

    case 'element_access_expression': {
      // A character of a string, an element of a library collection, or one of an array member of this type.
      const target = node.namedChildren[0];
      const kind = target && !elementAccessRunsUserCode(node, context) ? kindOfValue(target, context) : undefined;
      if (kind !== 'array') {
        return kind;
      }

      const arrayType = target?.type === 'identifier' ? context.types.get(target.text) : undefined;

      return arrayType === undefined ? undefined : kindOfType(arrayType.replace(/\s*\[[\s,]*\]\s*\??$/, ''), node);
    }

    case 'invocation_expression': {
      // A call of a known library method returns a library type, unless type arguments make it return
      // (or infer it from) a type of the program.
      const callee = node.namedChildren[0];
      const args = node.childForFieldName('arguments') ?? node.namedChildren.find((child) => child.type === 'argument_list');
      const isPure = callee?.type === 'member_access_expression' && isPureStaticCall(callee) && callee.namedChildren[callee.namedChildren.length - 1]?.type !== 'generic_name';

      return isPure && (args?.namedChildren ?? []).every((arg) => arg.namedChildren[0] !== undefined && kindOfValue(arg.namedChildren[0], context) !== undefined) ? 'library' : undefined;
    }

    case 'object_creation_expression':
      return kindOfType(node.childForFieldName('type')?.text ?? '', node) === undefined ? undefined : 'library';

    default:
      return undefined;
  }
}

function kindOfMemberAccess(node: Node, context: InitContext): ValueKind {
  const children = node.namedChildren;
  const target = children[0];
  const member = children[children.length - 1];
  if (!target || !member || target === member) {
    return undefined;
  }

  const typeName = target.type === 'generic_name' ? target.namedChildren[0]?.text : target.type === 'identifier' ? target.text : undefined;
  if (target.type === 'this_expression' || typeName === context.typeName) {
    return kindOfMember(member.text, node, context);
  }

  if (target.type === 'predefined_type') {
    // `int.MaxValue`, `string.Empty`.
    return PRIMITIVE_TYPES.has(target.text) ? 'primitive' : 'library';
  }

  if (typeName !== undefined && (target.type === 'generic_name' || !context.names.has(typeName))) {
    if (isEnumName(typeName, node)) {
      return 'primitive';
    }

    // A static member of a known library type (`EqualityComparer<int>.Default`) is of a library type.
    return kindOfType(target.text, node) === undefined ? undefined : 'library';
  }

  // A property of a primitive is `string.Length`, and the counts of an array are `int` and `long`;
  // any other property of a known type is of a library type.
  const targetKind = TYPE_NODES.has(target.type) ? undefined : kindOfValue(target, context);
  if (targetKind === 'primitive' || (targetKind === 'array' && ['Length', 'LongLength', 'Rank'].includes(member.text))) {
    return 'primitive';
  }

  return targetKind === undefined ? undefined : 'library';
}

/** The operator of a binary expression: the tokens between its operands (`>>` is two `>` tokens). */
function binaryOperator(node: Node): string {
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');

  return node.children
    .filter((child) => child !== left && child !== right)
    .map((child) => child.text)
    .join('');
}

/**
 * Whether a binary expression may call a user-defined operator: the operators of known types are the
 * language's or the library's. `+` needs primitive operands, since adding another value to a string calls
 * its `ToString`, which a type of the program may override. `as` converts by reference only.
 */
function binaryRunsUserCode(node: Node, context: InitContext): boolean {
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  const operator = binaryOperator(node);
  if (operator === 'as') {
    return false;
  }

  if (!left || !right) {
    return true;
  }

  const leftKind = kindOfValue(left, context);
  const rightKind = kindOfValue(right, context);
  if (operator === '+') {
    return leftKind !== 'primitive' || rightKind !== 'primitive';
  }

  return leftKind === undefined || rightKind === undefined;
}

/** `c ? a : b` may call a user-defined `operator true` of c or convert one branch to the type of the other. */
function conditionalRunsUserCode(node: Node, context: InitContext): boolean {
  const [condition, consequence, alternative] = node.namedChildren;

  return (
    !condition || !consequence || !alternative || kindOfValue(condition, context) !== 'primitive' || kindOfValue(consequence, context) === undefined || kindOfValue(alternative, context) === undefined
  );
}

/** `a..b` converts its operands to `Index`, which runs a user-defined conversion of another type. */
function rangeRunsUserCode(node: Node, context: InitContext): boolean {
  return node.namedChildren.some((operand) => kindOfValue(operand, context) !== 'primitive');
}

/** `a[i]` runs the indexer of a's type, and converts i to the parameter type of that indexer. */
function elementAccessRunsUserCode(node: Node, context: InitContext): boolean {
  const [target, args] = node.namedChildren;
  if (!target || !args || kindOfValue(target, context) === undefined) {
    return true;
  }

  return args.namedChildren.some((arg) => arg.namedChildren[0] === undefined || kindOfValue(arg.namedChildren[0], context) !== 'primitive');
}

/**
 * Whether storing `value` in a member of type `typeName` may run a user-defined conversion operator, which
 * the syntax does not show (`static Meters M = 2;` calls `implicit operator Meters(int)`, `static int I = m;`
 * calls `implicit operator int(Meters)`) and which may read this type's statics. A conversion to a primitive
 * or library type is user-defined only from a value of another type; a `null` or `default` literal, a lambda
 * and a creation of the declared type itself convert nothing.
 */
function mayRunUserConversion(value: Node, typeName: string, declaration: Node, context: InitContext): boolean {
  if (DEFERRED.has(value.type) || value.type === 'null_literal' || value.type === 'implicit_object_creation_expression' || (value.type === 'default_expression' && value.namedChildren.length === 0)) {
    return false;
  }

  if (value.type === 'object_creation_expression' && value.childForFieldName('type')?.text === typeName) {
    return false;
  }

  // `Meters?` and `Meters[]` convert their values (or elements) to `Meters`; no user-defined conversion converts to `object` or `dynamic`.
  const elementType = typeName.replace(/(?:\s*(?:\?|\[[\s,]*\]))+$/, '').trim();
  if (elementType === 'object' || elementType === 'dynamic') {
    return false;
  }

  return kindOfType(elementType, declaration) === undefined || mayBeOfProgramType(value, context);
}

/** Whether `value`, or an element of an array or collection it lists, may be of a type declared in the program. */
function mayBeOfProgramType(value: Node, context: InitContext): boolean {
  switch (value.type) {
    case 'initializer_expression':
    case 'collection_expression':
      return value.namedChildren.some((element) => mayBeOfProgramType(element, context));

    case 'array_creation_expression':
    case 'implicit_array_creation_expression': {
      const type = value.childForFieldName('type');
      const elements = value.namedChildren.find((child) => child.type === 'initializer_expression');
      if (type && kindOfType(type.text, value) === undefined) {
        return true;
      }

      return elements !== undefined && mayBeOfProgramType(elements, context);
    }

    default:
      return kindOfValue(value, context) === undefined;
  }
}

interface Initializer {
  name: string;
  value: Node;
  typeName: string;
}

function initializersOf(declaration: Node): Initializer[] {
  if (declaration.type === 'property_declaration') {
    const children = declaration.children;
    const equals = children.findIndex((child) => child.type === '=');
    const name = declaration.childForFieldName('name')?.text;
    const value = equals >= 0 ? children[equals + 1] : undefined;

    return name && value ? [{ name, value, typeName: declaration.childForFieldName('type')?.text ?? '' }] : [];
  }

  const variableDeclaration = declaration.namedChildren.find((child) => child.type === 'variable_declaration');
  if (!variableDeclaration) {
    return [];
  }

  const typeName = variableDeclaration.namedChildren[0]?.text ?? '';
  const initializers: Initializer[] = [];
  for (const declarator of variableDeclaration.namedChildren.filter((child) => child.type === 'variable_declarator')) {
    const name = declarator.namedChildren.find((child) => child.type === 'identifier')?.text;
    const value = declarator.namedChildren.find((child) => child.type === 'equals_value_clause')?.namedChildren[0];
    if (name && value) {
      initializers.push({ name, value, typeName });
    }
  }

  return initializers;
}

function scanExpression(node: Node, context: InitContext, declaredType: string, scan: Scan): void {
  if (LITERAL_TYPES.has(node.type) || TYPE_NODES.has(node.type) || TYPE_ONLY.has(node.type) || DEFERRED.has(node.type)) {
    return;
  }

  switch (node.type) {
    case 'identifier':
      readName(node.text, context, scan);

      return;

    case 'interpolated_string_expression':
      scanInterpolation(node, context, scan);

      return;

    case 'member_access_expression':
      scanMemberAccess(node, context, declaredType, scan);

      return;

    case 'invocation_expression':
      scanInvocation(node, context, declaredType, scan);

      return;

    case 'object_creation_expression':
      scanCreation(node, node.childForFieldName('type')?.text ?? '', context, declaredType, scan);

      return;

    case 'implicit_object_creation_expression':
      scanCreation(node, declaredType, context, declaredType, scan);

      return;

    case 'cast_expression': {
      // The cast type names a type; only the operand is read. Converting a value of (or to) a type that
      // may be declared in the program may run its user-defined conversion.
      const operand = node.childForFieldName('value');
      if (!operand || kindOfValue(node, context) === undefined || kindOfValue(operand, context) === undefined) {
        scan.opaque = true;
      }

      if (operand) {
        scanExpression(operand, context, declaredType, scan);
      }

      return;
    }

    case 'binary_expression':
      if (binaryRunsUserCode(node, context)) {
        scan.opaque = true;
      }

      scanChildren(node, context, declaredType, scan);

      return;

    case 'conditional_expression':
      if (conditionalRunsUserCode(node, context)) {
        scan.opaque = true;
      }

      scanChildren(node, context, declaredType, scan);

      return;

    case 'element_access_expression':
      if (elementAccessRunsUserCode(node, context)) {
        scan.opaque = true;
      }

      scanChildren(node, context, declaredType, scan);

      return;

    case 'range_expression':
      if (rangeRunsUserCode(node, context)) {
        scan.opaque = true;
      }

      scanChildren(node, context, declaredType, scan);

      return;

    case 'is_pattern_expression': {
      // Type and constant patterns only name types or constants. Property, positional and list patterns
      // run getters, `Deconstruct`, `Length`/`Count` and indexers, which may read this type's statics.
      const operand = node.childForFieldName('expression');
      if (!operand || node.namedChildren.some((child) => child !== operand && /[{(\[]/.test(child.text))) {
        scan.opaque = true;

        return;
      }

      scanExpression(operand, context, declaredType, scan);

      return;
    }

    case 'prefix_unary_expression':
    case 'postfix_unary_expression':
      // `++x`, `x--` change what they read; `x!` (null-forgiving) and `-x` only compute from it, unless x
      // is of a type whose user-defined operator runs code.
      if (node.children.some((child) => child.type === '++' || child.type === '--') || kindOfValue(node, context) === undefined) {
        scan.opaque = true;

        return;
      }

      scanChildren(node, context, declaredType, scan);

      return;

    default:
      if (PURE_CONTAINERS.has(node.type)) {
        scanChildren(node, context, declaredType, scan);

        return;
      }

      // Anything not known to be free of side effects counts as running code.
      scan.opaque = true;
  }
}

function scanChildren(node: Node, context: InitContext, declaredType: string, scan: Scan): void {
  for (const child of node.namedChildren) {
    scanExpression(child, context, declaredType, scan);
  }
}

function readName(name: string, context: InitContext, scan: Scan): void {
  switch (context.names.get(name)) {
    case 'initialized':
      scan.refs.add(name);
      scan.readsState = true;

      return;

    case 'plain':
      // A field or auto-property without initializer: no dependency on another initializer, but state
      // that an initializer running code may change.
      scan.readsState = true;

      return;

    case 'computed':
      // Reading a property whose accessor runs code.
      scan.opaque = true;

      return;

    case undefined:
      // Not declared in this type body: a member of another partial part, a base type or a `using static`
      // type, possibly a property whose accessor reads this type's statics.
      scan.opaque = true;

      return;

    default:
      // A constant or a method group (not called).
  }
}

function scanMemberAccess(node: Node, context: InitContext, declaredType: string, scan: Scan): void {
  const children = node.namedChildren;
  const target = children[0];
  const member = children[children.length - 1];

  if (!target || !member || target === member) {
    scan.opaque = true;

    return;
  }

  // `C<T>.Member` names this type like `C.Member`, and `G<int>.Member` another type like `Other.Member`.
  const typeName = target.type === 'generic_name' ? target.namedChildren[0]?.text : target.type === 'identifier' ? target.text : undefined;

  if (target.type === 'this_expression' || typeName === context.typeName) {
    readName(member.text, context, scan);

    return;
  }

  if (typeName !== undefined && (target.type === 'generic_name' || !context.names.has(typeName))) {
    // `Other.Member`: a known library type or an enum value is pure; any other may be a member declared
    // elsewhere, or a type whose static constructor and accessors run code.
    if (!PURE_STATIC_TYPES.has(typeName) && !PURE_CONSTRUCTED_TYPES.has(typeName) && !LIBRARY_ENUMS.has(typeName) && !isDeclaredEnum(node, typeName)) {
      scan.opaque = true;
    }

    return;
  }

  // `value.Member` runs the accessor of a property, which a type declared in the program may have.
  if (!TYPE_NODES.has(target.type) && kindOfValue(target, context) === undefined) {
    scan.opaque = true;
  }

  scanExpression(target, context, declaredType, scan);
}

/**
 * Whether `name` used at `node` resolves to an enum declared in this file: the innermost scope declaring
 * a type or member of that name decides (a field, property, method or event of an enclosing type binds
 * first). The search stops at a type that has a base list or other partial parts, whose inherited or
 * unseen members and nested types may shadow an outer enum.
 */
function isDeclaredEnum(node: Node, name: string): boolean {
  for (let scope = node.parent; scope; scope = scope.parent) {
    if (scope.type !== 'declaration_list' && scope.type !== 'compilation_unit' && scope.type !== 'file_scoped_namespace_declaration') {
      continue;
    }

    const declared = scope.namedChildren.find((child) => TYPE_DECLARATIONS.has(child.type) && child.childForFieldName('name')?.text === name);
    if (declared) {
      return declared.type === 'enum_declaration';
    }

    if (scope.namedChildren.some((child) => declaresMemberNamed(child, name))) {
      return false;
    }

    const owner = scope.parent;
    if (owner && TYPE_DECLARATIONS.has(owner.type) && (owner.namedChildren.some((child) => child.type === 'base_list') || owner.namedChildren.some((child) => child.type === 'modifier' && child.text === 'partial'))) {
      return false;
    }
  }

  return false;
}

/** Whether `member` declares a field, event, property or method named `name`. */
function declaresMemberNamed(member: Node, name: string): boolean {
  switch (member.type) {
    case 'field_declaration':
    case 'event_field_declaration':
      return (member.namedChildren.find((child) => child.type === 'variable_declaration')?.namedChildren ?? []).some(
        (child) => child.type === 'variable_declarator' && child.namedChildren.find((part) => part.type === 'identifier')?.text === name
      );

    case 'property_declaration':
    case 'method_declaration':
    case 'event_declaration':
      return member.childForFieldName('name')?.text === name;

    default:
      return false;
  }
}

function scanInvocation(node: Node, context: InitContext, declaredType: string, scan: Scan): void {
  const callee = node.namedChildren[0];
  const args = node.childForFieldName('arguments') ?? node.namedChildren.find((child) => child.type === 'argument_list');

  if (callee?.type === 'identifier' && callee.text === 'nameof') {
    return;
  }

  if (callee?.type === 'member_access_expression' && isPureStaticCall(callee)) {
    if (args) {
      scanChildren(args, context, declaredType, scan);
    }

    return;
  }

  scan.opaque = true;
}

function isPureStaticCall(callee: Node): boolean {
  const target = callee.namedChildren[0];
  if (!target) {
    return false;
  }

  if (target.type === 'predefined_type') {
    return true;
  }

  const name = target.type === 'generic_name' ? target.namedChildren[0]?.text : target.text;

  return name !== undefined && PURE_STATIC_TYPES.has(name);
}

function scanCreation(node: Node, typeText: string, context: InitContext, declaredType: string, scan: Scan): void {
  if (!PURE_CONSTRUCTED_TYPES.has(lastIdentifier(typeText))) {
    scan.opaque = true;

    return;
  }

  for (const child of node.namedChildren) {
    if (child.type === 'argument_list' || child.type === 'initializer_expression') {
      scanChildren(child, context, declaredType, scan);
    }
  }
}

/** `System.Collections.Generic.List<int>` -> `List`. */
function lastIdentifier(typeText: string): string {
  const withoutArguments = typeText.replace(/<.*$/s, '');
  const dot = withoutArguments.lastIndexOf('.');

  return (dot >= 0 ? withoutArguments.slice(dot + 1) : withoutArguments).trim();
}

/**
 * The holes of `$"...{expression}..."` are scanned by their identifiers: a call in a hole runs code, and
 * so may a hole with braces of its own (a switch expression, an object or collection initializer), and a
 * member of a type that may be declared in the program (its `ToString`, operators and accessors).
 */
function scanInterpolation(node: Node, context: InitContext, scan: Scan): void {
  for (const hole of interpolationHoles(node.text)) {
    const expression = holeExpression(hole);
    if (/[({]/.test(expression)) {
      scan.opaque = true;
    }

    for (const identifier of expression.match(/[A-Za-z_]\w*/g) ?? []) {
      readName(identifier, context, scan);
      if (context.types.has(identifier) && kindOfMember(identifier, node, context) === undefined) {
        scan.opaque = true;
      }
    }
  }
}

/**
 * The text inside each `{...}` hole, matching nested braces and skipping string literals inside the hole.
 * A run of braces opens and closes one hole, so escaped `{{text}}` is read as a hole too (conservatively).
 */
function interpolationHoles(text: string): string[] {
  const holes: string[] = [];
  let i = 0;

  while (i < text.length) {
    if (text[i] !== '{') {
      i++;
      continue;
    }

    while (text[i] === '{') {
      i++;
    }

    const start = i;
    let depth = 0;
    let quote = '';
    for (; i < text.length; i++) {
      const char = text[i];
      if (quote) {
        if (char === '\\') {
          i++;
        } else if (char === quote) {
          quote = '';
        }
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '{') {
        depth++;
      } else if (char === '}') {
        if (depth === 0) {
          break;
        }

        depth--;
      }
    }

    holes.push(text.slice(start, i));
    while (text[i] === '}') {
      i++;
    }
  }

  return holes;
}

/** `x,10:N2` -> `x`: the alignment (a constant) and the format string after the expression are not read. */
function holeExpression(hole: string): string {
  let depth = 0;
  let quote = '';

  for (let i = 0; i < hole.length; i++) {
    const char = hole[i];
    if (quote) {
      if (char === '\\') {
        i++;
      } else if (char === quote) {
        quote = '';
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '(' || char === '[' || char === '{') {
      depth++;
    } else if (char === ')' || char === ']' || char === '}') {
      depth--;
    } else if (depth === 0 && (char === ',' || (char === ':' && hole[i + 1] !== ':'))) {
      return hole.slice(0, i);
    }
  }

  return hole;
}
