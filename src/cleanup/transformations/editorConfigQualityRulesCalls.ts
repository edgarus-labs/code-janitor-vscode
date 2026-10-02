import { findApplicableRule, parseNamingRules } from '../naming/namingRules';
import { Node, TextEdit, applyEdits, walk } from '../parser';
import type { RuleContext } from './editorConfigCodeStyle';
import { hasModifier, newlineOf } from './editorConfigSupport';
import { FileView, isString, positionalArguments, viewOf } from './editorConfigQualityRulesExpressions';
import { targetFrameworksOf } from './editorConfigQualityRulesProject';
import { FrameworkApi, frameworksSupport, isRuleActive, normalizeType, simpleTypeName, unwrapParentheses } from './editorConfigQualityRulesSupport';

/**
 * Call-site code-quality rules: CA1861 (constant array arguments), CA1869 (cached
 * JsonSerializerOptions), CA2016 (forward the CancellationToken) and CA2263 (generic overloads).
 * The fixes are limited to BCL methods whose behavior with the changed arguments is known; every
 * other violation found is reported.
 */

interface Call {
  readonly invocation: Node;
  readonly receiver: Node;
  readonly name: string;
  readonly args: readonly Node[];
}

function callOf(node: Node): Call | undefined {
  const callee = node.type === 'invocation_expression' ? node.childForFieldName('function') : null;
  const receiver = callee?.type === 'member_access_expression' ? callee.childForFieldName('expression') : null;
  const name = callee?.childForFieldName('name')?.text;
  const args = positionalArguments(node);

  return receiver && name && args ? { invocation: node, receiver, name, args } : undefined;
}

/** Whether `receiver` names the BCL type `name` (simple or qualified with `namespace`), not a type of the project. */
function isBclType(view: FileView, receiver: Node, name: string, namespace: string): boolean {
  const text = receiver.text.replace(/\s+/g, '').replace(/^global::/, '');

  return text === `${namespace}.${name}` || (text === name && !view.types.declaresType(name) && view.types.typeOf(receiver) === undefined);
}

/** The simple name of the declared type of `receiver`, unless the project declares a type of that name. */
function declaredTypeName(view: FileView, receiver: Node): string | undefined {
  const type = view.types.typeOf(receiver);
  const name = type ? simpleTypeName(type) : undefined;

  return name && !view.types.declaresType(name) ? name : undefined;
}

// ---------------------------------------------------------------------------------------------
// New static readonly fields (CA1861, CA1869)
// ---------------------------------------------------------------------------------------------

const FIELD_OWNERS = new Set(['class_declaration', 'struct_declaration', 'record_declaration']);

function innermostType(node: Node): Node | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (FIELD_OWNERS.has(current.type) || current.type === 'interface_declaration' || current.type === 'enum_declaration') {
      return FIELD_OWNERS.has(current.type) ? current : undefined;
    }
  }

  return undefined;
}

/** Static contexts that run once: moving a value out of them caches nothing. */
function runsOnce(node: Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === 'constructor_declaration' || current.type === 'field_declaration' || current.type === 'property_declaration') {
      return hasModifier(current, 'static') && (current.type !== 'property_declaration' || current.childForFieldName('value') !== null);
    }

    if (current.type === 'method_declaration' || current.type === 'lambda_expression' || current.type === 'local_function_statement' || current.type === 'accessor_declaration') {
      return false;
    }
  }

  return false;
}

/** Collects the `private static readonly` fields a pass adds, one insertion per type. */
class FieldPlanner {
  private readonly fields = new Map<Node, string[]>();
  private readonly used: Set<string>;
  private readonly namingRule;

  constructor(
    private readonly view: FileView,
    private readonly context: RuleContext
  ) {
    this.used = new Set(walk(view.model.root).filter((node) => node.type === 'identifier').map((node) => node.text));
    this.namingRule = findApplicableRule(parseNamingRules(context.props), {
      kind: 'field',
      accessibility: 'private',
      modifiers: new Set(['static', 'readonly']),
    });
  }

  /** Why no field can be added to the type declaring `node`, or `undefined` when one can. */
  blocker(node: Node): string | undefined {
    const type = innermostType(node);
    if (!type) {
      return 'it is not inside a class, struct or record';
    }

    if (hasModifier(type, 'partial')) {
      return 'its type is partial, and another part may declare the new field\'s name';
    }

    const body = type.childForFieldName('body');
    const brace = body?.children[0];
    if (body?.type !== 'declaration_list' || brace?.type !== '{' || !/^[ \t]*\r?\n/.test(this.view.source.slice(brace.endIndex))) {
      return 'its type body does not start on a line of its own';
    }

    return undefined;
  }

