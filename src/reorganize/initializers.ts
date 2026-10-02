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
  declares: new Set<string>(),
  refs: new Set<string>(),
};

/** What the members of the type are named, to tell a read of a field from a call of code. */
export type MemberNameClass = 'initialized' | 'plain' | 'constant' | 'method' | 'computed';

export interface InitContext {
  typeName: string;
  names: ReadonlyMap<string, MemberNameClass>;
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

/** Syntax without side effects whose value is computed from its children. */
const PURE_CONTAINERS = new Set([
  'parenthesized_expression',
  'binary_expression',
  'conditional_expression',
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
  'element_access_expression',
  'bracketed_argument_list',
  'range_expression',
  'pattern',
  'anonymous_object_creation_expression',
  'postfix_unary_expression',
  'conditional_access_expression',
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
}

/** What the initializers of one member declaration (field, event field or property) need. */
export function analyzeInitializers(declaration: Node, isStatic: boolean, context: InitContext): InitInfo {
  const declares = new Set<string>();
  const scan: Scan = { refs: new Set<string>(), opaque: false };

  for (const { name, value, typeName } of initializersOf(declaration)) {
    declares.add(name);
    scanExpression(value, context, typeName, scan);
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

  if (first.instanceOpaque && second.instanceOpaque) {
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
      scanInterpolation(node.text, context, scan);

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
      // The cast type names a type; only the operand is read.
      const operand = node.childForFieldName('value');
      if (operand) {
        scanExpression(operand, context, declaredType, scan);
      } else {
        scan.opaque = true;
      }

      return;
    }

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
      if (node.children.some((child) => child.type === '++' || child.type === '--')) {
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
      // A constant, a method group (not called) or a field without initializer.
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

  if (target.type === 'this_expression' || (target.type === 'identifier' && target.text === context.typeName)) {
    readName(member.text, context, scan);

    return;
  }

  if (target.type === 'identifier' && !context.names.has(target.text)) {
    // `Other.Member`: a known library type or an enum value is pure; any other may be a member declared
    // elsewhere, or a type whose static constructor and accessors run code.
    if (!PURE_STATIC_TYPES.has(target.text) && !PURE_CONSTRUCTED_TYPES.has(target.text) && !LIBRARY_ENUMS.has(target.text) && !isDeclaredEnum(node, target.text)) {
      scan.opaque = true;
    }

    return;
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
 * so may a hole with braces of its own (a switch expression, an object or collection initializer).
 */
function scanInterpolation(text: string, context: InitContext, scan: Scan): void {
  for (const hole of interpolationHoles(text)) {
    const expression = holeExpression(hole);
    if (/[({]/.test(expression)) {
      scan.opaque = true;
    }

    for (const identifier of expression.match(/[A-Za-z_]\w*/g) ?? []) {
      readName(identifier, context, scan);
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