  /** Plans `private static readonly <type> <name> = <initializer>;` in the type declaring `node`; returns the field name. */
  add(node: Node, typeText: string, baseName: string, initializer: string): string {
    const type = innermostType(node) as Node;
    let name = this.compliant(baseName);
    for (let index = 1; this.used.has(name); index++) {
      name = this.compliant(`${baseName}${index}`);
    }

    this.used.add(name);
    const list = this.fields.get(type) ?? [];
    list.push(`private static readonly ${typeText} ${name} = ${initializer};`);
    this.fields.set(type, list);

    return name;
  }

  edits(): TextEdit[] {
    const edits: TextEdit[] = [];
    for (const [type, declarations] of this.fields) {
      const body = type.childForFieldName('body') as Node;
      const brace = body.children[0];
      const firstMember = body.namedChildren.find((child) => child.type !== 'comment');
      const indent = firstMember
        ? /[ \t]*$/.exec(this.view.source.slice(0, firstMember.startIndex))?.[0] ?? this.context.indent
        : `${/^[ \t]*/.exec(this.view.source.slice(this.view.source.lastIndexOf('\n', type.startIndex) + 1))?.[0] ?? ''}${this.context.indent}`;
      // Blank-line padding separates multi-line fields and members other than single-line fields from
      // what follows them; give the added fields that layout too, so a later cleanup has nothing to add.
      const newline = newlineOf(this.view.source);
      const lines = declarations.map((declaration, index) => `${index > 0 && declarations[index - 1].includes('\n') ? newline : ''}${newline}${indent}${declaration}`).join('');
      const lastIsMultiLine = declarations[declarations.length - 1].includes('\n');
      const blank = firstMember && (lastIsMultiLine || firstMember.type !== 'field_declaration' || firstMember.text.includes('\n')) ? newline : '';
      edits.push({ start: brace.endIndex, end: brace.endIndex, text: `${lines}${blank}` });
    }

    return edits;
  }

  private compliant(name: string): string {
    return this.namingRule ? this.namingRule.style.makeCompliant(name) : name;
  }
}

// ---------------------------------------------------------------------------------------------
// CA1861 Avoid constant arrays as arguments
// ---------------------------------------------------------------------------------------------

const LITERALS = new Set(['string_literal', 'verbatim_string_literal', 'character_literal', 'integer_literal', 'real_literal', 'boolean_literal']);

/** `string` methods that only read the array they get, with the name of the field it becomes. */
const READ_ONLY_ARRAY_METHODS: Record<string, string> = {
  Split: 'Separators',
  Trim: 'TrimCharacters',
  TrimStart: 'TrimCharacters',
  TrimEnd: 'TrimCharacters',
  IndexOfAny: 'SearchCharacters',
  LastIndexOfAny: 'SearchCharacters',
};

/** The elements of an array creation with an initializer of literals only, or `undefined`. */
function constantElements(creation: Node): Node[] | undefined {
  const initializer = creation.namedChildren.find((child) => child.type === 'initializer_expression');
  const elements = initializer?.namedChildren ?? [];

  return initializer && elements.length > 0 && elements.every((element) => LITERALS.has(element.type)) ? elements : undefined;
}

/** The element type of a constant array creation when it is `char` or `string`. */
function textArrayType(creation: Node, elements: readonly Node[]): 'char' | 'string' | undefined {
  if (creation.type === 'array_creation_expression') {
    const type = normalizeType(creation.namedChildren.find((child) => child.type === 'array_type')?.text ?? '');

    return type === 'char[]' || type === 'string[]' ? (type.slice(0, -2) as 'char' | 'string') : undefined;
  }

  if (elements.every((element) => element.type === 'character_literal')) {
    return 'char';
  }

  return elements.every((element) => element.type === 'string_literal' || element.type === 'verbatim_string_literal') ? 'string' : undefined;
}

/** `string` methods returning a new string, through which a chain stays a string. */
const STRING_RESULTS = new Set(['Trim', 'TrimStart', 'TrimEnd', 'ToLower', 'ToUpper', 'ToLowerInvariant', 'ToUpperInvariant', 'Substring', 'Replace', 'PadLeft', 'PadRight', 'Insert', 'Remove', 'Normalize']);

function isStringExpression(view: FileView, node: Node): boolean {
  const expression = unwrapParentheses(node);
  const call = expression.type === 'invocation_expression' ? callOf(expression) : undefined;

  return call ? STRING_RESULTS.has(call.name) && isStringExpression(view, call.receiver) : isString(view, expression);
}

export function applyConstantArrayArguments(source: string, context: RuleContext): string {
  if (!isRuleActive(context, 'CA1861', source) || !/\bnew\b[^;]*\{/.test(source)) {
    return source;
  }

  const view = viewOf(source, context);
  const planner = new FieldPlanner(view, context);
  for (const creation of walk(view.model.root)) {
    const argument = creation.parent;
    const invocation = argument?.parent?.parent;
    if (
      (creation.type !== 'array_creation_expression' && creation.type !== 'implicit_array_creation_expression') ||
      argument?.type !== 'argument' ||
      argument.namedChildren.length !== 1 ||
      invocation?.type !== 'invocation_expression' ||
      runsOnce(creation) ||
      view.suppressions.isSuppressed('CA1861', creation)
    ) {
      continue;
    }

    const elements = constantElements(creation);
    if (!elements) {
      continue;
    }

    const elementType = textArrayType(creation, elements);
    const call = callOf(invocation);
    const fieldName = call ? READ_ONLY_ARRAY_METHODS[call.name] : undefined;
    const readOnlyCallee = call && fieldName && call.args[0] === creation && isStringExpression(view, call.receiver) && (elementType === 'char' || (call.name === 'Split' && elementType === 'string'));
    const problem = !readOnlyCallee ? `${invocation.childForFieldName('function')?.text} might change or keep the array` : planner.blocker(creation);
    if (problem) {
      view.report('CA1861', creation, `${creation.text} is a constant array created on every call, but ${problem}; it was kept.`);
      continue;
    }

    const name = planner.add(creation, `${elementType}[]`, fieldName as string, creation.text);
    view.edits.push({ start: creation.startIndex, end: creation.endIndex, text: name });
  }

  view.edits.push(...planner.edits());

  return applyEdits(source, view.edits);
}

// ---------------------------------------------------------------------------------------------
// CA1869 Cache and reuse 'JsonSerializerOptions' instances
// ---------------------------------------------------------------------------------------------

const SERIALIZER_METHODS = /^(?:Serialize|Deserialize|SerializeAsync|DeserializeAsync|SerializeToUtf8Bytes|SerializeToDocument|SerializeToElement|SerializeToNode|DeserializeAsyncEnumerable)$/;

/** Values an options initializer may use: constants and the stateless members of System.Text.Json. */
const JSON_CONSTANT = /^(?:System\.Text\.(?:Json(?:\.Serialization)?|Encodings\.Web)\.)?(?:JsonNamingPolicy|JsonIgnoreCondition|JsonNumberHandling|JsonCommentHandling|JsonUnknownTypeHandling|JsonUnmappedMemberHandling|JsonKnownNamingPolicy|JsonSerializerDefaults|ReferenceHandler|JavaScriptEncoder)\.\w+$/;
const STATELESS_CONVERTER = /^new(?:System\.Text\.Json\.Serialization\.)?JsonStringEnumConverter\(\)$/;

/** Whether an options creation depends only on constants, so one shared instance behaves the same. */
function isConstantOptions(creation: Node): boolean {
  const args = positionalArguments(creation) ?? [];
  if (args.length > 1 || (args[0] && !JSON_CONSTANT.test(args[0].text.replace(/\s+/g, '')))) {
    return false;
  }

  const initializer = creation.childForFieldName('initializer');
  for (const assignment of initializer?.namedChildren ?? []) {
    const left = assignment.childForFieldName('left');
    const right = assignment.childForFieldName('right');
    if (assignment.type !== 'assignment_expression' || left?.type !== 'identifier' || !right) {
      return false;
    }

    const constant =
      LITERALS.has(right.type) ||
      right.type === 'null_literal' ||
      JSON_CONSTANT.test(right.text.replace(/\s+/g, '')) ||
      (right.type === 'initializer_expression' && right.namedChildren.every((item) => STATELESS_CONVERTER.test(item.text.replace(/\s+/g, ''))));
    if (!constant) {
      return false;
    }
  }

  return true;
}

export function applyCachedJsonOptions(source: string, context: RuleContext): string {
  if (!isRuleActive(context, 'CA1869', source) || !/\bJsonSerializerOptions\b/.test(source)) {
    return source;
  }

  const view = viewOf(source, context);
  const planner = new FieldPlanner(view, context);
  for (const creation of walk(view.model.root)) {
    const typeText = createdType(creation);
    if (typeText === undefined || ((typeText !== 'JsonSerializerOptions' || view.types.declaresType('JsonSerializerOptions')) && typeText !== 'System.Text.Json.JsonSerializerOptions')) {
      continue;
    }

    const use = serializerUse(view, creation);
    if (!use || runsOnce(creation) || view.suppressions.isSuppressed('CA1869', use.argument)) {
      continue;
    }

    const problem = !isConstantOptions(creation) ? 'its settings depend on the call' : planner.blocker(creation);
    if (problem) {
      view.report('CA1869', creation, `${creation.text} is created for a single serializer call, but ${problem}; it was kept.`);
      continue;
    }

    const name = planner.add(creation, typeText, 'JsonOptions', creation.text);
    view.edits.push({ start: use.argument.startIndex, end: use.argument.endIndex, text: name });
    if (use.declaration) {
      view.edits.push(removeLine(source, use.declaration));
    }
  }

  view.edits.push(...planner.edits());

  return applyEdits(source, view.edits);
}

/** The type an object creation creates: written in it, or (for `new(...)`) declared by the local it initializes. */
function createdType(creation: Node): string | undefined {
  if (creation.type === 'object_creation_expression') {
    return normalizeType(creation.childForFieldName('type')?.text ?? '');
  }

  const declaration = creation.type === 'implicit_object_creation_expression' ? creation.parent?.parent?.parent : undefined;
  const type = declaration?.type === 'variable_declaration' ? declaration.childForFieldName('type') : undefined;

  return type && creation.parent?.type === 'equals_value_clause' && type.type !== 'implicit_type' ? normalizeType(type.text) : undefined;
}

/**
 * The serializer argument an options creation is used as: the creation itself passed to
 * `JsonSerializer.X(...)`, or a local initialized with it whose only use is such an argument.
 */
function serializerUse(view: FileView, creation: Node): { argument: Node; declaration?: Node } | undefined {
  const isSerializerArgument = (node: Node): boolean => {
    const argument = node.parent;
    const invocation = argument?.parent?.parent;
    const call = invocation ? callOf(invocation) : undefined;

    // `JsonSerializer.Deserialize<T>(...)` names the method with a generic_name: match its identifier.
    const method = call?.name.replace(/\s*<[\s\S]*$/, '');

    return argument?.type === 'argument' && argument.namedChildren.length === 1 && call !== undefined && SERIALIZER_METHODS.test(method ?? '') && isBclType(view, call.receiver, 'JsonSerializer', 'System.Text.Json');
  };

  if (isSerializerArgument(creation)) {
    return { argument: creation };
  }

  const declarator = creation.parent?.parent;
  const declaration = declarator?.parent;
  const statement = declaration?.parent;
  const name = declarator?.childForFieldName('name');
  if (
    creation.parent?.type !== 'equals_value_clause' ||
    declarator?.type !== 'variable_declarator' ||
    declaration?.namedChildren.filter((child) => child.type === 'variable_declarator').length !== 1 ||
    statement?.type !== 'local_declaration_statement' ||
    statement.parent?.type !== 'block' ||
    !name
  ) {
    return undefined;
  }

  const references = walk(statement.parent).filter((node) => node.type === 'identifier' && node.text === name.text && node !== name);

  return references.length === 1 && isSerializerArgument(references[0]) && view.types.localDeclaration(name.text, references[0].startIndex)?.nameNode === name
    ? { argument: references[0], declaration: statement }
    : undefined;
}

function removeLine(source: string, statement: Node): TextEdit {
  const lineStart = source.lastIndexOf('\n', statement.startIndex - 1) + 1;
  const lineEnd = source.indexOf('\n', statement.endIndex);
  const alone = /^\s*$/.test(source.slice(lineStart, statement.startIndex)) && /^\s*$/.test(source.slice(statement.endIndex, lineEnd < 0 ? source.length : lineEnd));

  return alone ? { start: lineStart, end: lineEnd < 0 ? source.length : lineEnd + 1, text: '' } : { start: statement.startIndex, end: statement.endIndex, text: '' };
}

// ---------------------------------------------------------------------------------------------
// CA2016 Forward the CancellationToken parameter to methods that take one
// ---------------------------------------------------------------------------------------------

interface TokenOverload {
  /** Current positional argument counts that get the token appended; the fewest is the method's required arguments. */
  readonly counts: readonly number[];
  /** Target framework API the overload needs, when not every framework has it. */
  readonly api?: FrameworkApi;
  /** The API needed only for calls with this many arguments. */
  readonly apiForCount?: { readonly count: number; readonly api: FrameworkApi };
  /** The token overload returns a ValueTask where the current one returns a Task: only an awaited result keeps its meaning. */
  readonly returnsValueTask?: boolean;
}

const STREAM_TYPES = new Set(['Stream', 'FileStream', 'MemoryStream', 'BufferedStream', 'NetworkStream', 'GZipStream', 'DeflateStream', 'BrotliStream', 'CryptoStream', 'SslStream', 'PipeStream']);

/** Static BCL methods with a trailing CancellationToken overload, by type. */
const STATIC_TOKEN_METHODS: Record<string, { namespace: string; methods: Record<string, TokenOverload> }> = {
  Task: { namespace: 'System.Threading.Tasks', methods: { Delay: { counts: [1] } } },
  File: {
    namespace: 'System.IO',
    methods: Object.fromEntries(
      ['ReadAllTextAsync', 'ReadAllLinesAsync', 'ReadAllBytesAsync'].map((name) => [name, { counts: [1, 2] }]).concat(
        ['WriteAllTextAsync', 'WriteAllLinesAsync', 'WriteAllBytesAsync', 'AppendAllTextAsync', 'AppendAllLinesAsync'].map((name) => [name, { counts: [2, 3] }])
      )
    ),
  },
};

/** Instance BCL methods with a trailing CancellationToken overload, by receiver type. */
function instanceTokenOverload(type: string, method: string): TokenOverload | undefined {
  if (STREAM_TYPES.has(type)) {
    const streamMethods: Record<string, TokenOverload> = {
      FlushAsync: { counts: [0] },
      ReadAsync: { counts: [1, 3] },
      WriteAsync: { counts: [1, 3] },
      // CopyToAsync(Stream, CancellationToken) came with .NET Core 2.1; (Stream, int, CancellationToken) with .NET Framework 4.5.
      CopyToAsync: { counts: [1, 2], apiForCount: { count: 1, api: 'stringCharOverloads' } },
    };

    return streamMethods[method];
  }

  const table: Record<string, Record<string, TokenOverload>> = {
    SemaphoreSlim: { WaitAsync: { counts: [0, 1] } },
    HttpClient: {
      GetAsync: { counts: [1, 2] },
      PostAsync: { counts: [2] },
      PutAsync: { counts: [2] },
      DeleteAsync: { counts: [1] },
      SendAsync: { counts: [1, 2] },
      GetStringAsync: { counts: [1], api: 'net5' },
      GetByteArrayAsync: { counts: [1], api: 'net5' },
      GetStreamAsync: { counts: [1], api: 'net5' },
    },
    // ReadLineAsync(CancellationToken) returns ValueTask<string?>, ReadLineAsync() a Task<string?>.
    StreamReader: { ReadLineAsync: { counts: [0], api: 'net7', returnsValueTask: true }, ReadToEndAsync: { counts: [0], api: 'net7' } },
    TextReader: { ReadLineAsync: { counts: [0], api: 'net7', returnsValueTask: true }, ReadToEndAsync: { counts: [0], api: 'net7' } },
  };

  return table[type]?.[method];
}

const FUNCTIONS = new Set(['method_declaration', 'local_function_statement', 'lambda_expression', 'anonymous_method_expression', 'constructor_declaration', 'accessor_declaration', 'operator_declaration', 'conversion_operator_declaration']);

/** The CancellationToken parameter (the last one) of the method or local function directly containing `node`. */
function tokenParameter(node: Node): Node | undefined {
  let function_: Node | undefined;
  for (let current = node.parent; current; current = current.parent) {
    if (FUNCTIONS.has(current.type)) {
      function_ = current;
      break;
    }
  }

  if (function_?.type !== 'method_declaration' && function_?.type !== 'local_function_statement') {
    return undefined;
  }

  const parameters = function_.childForFieldName('parameters')?.namedChildren.filter((child) => child.type === 'parameter') ?? [];
  const last = parameters[parameters.length - 1];
  const type = last ? normalizeType(last.childForFieldName('type')?.text ?? '') : '';
  const tokens = parameters.filter((parameter) => /^(?:System\.Threading\.)?CancellationToken$/.test(normalizeType(parameter.childForFieldName('type')?.text ?? '')));

  return last && tokens.length === 1 && tokens[0] === last && !last.text.includes('?') && /CancellationToken$/.test(type) ? last : undefined;
}

/** Whether `invocation` is awaited right away (optionally through `.ConfigureAwait(...)`), so a ValueTask result means the same. */
function isAwaitedDirectly(invocation: Node): boolean {
  let operand = invocation;
  const access = operand.parent;
  if (access?.type === 'member_access_expression' && access.childForFieldName('expression') === operand && access.childForFieldName('name')?.text === 'ConfigureAwait' && access.parent?.type === 'invocation_expression') {
    operand = access.parent;
  }

  for (let parent = operand.parent; parent; operand = parent, parent = parent.parent) {
    if (parent.type !== 'parenthesized_expression') {
      return parent.type === 'await_expression';
    }
  }

  return false;
}

/**
 * An argument certainly not a CancellationToken: an integer (literal, `x.Length`, `x.Count`,
 * arithmetic), an encoding, a completion option, or a value of another known type.
 */
function isKnownNonToken(view: FileView, argument: Node | undefined): boolean {
  if (!argument) {
    return false;
  }

  const expression = unwrapParentheses(argument);
  const text = expression.text.replace(/\s+/g, '');
  if (
    expression.type === 'integer_literal' ||
    (expression.type === 'member_access_expression' && /^(?:Length|Count)$/.test(expression.childForFieldName('name')?.text ?? '')) ||
    (expression.type === 'binary_expression' && /^[+\-*/%]$/.test(expression.children.find((child) => !child.isNamed)?.type ?? '')) ||
    /^(?:System\.Text\.)?Encoding\.\w+$|^(?:System\.Net\.Http\.)?HttpCompletionOption\.\w+$/.test(text)
  ) {
    return true;
  }

  const type = view.types.typeOf(expression);

  return type !== undefined && !/CancellationToken$/.test(type);
}

export function applyForwardCancellationToken(source: string, context: RuleContext): string {
  if (!isRuleActive(context, 'CA2016', source) || !/\bCancellationToken\b/.test(source)) {
    return source;
  }

  const view = viewOf(source, context);
  const frameworks = targetFrameworksOf(context.project);
  for (const invocation of walk(view.model.root)) {
    const call = invocation.type === 'invocation_expression' ? callOf(invocation) : undefined;
    const parameter = call ? tokenParameter(invocation) : undefined;
    const tokenName = parameter?.childForFieldName('name');
    if (!call || !tokenName || view.suppressions.isSuppressed('CA2016', invocation)) {
      continue;
    }

    const staticEntry = Object.entries(STATIC_TOKEN_METHODS).find(([type, entry]) => isBclType(view, call.receiver, type, entry.namespace));
    const typeName = staticEntry ? undefined : declaredTypeName(view, call.receiver);
    const overload = staticEntry ? staticEntry[1].methods[call.name] : typeName ? instanceTokenOverload(typeName, call.name) : undefined;
    // With more than the fewest arguments, the last one must be known not to be a token already.
    const last = call.args[call.args.length - 1];
    const optionalArgument = call.args.length > Math.min(...(overload?.counts ?? [0]));
    if (!overload || !overload.counts.includes(call.args.length) || (optionalArgument && !isKnownNonToken(view, last))) {
      continue;
    }

    // The name must still mean the parameter where the call is.
    if (view.types.localDeclaration(tokenName.text, invocation.startIndex)?.nameNode !== tokenName) {
      continue;
    }

    const api = overload.api ?? (overload.apiForCount?.count === call.args.length ? overload.apiForCount.api : undefined);
    const support = api ? frameworksSupport(frameworks, api) : true;
    if (support === false) {
      continue;
    }

    if (support === undefined) {
      view.report('CA2016', invocation, `${invocation.text} could take ${tokenName.text}, but the project's target framework is unknown, so that overload may not exist; it was kept.`);
      continue;
    }

    if (overload.returnsValueTask && !isAwaitedDirectly(invocation)) {
      view.report('CA2016', invocation, `${invocation.text} could take ${tokenName.text}, but that overload returns a ValueTask and the Task result is not awaited directly; it was kept.`);
      continue;
    }

    const list = invocation.childForFieldName('arguments') as Node;
    view.edits.push({ start: list.endIndex - 1, end: list.endIndex - 1, text: `${call.args.length > 0 ? ', ' : ''}${tokenName.text}` });
  }

  return applyEdits(source, view.edits);
}

// ---------------------------------------------------------------------------------------------
// CA2263 Prefer generic overload when type is known
// ---------------------------------------------------------------------------------------------

/** The type of `typeof(T)`, unless it is an open generic type. */
function typeofType(node: Node | undefined): string | undefined {
  const expression = node ? unwrapParentheses(node) : undefined;
  const type = expression?.type === 'typeof_expression' ? expression.namedChildren[0] : undefined;

  return type && !/<\s*(?:,\s*)*>/.test(type.text) ? type.text : undefined;
}

/** Whether `name` is a type parameter in scope at `node` (then `Enum.Parse<T>` would lack its constraint). */
function isTypeParameter(node: Node, name: string): boolean {
  for (let current = node.parent; current; current = current.parent) {
    const list = current.namedChildren.find((child) => child.type === 'type_parameter_list');
    if (list?.namedChildren.some((parameter) => parameter.text.replace(/^(?:in|out)\s+/, '') === name)) {
      return true;
    }
  }

  return false;
}

/** Methods with a generic overload that returns a differently typed value: reported only. */
const REPORTED_GENERIC = new Set(['GetValues', 'GetNames', 'GetName', 'IsDefined', 'Parse', 'TryParse', 'GetUnderlyingType']);

export function applyGenericOverloads(source: string, context: RuleContext): string {
  if (!isRuleActive(context, 'CA2263', source) || !/\btypeof\s*\(/.test(source)) {
    return source;
  }

  const view = viewOf(source, context);
  const frameworks = targetFrameworksOf(context.project);
  for (const invocation of walk(view.model.root)) {
    const call = invocation.type === 'invocation_expression' ? callOf(invocation) : undefined;
    const type = typeofType(call?.args[0]);
    if (!call || !type || view.suppressions.isSuppressed('CA2263', invocation)) {
      continue;
    }

    if (call.name === 'SizeOf' && call.args.length === 1 && isBclType(view, call.receiver, 'Marshal', 'System.Runtime.InteropServices')) {
      const support = frameworksSupport(frameworks, 'marshalSizeOfGeneric');
      if (support === true) {
        view.edits.push({ start: invocation.startIndex, end: invocation.endIndex, text: `${call.receiver.text}.SizeOf<${type}>()` });
      } else if (support === undefined) {
        view.report('CA2263', invocation, `${invocation.text} could call SizeOf<${type}>(), but the project's target framework is unknown, so it may not exist; it was kept.`);
      }

      continue;
    }

    if (!isBclType(view, call.receiver, 'Enum', 'System') || !REPORTED_GENERIC.has(call.name) || frameworksSupport(frameworks, 'net5') === false) {
      continue;
    }

    // `(E)Enum.Parse(typeof(E), text[, ignoreCase])` returns the same value as `Enum.Parse<E>(text[, ignoreCase])`.
    const cast = invocation.parent?.type === 'cast_expression' ? invocation.parent : undefined;
    const castType = cast?.childForFieldName('type')?.text.replace(/\s+/g, '');
    const parseSupport = frameworksSupport(frameworks, 'coreApis');
    if (call.name === 'Parse' && cast && castType === type.replace(/\s+/g, '') && (call.args.length === 2 || call.args.length === 3) && !isTypeParameter(invocation, type) && parseSupport === true) {
      const rest = call.args.slice(1).map((arg) => arg.text).join(', ');
      view.edits.push({ start: cast.startIndex, end: cast.endIndex, text: `${call.receiver.text}.Parse<${type}>(${rest})` });
      continue;
    }

    view.report('CA2263', invocation, `${invocation.text} could use the generic ${call.name}<${type}> overload, but it returns a differently typed value (or may not exist for the target framework); it was kept.`);
  }

  return applyEdits(source, view.edits);
}
