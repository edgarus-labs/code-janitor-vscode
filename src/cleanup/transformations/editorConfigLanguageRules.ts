import { CODE, classifyCSharp } from '../csharpScanner';
import { isEnforced, resolveDiagnosticSeverity } from '../editorconfig';
import { Node, TextEdit, applyEdits, findAll, parseCSharp } from '../parser';
import { BCL_TYPES } from '../usings/bclIndex.generated';
import type { Rule, RuleContext } from './editorConfigCodeStyle';
import { declaredTypeText } from './editorConfigExpressionPreferences';
import { operatorOf, precedenceOf } from './editorConfigPrecedence';
import { loadProjectFacts } from './editorConfigQualityRulesProject';
import { Collect, diagnosticRule, enclosingMember, valueNames } from './editorConfigSimplificationRules';
import { describeIssue, hasModifier, hasParseErrors, isInTopLevelStatements, readCodeStyleOption } from './editorConfigSupport';
import { interpolationIdentifiers } from './interpolation';
import { isInPossibleExpressionTree } from './nullCheckPatternMatching';
import { isPlainReferenceType } from './typeFacts';

/**
 * Newer rules: IDE0001, IDE0002, IDE0058, IDE0059, IDE0064, IDE0120, IDE0121, IDE0240, IDE0260,
 * IDE0270, IDE0280, IDE0320, IDE0360, IDE0380 fix what the syntax proves safe; IDE0079,
 * IDE0210/IDE0211, IDE0220, IDE0241 and IDE0390/IDE0391 are reported only. See the README table
 * "Code-style guards checked against the C# rules" for the guards and documentation links.
 */

/** A rule gated by a code-style option set to one of `values` and the diagnostic `diagnosticId`. */
function optionRule(option: string, diagnosticId: string, values: readonly string[], collect: (source: string, root: Node, context: RuleContext, value: string, report: (node: Node, message: string) => void) => TextEdit[]): Rule {
  return {
    option,
    apply: (source, context) => {
      const value = readCodeStyleOption(context.props, option, diagnosticId);
      if (!value?.enforced || !values.includes(value.value)) {
        return source;
      }

      const tree = parseCSharp(source);
      try {
        const report = (node: Node, message: string): void => context.report(describeIssue(diagnosticId, option, source, node.startIndex, message));

        return applyEdits(source, collect(source, tree.rootNode, context, value.value, report));
      } finally {
        tree.delete();
      }
    },
  };
}

const languageVersion = (context: RuleContext): number => context.project?.languageVersion ?? 99;

function methodNames(root: Node): Set<string> {
  return new Set(findAll(root, ['method_declaration', 'local_function_statement']).map((method) => method.childForFieldName('name')?.text ?? ''));
}

function importsNamespace(root: Node, namespace: string): boolean {
  return findAll(root, 'using_directive').some((directive) => new RegExp(`^(?:global\\s+)?using\\s+${namespace.replace(/\./g, '\\.')}\\s*;$`).test(directive.text.trim()));
}

// ---------------------------------------------------------------------------------------------
// IDE0270 Null check can be simplified (`?? throw`)
// ---------------------------------------------------------------------------------------------

/** `T x = e; if (x == null) throw ...;` becomes `T x = e ?? throw ...;` for a plain reference type `T`. */
function collectCoalesceThrows(source: string, root: Node, context: RuleContext): TextEdit[] {
  if (languageVersion(context) < 7) {
    return [];
  }

  const edits: TextEdit[] = [];
  for (const block of findAll(root, 'block')) {
    const statements = block.namedChildren;
    for (let i = 0; i + 1 < statements.length; i++) {
      const declaration = statements[i].type === 'local_declaration_statement' ? statements[i].namedChildren.find((child) => child.type === 'variable_declaration') : undefined;
      const type = declaration?.childForFieldName('type');
      const declarators = declaration?.namedChildren.filter((child) => child.type === 'variable_declarator') ?? [];
      const value = declarators.length === 1 ? declarators[0].namedChildren.find((child) => child.type === 'equals_value_clause')?.namedChildren[0] : undefined;
      const name = declarators[0]?.childForFieldName('name')?.text;
      const check = statements[i + 1];
      const thrown = check.type === 'if_statement' ? throwOfNullCheck(check, name) : undefined;
      if (!type || type.type === 'implicit_type' || !value || !name || !thrown || !isPlainReferenceType(type.text, root) || /\/\/|\/\*/.test(source.slice(statements[i].startIndex, check.endIndex))) {
        continue;
      }

      const operand = precedenceOf(value) <= 2 ? `(${value.text})` : value.text;
      edits.push({ start: value.startIndex, end: value.endIndex, text: `${operand} ?? ${thrown}` });
      edits.push({ start: statements[i].endIndex, end: check.endIndex, text: '' });
    }
  }

  return edits;
}

/** For `if (x == null) throw e;` (or `x is null`, or the throw in braces), the expression `throw e`. */
function throwOfNullCheck(check: Node, name: string | undefined): string | undefined {
  const condition = check.namedChildren[0];
  const body = check.namedChildren[1];
  if (!condition || !body || check.namedChildren.length !== 2) {
    return undefined;
  }

  const testsNull =
    (condition.type === 'binary_expression' &&
      operatorOf(condition) === '==' &&
      ((condition.childForFieldName('left')?.text === name && condition.childForFieldName('right')?.type === 'null_literal') ||
        (condition.childForFieldName('right')?.text === name && condition.childForFieldName('left')?.type === 'null_literal'))) ||
    new RegExp(`^${name}\\s+is\\s+null$`).test(condition.text);
  const statement = body.type === 'block' && body.namedChildCount === 1 ? body.namedChildren[0] : body;
  const thrown = statement.type === 'throw_statement' ? statement.namedChildren[0] : undefined;

  return testsNull && thrown ? `throw ${thrown.text}` : undefined;
}

// ---------------------------------------------------------------------------------------------
// IDE0260 Use pattern matching (`as` compared with null)
// ---------------------------------------------------------------------------------------------

/**
 * `(x as T) != null` becomes `x is T` and `(x as T) == null` becomes `x is not T`, for a plain
 * reference type `T` (its `==` cannot be user-defined). `(x as T)?.Member` is reported: its
 * property pattern would need the member's type.
 */
function collectAsPatterns(_source: string, root: Node, context: RuleContext, _value: string, report: (node: Node, message: string) => void): TextEdit[] {
  if (languageVersion(context) < 9) {
    return [];
  }

  const asOperand = (node: Node | null | undefined): { subject: Node; type: Node } | undefined => {
    const inner = node?.type === 'parenthesized_expression' ? node.namedChildren[0] : undefined;
    const subject = inner?.childForFieldName('left');
    const type = inner?.childForFieldName('right');

    return inner && operatorOf(inner) === 'as' && subject?.type === 'identifier' && type ? { subject, type } : undefined;
  };

  const edits: TextEdit[] = [];
  for (const comparison of findAll(root, 'binary_expression')) {
    const operator = operatorOf(comparison);
    const left = comparison.childForFieldName('left');
    const right = comparison.childForFieldName('right');
    const cast = asOperand(left) ?? asOperand(right);
    const other = cast && asOperand(left) ? right : left;
    if ((operator !== '==' && operator !== '!=') || !cast || other?.type !== 'null_literal' || !isPlainReferenceType(cast.type.text, root) || isInPossibleExpressionTree(comparison)) {
      continue;
    }

    edits.push({ start: comparison.startIndex, end: comparison.endIndex, text: `${cast.subject.text} is ${operator === '==' ? 'not ' : ''}${cast.type.text}` });
  }

  for (const access of findAll(root, 'conditional_access_expression')) {
    if (asOperand(access.namedChildren[0])) {
      report(access, `'${access.text}' was not changed to a property pattern: the member's type, which the pattern depends on, is not known.`);
    }
  }

  return edits;
}

// ---------------------------------------------------------------------------------------------
// IDE0280 Use nameof
// ---------------------------------------------------------------------------------------------

const PARAMETER_NAME_ATTRIBUTES = /^(?:[\w.]+\.)?(?:NotNullIfNotNull|CallerArgumentExpression)(?:Attribute)?$/;

/** `[NotNullIfNotNull("p")]` and `[CallerArgumentExpression("p")]` name a parameter of their declaration: `nameof(p)` (C# 11). */
const collectParameterNameOf: Collect = (_source, root, _context, { suppressed }) =>
  findAll(root, 'attribute').flatMap((attribute): TextEdit[] => {
    const name = attribute.namedChildren[0]?.text ?? '';
    const argument = findAll(attribute, 'string_literal')[0];
    const list = attribute.parent;
    const owner = list?.parent?.type === 'parameter' ? list.parent.parent?.parent : list?.parent;
    const parameters = owner?.childForFieldName('parameters')?.namedChildren.filter((child) => child.type === 'parameter').map((parameter) => parameter.childForFieldName('name')?.text) ?? [];
    const value = argument?.text.slice(1, -1);
    if (!PARAMETER_NAME_ATTRIBUTES.test(name) || !argument || !value || !parameters.includes(value) || suppressed(attribute)) {
      return [];
    }

    return [{ start: argument.startIndex, end: argument.endIndex, text: `nameof(${value})` }];
  });

// ---------------------------------------------------------------------------------------------
// IDE0320 Make anonymous function static
// ---------------------------------------------------------------------------------------------

const TYPE_DECLARATIONS = ['class_declaration', 'struct_declaration', 'record_declaration'];

/** The innermost class, struct, record or interface declaration around `node`: the type whose members a simple name sees first. */
function enclosingType(node: Node): Node | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (TYPE_DECLARATIONS.includes(current.type) || current.type === 'interface_declaration') {
      return current;
    }
  }

  return undefined;
}

/** Interfaces of the .NET base library that base lists commonly name. */
const BCL_INTERFACES: Record<string, true> = {
  IDisposable: true, IAsyncDisposable: true, IEquatable: true, IComparable: true, IComparer: true, IEqualityComparer: true,
  IEnumerable: true, IEnumerator: true, IAsyncEnumerable: true, IAsyncEnumerator: true, ICollection: true, IList: true,
  IDictionary: true, IReadOnlyCollection: true, IReadOnlyList: true, IReadOnlyDictionary: true, ISet: true, ICloneable: true,
  IFormattable: true, ISpanFormattable: true, IParsable: true, ISpanParsable: true, IObservable: true, IObserver: true,
  IServiceProvider: true, INotifyPropertyChanged: true, INotifyPropertyChanging: true,
};

/** The simple name a base-list entry ends in: `IFoo` for `IFoo`, `IFoo<T>`, `N.IFoo` or `global::N.IFoo<T>`. */
function baseName(entry: Node): string | undefined {
  if (entry.type === 'identifier') {
    return entry.text;
  }

  if (entry.type === 'generic_name') {
    return entry.namedChildren.find((child) => child.type === 'identifier')?.text;
  }

  const name = entry.type === 'qualified_name' || entry.type === 'alias_qualified_name' ? entry.childForFieldName('name') : null;
  return name ? baseName(name) : undefined;
}

/**
 * The interfaces a base list can name: those the file declares, those the other files of a fully
 * known project declare and well-known base-library ones, except names the file also gives to a
 * class, struct, record, enum or delegate.
 */
function knownInterfaces(root: Node, context: RuleContext): Set<string> {
  const names = (kinds: string[]): string[] => findAll(root, kinds).map((type) => type.childForFieldName('name')?.text ?? '');
  const others = new Set(names([...TYPE_DECLARATIONS, 'enum_declaration', 'delegate_declaration']));
  const facts = context.project ? loadProjectFacts(context.project, context.filePath) : undefined;
  const project = facts && !facts.incomplete ? facts.others.interfaceNames : [];
  return new Set([...names(['interface_declaration']), ...project, ...Object.keys(BCL_INTERFACES)].filter((name) => name && !others.has(name)));
}

/**
 * True when simple names in `type` may bind to members it does not declare: a partial type, an
 * interface with base interfaces, or a class or record whose base list names a base class (an
 * entry not among `interfaces`). Implemented interfaces add nothing to lookup inside a class.
 */
function inheritsMembers(type: Node, interfaces: Set<string>): boolean {
  const bases = type.namedChildren.find((child) => child.type === 'base_list')?.namedChildren ?? [];
  if (hasModifier(type, 'partial')) {
    return true;
  }

  if (type.type === 'struct_declaration' || bases.length === 0) {
    return false;
  }

  return type.type === 'interface_declaration' || bases.some((entry) => !interfaces.has(baseName(entry) ?? ''));
}

/**
 * The variables a flat token run declares: `(int p, Foo q)` in a deconstruction, `case string t:`
 * in a switch statement (up to `when`). The parser keeps both as plain tokens; as no expression is
 * followed directly by a name, a designation is an identifier right after a named node (its type),
 * and a tuple literal `(a, b)` declares nothing.
 */
function designations(node: Node): string[] {
  const names: string[] = [];
  const inner = node.children.slice(1, -1);
  let inLabel = node.type !== 'switch_body';
  let depth = 0;
  inner.forEach((child, index) => {
    const previous = inner[index - 1];
    if (child.type === 'case') {
      inLabel = true;
    } else if (child.type === '(' || child.type === '{' || child.type === '[') {
      depth++;
    } else if (child.type === ')' || child.type === '}' || child.type === ']') {
      depth--;
    } else if (node.type === 'switch_body' && ((child.type === ':' && depth === 0) || (child.type === 'identifier' && child.text === 'when'))) {
      inLabel = false;
    } else if (inLabel && child.type === 'identifier' && previous && (previous.isNamed || /^[)\]}>]$/.test(previous.type)) && previous.type !== 'comment') {
      names.push(child.text);
    } else if (inLabel && child.type === 'conditional_expression' && !child.children.some((part) => part.type === ':')) {
      // `(Foo? z, ...)`: a nullable type and its designation read as a conditional without `:`.
      const last = child.namedChildren[child.namedChildCount - 1];
      if (last?.type === 'identifier') {
        names.push(last.text);
      }
    }
  });

  return names;
}

/**
 * Names declared in `scope` outside `except`: locals, parameters, local functions, pattern,
 * deconstruction and loop variables. With `except`, names declared in other anonymous and local
 * functions (except a local function's own name) are left out: they are not in scope there.
 */
function declaredNames(scope: Node, except?: Node): Set<string> {
  const names = new Set<string>();
  const outside = (node: Node): boolean => !except || node.startIndex < except.startIndex || node.startIndex >= except.endIndex;
  const otherFunctions = except
    ? findAll(scope, ['lambda_expression', 'anonymous_method_expression', 'local_function_statement']).filter((fn) => outside(fn) && !(fn.startIndex <= except.startIndex && except.endIndex <= fn.endIndex))
    : [];
  const kinds = ['variable_declarator', 'parameter', 'local_function_statement', 'declaration_expression', 'pattern', 'catch_declaration', 'from_clause', 'let_clause', 'join_clause', 'lambda_expression', 'invocation_expression', 'tuple_expression', 'switch_body'];
  for (const node of findAll(scope, kinds)) {
    // A local function's own name is declared in the enclosing scope; anything else in another function is not.
    const inOtherFunction = otherFunctions.some((fn) => fn.startIndex <= node.startIndex && node.endIndex <= fn.endIndex && !(fn === node && node.type === 'local_function_statement'));
    if (!outside(node) || inOtherFunction) {
      continue;
    }

    if (node.type === 'invocation_expression') {
      // `var (a, (b, c)) = ...` reads as a call of `var` whose arguments are all designations.
      if (node.childForFieldName('function')?.text === 'var') {
        node.childForFieldName('arguments')?.descendantsOfType('identifier').forEach((identifier) => names.add(identifier.text));
      }

      continue;
    }

    if (node.type === 'tuple_expression' || node.type === 'switch_body') {
      designations(node).forEach((name) => names.add(name));
      continue;
    }

    const name = node.childForFieldName('name');
    if (name) {
      names.add(name.text);
    }

    // A lambda declares only the identifier before its `=>` (`x => ...`); an identifier after it is the body.
    const arrow = node.type === 'lambda_expression' ? node.children.find((child) => child.type === '=>') : undefined;
    for (const child of node.namedChildren) {
      if (child.type === 'identifier' && (!arrow || child.startIndex < arrow.startIndex)) {
        names.add(child.text);
      }
    }
  }

  return names;
}

/** The instance and static members a type declares, by name. */
function membersOf(type: Node): Map<string, { isStatic: boolean }> {
  const members = new Map<string, { isStatic: boolean }>();
  const body = type.childForFieldName('body') ?? type.namedChildren.find((child) => child.type === 'declaration_list');
  for (const member of body?.namedChildren ?? []) {
    const isStatic = hasModifier(member, 'static') || hasModifier(member, 'const');
    const names =
      member.type === 'field_declaration' || member.type === 'event_field_declaration'
        ? findAll(member, 'variable_declarator').map((declarator) => declarator.childForFieldName('name')?.text ?? '')
        : [member.childForFieldName('name')?.text ?? ''];
    for (const name of names.filter(Boolean)) {
      const known = members.get(name);
      members.set(name, { isStatic: isStatic && (known?.isStatic ?? true) });
    }
  }

  return members;
}

/**
 * True when the anonymous function provably captures nothing: no `this`/`base`, no local or
 * parameter of the enclosing code, no instance member. Other names must be types or namespaces
 * (followed by `.`, or used as a type), or static members of the type; in a type that may inherit
 * or share members (base class, base interface, partial), only names declared in the function itself.
 */
function capturesNothing(lambda: Node, root: Node, interfaces: Set<string>): boolean {
  if (findAll(lambda, ['this_expression', 'base_expression']).length > 0 || /\bnameof\s*\(/.test(lambda.text) || /\b(?:this|base)\b/.test(lambda.text)) {
    return false;
  }

  const type = enclosingType(lambda);

  const member = enclosingMember(lambda) ?? root;
  const outer = declaredNames(member, lambda);
  // Primary constructor parameters are captured like locals.
  type?.childForFieldName('parameters')?.namedChildren.forEach((parameter) => outer.add(parameter.childForFieldName('name')?.text ?? ''));
  // In a `set`/`init`/`add`/`remove` accessor, `value` is the accessor's implicit parameter.
  for (let current = lambda.parent; current && current !== member; current = current.parent) {
    if (current.type === 'accessor_declaration') {
      outer.add('value');
    }
  }
  const inner = declaredNames(lambda);
  // Its own parameters hide an outer name in the whole lambda; another name it declares (a nested
  // lambda's parameter, a block's local) may not be in scope where an outer one of that name is used.
  const parameters = lambda.childForFieldName('parameters');
  const own = new Set(parameters?.type === 'identifier' ? [parameters.text] : (parameters?.namedChildren ?? []).map((parameter) => parameter.childForFieldName('name')?.text ?? ''));
  const members = type ? membersOf(type) : new Map<string, { isStatic: boolean }>();
  const hasBase = type !== undefined && inheritsMembers(type, interfaces);

  for (const identifier of findAll(lambda, 'identifier')) {
    const name = identifier.text;
    const parent = identifier.parent;
    const isMemberName = parent?.type === 'member_access_expression' && parent.childForFieldName('name') === identifier;
    const isKeyword = (isAsyncWrapper(parent) && asyncKeyword(parent!) === identifier) || (parent?.type === 'await_expression' && parent.children[0] === identifier);
    if (isMemberName || isKeyword || own.has(name) || name === 'var' || name === '_') {
      continue;
    }

    if (outer.has(name)) {
      return false;
    }

    if (inner.has(name)) {
      continue;
    }

    if (hasBase) {
      return false;
    }

    const declared = members.get(name);
    if (declared) {
      if (!declared.isStatic) {
        return false;
      }

      continue;
    }

    // A name the type does not declare: fine as a type or namespace, not as a value or a call.
    const qualifies = parent?.type === 'member_access_expression' && parent.childForFieldName('expression') === identifier;
    const asType = parent !== null && ['object_creation_expression', 'cast_expression', 'typeof_expression', 'type_argument_list', 'generic_name', 'variable_declaration', 'array_type', 'qualified_name'].includes(parent.type);
    if (!qualifies && !asType) {
      return false;
    }
  }

  // The parser reads an interpolated string as one literal: the names used in its holes are read from its text.
  for (const literal of findAll(lambda, 'interpolated_string_expression')) {
    for (const used of interpolationIdentifiers(literal.text)) {
      if (used.member || inner.has(used.name)) {
        continue;
      }

      if (outer.has(used.name) || hasBase) {
        return false;
      }

      const declared = members.get(used.name);
      if (declared ? !declared.isStatic : !used.qualifier) {
        return false;
      }
    }
  }

  return true;
}

/**
 * The parser reads `async x => ...` as a lambda holding `async` and the lambda it modifies, and
 * `static async x => ...` as the same with `static` first.
 */
const asyncKeyword = (node: Node): Node | undefined => {
  const keyword = node.children[node.children[0]?.type === 'static' ? 1 : 0];

  return keyword?.type === 'identifier' && keyword.text === 'async' ? keyword : undefined;
};
const isAsyncWrapper = (node: Node | null): boolean => node?.type === 'lambda_expression' && asyncKeyword(node) !== undefined;

function collectStaticLambdas(_source: string, root: Node, context: RuleContext): TextEdit[] {
  const interfaces = knownInterfaces(root, context);
  return findAll(root, ['lambda_expression', 'anonymous_method_expression']).flatMap((lambda): TextEdit[] => {
    // The lambda an `async` wrapper modifies is decided with (and made static through) its wrapper.
    const isStatic = lambda.children[0]?.type === 'static' || isAsyncWrapper(lambda.parent);
    if (isStatic || hasParseErrors(lambda) || isInTopLevelStatements(lambda) || isInPossibleExpressionTree(lambda) || !capturesNothing(lambda, root, interfaces)) {
      return [];
    }

    return [{ start: lambda.startIndex, end: lambda.startIndex, text: 'static ' }];
  });
}

// ---------------------------------------------------------------------------------------------
// IDE0360 Simplify property accessor
// ---------------------------------------------------------------------------------------------

/** `get { return field; }` / `get => field;` become `get;`, `set { field = value; }` / `set => field = value;` become `set;` (C# 14). */
function collectSimpleAccessors(_source: string, root: Node): TextEdit[] {
  const edits: TextEdit[] = [];
  // Whether a type has a member named `field`: in its accessors `field` may read that member. Once per type.
  const declaresField = new Map<Node, boolean>();
  for (const accessor of findAll(root, 'accessor_declaration')) {
    const keyword = accessor.children.find((child) => !child.isNamed && ['get', 'set', 'init'].includes(child.type));
    const body = keyword ? accessor.text.slice(keyword.endIndex - accessor.startIndex).replace(/\s+/g, ' ').trim() : '';
    const simple = keyword?.type === 'get' ? /^(?:\{ return field; \}|=> field;)$/.test(body) : /^(?:\{ field = value; \}|=> field = value;)$/.test(body);
    if (!keyword || !simple || hasParseErrors(accessor)) {
      continue;
    }

    const type = enclosingType(accessor);
    if (type && !declaresField.has(type)) {
      declaresField.set(type, membersOf(type).has('field'));
    }

    if (!type || !declaresField.get(type)) {
      edits.push({ start: keyword.endIndex, end: accessor.endIndex, text: ';' });
    }
  }

  return edits;
}

// ---------------------------------------------------------------------------------------------
// IDE0380 Remove unnecessary unsafe modifier
// ---------------------------------------------------------------------------------------------

/** Pointer syntax, or anything else that may need an unsafe context. */
const UNSAFE_SYNTAX = /\*|&(?!&)|->|\b(?:stackalloc|fixed|sizeof|__arglist|__makeref|__refvalue)\b/;

/** Parents whose identifiers name a type, namespace, attribute, label or argument name: never a pointer value. */
const NAME_ONLY_PARENTS: Record<string, true> = {
  attribute: true, type_parameter: true, type_parameter_constraints_clause: true, qualified_name: true, alias_qualified_name: true, base_list: true,
  type_argument_list: true, implicit_type: true, array_type: true, nullable_type: true, ref_type: true, tuple_element: true, name_colon: true,
  name_equals: true, goto_statement: true, labeled_statement: true,
};

/**
 * Whether each member name of the file is declared with a pointer or function pointer type (in
 * its type or parameters) by any of its declarations. The parser does not read pointer-typed
 * fields and properties (`int* _p;`), so every member of a type it misreads counts as a pointer.
 */
function pointerMembers(root: Node): Map<string, boolean> {
  const pointers = new Map<string, boolean>();
  for (const type of findAll(root, [...TYPE_DECLARATIONS, 'interface_declaration'])) {
    const body = type.childForFieldName('body') ?? type.namedChildren.find((child) => child.type === 'declaration_list');
    const misread = (body?.namedChildren ?? []).some((member) => member.type === 'incomplete_declaration' || hasParseErrors(member));
    for (const member of body?.namedChildren ?? []) {
      const variables = member.namedChildren.find((child) => child.type === 'variable_declaration');
      const signature = `${(member.childForFieldName('type') ?? variables?.childForFieldName('type'))?.text ?? ''} ${member.childForFieldName('parameters')?.text ?? ''}`;
      const declared = variables ? findAll(variables, 'variable_declarator').map((declarator) => declarator.childForFieldName('name')?.text) : [member.childForFieldName('name')?.text];
      // A misread `int* _p;` leaves a declaration of just `_p;`, without a declarator (or any identifier node).
      const names = misread && declared.every((name) => !name) ? member.text.match(/[A-Za-z_]\w*/g) ?? [] : declared;
      for (const name of names) {
        if (name) {
          pointers.set(name, pointers.get(name) === true || misread || UNSAFE_SYNTAX.test(signature));
        }
      }
    }
  }

  return pointers;
}

/**
 * The names `declaration` reads or calls as values: not its own locals, nor the receiver of a
 * member access (a pointer has no members), nor types, namespaces and other names that are no value.
 */
function valueReferences(declaration: Node): string[] {
  const locals = declaredNames(declaration);
  const isField = (parent: Node, field: string, node: Node): boolean => parent.childForFieldName(field)?.startIndex === node.startIndex && parent.childForFieldName(field)?.endIndex === node.endIndex;

  return findAll(declaration, 'identifier').flatMap((identifier) => {
    let top = identifier.parent?.type === 'generic_name' ? identifier.parent : identifier;
    while (top.parent?.type === 'member_access_expression' && isField(top.parent, 'name', top)) {
      top = top.parent;
    }

    const parent = top.parent;
    const nameOnly =
      !parent ||
      NAME_ONLY_PARENTS[parent.type] === true ||
      (parent.type === 'member_access_expression' && isField(parent, 'expression', top)) ||
      isField(parent, 'type', top) ||
      (/_declaration$/.test(parent.type) && isField(parent, 'name', top));

    return nameOnly || locals.has(identifier.text) || identifier.text === 'value' || identifier.text === 'nameof' ? [] : [identifier.text];
  });
}

/**
 * `unsafe` on a declaration goes when its code (strings and comments aside) holds no pointer
 * syntax and every member it reads or calls is declared in the file without pointer types: a
 * pointer passed from one call to another, or read from a field, needs the unsafe context too.
 * A member of another file may have pointer types, so its use is reported instead.
 */
const collectUnsafeModifiers: Collect = (source, root, _context, { suppressed, report }) => {
  const kinds = classifyCSharp(source);
  const codeOf = (node: Node): string => [...source.slice(node.startIndex, node.endIndex)].map((ch, i) => (kinds[node.startIndex + i] === CODE ? ch : ' ')).join('');
  const pointers = pointerMembers(root);

  return findAll(root, 'modifier').flatMap((modifier): TextEdit[] => {
    const declaration = modifier.parent;
    if (modifier.text !== 'unsafe' || !declaration || hasModifier(declaration, 'partial') || hasModifier(declaration, 'extern') || suppressed(declaration) || hasParseErrors(declaration)) {
      return [];
    }

    const code = codeOf(declaration).replace(/\bunsafe\b/g, '');
    const references = valueReferences(declaration);
    if (UNSAFE_SYNTAX.test(code) || references.some((name) => pointers.get(name) === true)) {
      return [];
    }

    const unknown = references.find((name) => !pointers.has(name));
    if (unknown !== undefined) {
      report(declaration, `'unsafe' was kept: '${unknown}' is not declared in the file, so whether it has pointer types is not known.`);

      return [];
    }

    const end = /^\s*/.exec(source.slice(modifier.endIndex))![0].length + modifier.endIndex;

    return [{ start: modifier.startIndex, end, text: '' }];
  });
};

// ---------------------------------------------------------------------------------------------
// IDE0064 Make struct fields writable
// ---------------------------------------------------------------------------------------------

/** In a (non-readonly) struct that assigns `this` outside a constructor, instance fields lose `readonly`. */
const collectWritableStructFields: Collect = (source, root, _context, { suppressed }) =>
  findAll(root, 'struct_declaration').flatMap((struct): TextEdit[] => {
    const assignsThis = findAll(struct, 'assignment_expression').some(
      (assignment) => assignment.childForFieldName('left')?.type === 'this_expression' && enclosingMember(assignment)?.type !== 'constructor_declaration'
    );
    if (hasModifier(struct, 'readonly') || !assignsThis || suppressed(struct)) {
      return [];
    }

    const body = struct.childForFieldName('body') ?? struct.namedChildren.find((child) => child.type === 'declaration_list');

    return (body?.namedChildren ?? [])
      .filter((member) => member.type === 'field_declaration' && hasModifier(member, 'readonly') && !hasModifier(member, 'static') && !hasModifier(member, 'const'))
      .map((field) => {
        const modifier = field.namedChildren.find((child) => child.type === 'modifier' && child.text === 'readonly')!;
        const end = /^\s*/.exec(source.slice(modifier.endIndex))![0].length + modifier.endIndex;

        return { start: modifier.startIndex, end, text: '' };
      });
  });

// ---------------------------------------------------------------------------------------------
// IDE0240 / IDE0241 Nullable directives
// ---------------------------------------------------------------------------------------------

type NullableState = 'enable' | 'disable' | undefined;

interface NullableDirective {
  readonly start: number;
  readonly lineEnd: number;
  readonly setting: string;
  readonly target?: string;
}

function nullableDirectives(source: string): NullableDirective[] | undefined {
  const kinds = classifyCSharp(source);
  const directives: NullableDirective[] = [];
  for (const match of source.matchAll(/^[ \t]*#[ \t]*(nullable|if)\b[ \t]*(\w*)[ \t]*(\w*)[^\r\n]*(?:\r?\n|$)/gm)) {
    if (kinds[match.index + match[0].indexOf('#')] !== CODE) {
      continue;
    }

    // Conditional compilation makes the context at each point depend on symbols.
    if (match[1] === 'if') {
      return undefined;
    }

    directives.push({ start: match.index, lineEnd: match.index + match[0].length, setting: match[2], ...(match[3] ? { target: match[3] } : {}) });
  }

  return directives;
}

/**
 * IDE0240: a `#nullable enable|disable|restore` that sets the context it is already in goes. The
 * context starts as the project's `<Nullable>` (`restore` returns to it); a directive with a target
 * (`annotations`, `warnings`) makes it unknown from there on. When the project's context is unknown
 * (a condition or an import decides it), a directive that may repeat it is reported and kept.
 */
const collectRedundantNullableDirectives: Collect = (source, _root, context, { reportAt }) => {
  const project = context.project?.nullable;
  const projectState: NullableState = project === 'enable' || project === 'disable' ? project : undefined;
  const directives = nullableDirectives(source);
  if (!directives || !context.project) {
    return [];
  }

  // 'project': the project's context, whatever it is; undefined: unknown.
  type Context = 'enable' | 'disable' | 'project' | undefined;
  const resolve = (state: Context): Context => (state === 'project' && projectState !== undefined ? projectState : state);
  const edits: TextEdit[] = [];
  let state: Context = 'project';
  for (const directive of directives) {
    const next: Context = directive.target ? undefined : directive.setting === 'restore' ? 'project' : directive.setting === 'enable' || directive.setting === 'disable' ? directive.setting : undefined;
    const [before, after] = [resolve(state), resolve(next)];
    if (!directive.target && before !== undefined && after !== undefined) {
      if (before === after) {
        edits.push({ start: directive.start, end: directive.lineEnd, text: '' });
      } else if (before === 'project' || after === 'project') {
        reportAt(directive.start, `the #nullable ${directive.setting} may repeat the project's nullable context, which is unknown (<Nullable> depends on a condition or an import, or is annotations/warnings); it was not removed.`);
      }
    }

    state = next;
  }

  return edits;
};

/** IDE0241: `#nullable disable` in front of enum declarations only, which nullability does not affect. */
const reportUnnecessaryNullableDirectives: Collect = (source, root, _context, { reportAt }) => {
  const directives = nullableDirectives(source) ?? [];
  const members = [...findAll(root, ['namespace_declaration', 'file_scoped_namespace_declaration']).flatMap((namespace) => namespace.namedChildren), ...root.namedChildren].filter(
    (node) => /_declaration$/.test(node.type) && node.type !== 'namespace_declaration' && node.type !== 'file_scoped_namespace_declaration'
  );
  directives.forEach((directive, index) => {
    const end = directives[index + 1]?.start ?? source.length;
    const covered = members.filter((member) => member.startIndex >= directive.lineEnd && member.startIndex < end);
    if (directive.setting === 'disable' && !directive.target && covered.length > 0 && covered.every((member) => member.type === 'enum_declaration')) {
      reportAt(directive.start, 'the #nullable disable only covers enums, which nullability does not affect; it was not removed, as the directive may be kept on purpose.');
    }
  });

  return [];
};

// ---------------------------------------------------------------------------------------------
// IDE0120 / IDE0121 Simplify LINQ
// ---------------------------------------------------------------------------------------------

const PREDICATE_METHODS: Record<string, true> = { Any: true, Count: true, First: true, FirstOrDefault: true, Last: true, LastOrDefault: true, Single: true, SingleOrDefault: true };

/** `x.Where(a => ...)` of a chain `x.Where(...).M(...)`: the receiver, the lambda and the call `M`. */
function whereChain(invocation: Node): { receiver: Node; lambda: Node; method: string; args: Node[] } | undefined {
  const callee = invocation.childForFieldName('function');
  const inner = callee?.type === 'member_access_expression' ? callee.childForFieldName('expression') : undefined;
  const innerCallee = inner?.type === 'invocation_expression' ? inner.childForFieldName('function') : undefined;
  const receiver = innerCallee?.type === 'member_access_expression' ? innerCallee.childForFieldName('expression') : undefined;
  const whereArgs = inner?.namedChildren.find((child) => child.type === 'argument_list')?.namedChildren ?? [];
  const lambda = whereArgs.length === 1 ? whereArgs[0].namedChildren[0] : undefined;
  const parameters = lambda?.type === 'lambda_expression' ? lambda.childForFieldName('parameters')?.text.replace(/[()\s]/g, '') : undefined;
  if (!receiver || innerCallee?.childForFieldName('name')?.text !== 'Where' || !lambda || !parameters || parameters.includes(',')) {
    return undefined;
  }

  return {
    receiver,
    lambda,
    method: (callee!.childForFieldName('name')?.text ?? '').replace(/<[\s\S]*$/, ''),
    args: invocation.namedChildren.find((child) => child.type === 'argument_list')?.namedChildren ?? [],
  };
}

function linqGuard(root: Node, names: readonly string[]): boolean {
  const declared = methodNames(root);

  return importsNamespace(root, 'System.Linq') && !names.some((name) => declared.has(name));
}

/** IDE0120: `x.Where(p).Any()` becomes `x.Any(p)` (also Count, First, Last, Single and their OrDefault forms). */
const collectWherePredicates: Collect = (_source, root, _context, { suppressed }) => {
  if (!linqGuard(root, ['Where', ...Object.keys(PREDICATE_METHODS)])) {
    return [];
  }

  return findAll(root, 'invocation_expression').flatMap((invocation): TextEdit[] => {
    const chain = whereChain(invocation);
    if (!chain || PREDICATE_METHODS[chain.method] !== true || chain.args.length > 0 || suppressed(invocation)) {
      return [];
    }

    return [{ start: invocation.startIndex, end: invocation.endIndex, text: `${chain.receiver.text}.${chain.method}(${chain.lambda.text})` }];
  });
};

/** IDE0121: `x.Where(a => a is T).Cast<T>()` and `.Select(a => (T)a)` become `x.OfType<T>()`. */
const collectOfType: Collect = (_source, root, _context, { suppressed }) => {
  if (!linqGuard(root, ['Where', 'Cast', 'Select', 'OfType'])) {
    return [];
  }

  return findAll(root, 'invocation_expression').flatMap((invocation): TextEdit[] => {
    const chain = whereChain(invocation);
    const test = chain && /^\(?\s*(\w+)\s*\)?\s*=>\s*(\w+)\s+is\s+([\w.]+(?:<[\w.,\s]+>)?(?:\[\])*)$/.exec(chain.lambda.text);
    if (!chain || !test || test[1] !== test[2] || suppressed(invocation)) {
      return [];
    }

    const type = test[3];
    const callee = invocation.childForFieldName('function');
    const castType = /\.Cast<([^>]+(?:<[^>]*>)?)>$/.exec(callee?.text ?? '')?.[1];
    const select = chain.method === 'Select' && chain.args.length === 1 ? /^\(?\s*(\w+)\s*\)?\s*=>\s*\(([^()]+)\)\s*(\w+)$/.exec(chain.args[0].text) : undefined;
    const matches = (chain.method === 'Cast' && castType?.replace(/\s+/g, '') === type.replace(/\s+/g, '') && chain.args.length === 0) || (select && select[1] === select[3] && select[2].replace(/\s+/g, '') === type.replace(/\s+/g, ''));
    if (!matches) {
      return [];
    }

    return [{ start: invocation.startIndex, end: invocation.endIndex, text: `${chain.receiver.text}.OfType<${type}>()` }];
  });
};

// ---------------------------------------------------------------------------------------------
// IDE0002 / IDE0001 Simplify member access and names
// ---------------------------------------------------------------------------------------------

/** IDE0002: inside type `C`, `C.Member` becomes `Member` for a static member of `C` no local hides. */
const collectTypeQualifiedMembers: Collect = (_source, root, _context, { suppressed }) => {
  const edits: TextEdit[] = [];
  // Names a member declares, worked out once per member: a type can hold thousands of accesses.
  const scopeNames = new Map<Node, Set<string>>();
  for (const type of findAll(root, TYPE_DECLARATIONS)) {
    const name = type.childForFieldName('name')?.text;
    if (!name || type.namedChildren.some((child) => child.type === 'type_parameter_list')) {
      continue;
    }

    const members = membersOf(type);
    for (const access of findAll(type, 'member_access_expression')) {
      const qualifier = access.childForFieldName('expression');
      const member = access.childForFieldName('name');
      if (qualifier?.type !== 'identifier' || qualifier.text !== name || !member || members.get(member.text)?.isStatic !== true) {
        continue;
      }

      const innermost = enclosingType(access) ?? type;
      const scope = enclosingMember(access) ?? type;
      let declared = scopeNames.get(scope);
      if (!declared) {
        declared = declaredNames(scope);
        scopeNames.set(scope, declared);
      }

      if ((innermost !== type && innermost.startIndex !== type.startIndex) || declared.has(member.text) || declared.has(name) || suppressed(access)) {
        continue;
      }

      edits.push({ start: access.startIndex, end: access.endIndex, text: member.text });
    }
  }

  return edits;
};

/** Type names that exist in several .NET namespaces a file commonly imports together. */
const AMBIGUOUS_BCL_NAMES: Record<string, true> = {
  Timer: true, Formatter: true, Encoder: true, Decoder: true, Group: true, Match: true, Capture: true, Point: true, Size: true,
  Rectangle: true, Color: true, Brush: true, Brushes: true, Pen: true, Font: true, Image: true, Icon: true, Control: true,
  Button: true, Label: true, TextBox: true, Panel: true, Window: true, Application: true, Clipboard: true, Cursor: true,
  Cursors: true, Binding: true, Style: true, Path: true, Vector: true, Matrix: true, Region: true, Range: true, Index: true,
  Thread: true, ThreadState: true, Monitor: true, Formatting: true, Expression: true, Attribute: true, Parser: true,
};

/**
 * IDE0001: in type positions, `N.T` becomes `T` when the file imports `N`, every namespace it
 * imports is a .NET one in the reference-assembly index ({@link BCL_TYPES}), `N` is the only
 * imported namespace declaring a type named `T` (nor is it one of the names above, which other
 * .NET versions declare in several namespaces), and no type, member, local or parameter named `T`
 * is declared in the file or the project.
 */
const collectQualifiedNames: Collect = (_source, root, context, { suppressed }) => {
  const project = context.project;
  if (!project) {
    return [];
  }

  const facts = loadProjectFacts(project, context.filePath);
  const usings = findAll(root, 'using_directive').map((directive) => /^(?:global\s+)?using\s+([\w.]+)\s*;$/.exec(directive.text.trim())?.[1]);
  const imported = [...usings, ...facts.others.globalUsings];
  if (facts.incomplete || imported.some((namespace) => namespace === undefined || BCL_TYPES[namespace] === undefined)) {
    return [];
  }

  const typesOf = new Map((imported as string[]).map((namespace) => [namespace, new Set(BCL_TYPES[namespace].split(' '))]));
  const values = valueNames(root);
  const localTypes = new Set(findAll(root, [...TYPE_DECLARATIONS, 'interface_declaration', 'enum_declaration', 'delegate_declaration']).map((type) => type.childForFieldName('name')?.text ?? ''));
  const members = new Set(findAll(root, TYPE_DECLARATIONS).flatMap((type) => [...membersOf(type).keys()]));

  return findAll(root, 'qualified_name').flatMap((name): TextEdit[] => {
    const qualifier = name.childForFieldName('qualifier');
    const simple = name.childForFieldName('name');
    const simpleName = simple?.type === 'generic_name' ? simple.namedChildren[0]?.text : simple?.text;
    if (
      name.parent?.type === 'qualified_name' ||
      name.parent?.type === 'using_directive' ||
      name.parent?.type === 'namespace_declaration' ||
      name.parent?.type === 'file_scoped_namespace_declaration' ||
      !qualifier ||
      !simple ||
      !simpleName ||
      // The qualifier must be the only imported namespace declaring the name.
      [...typesOf].filter(([, types]) => types.has(simpleName)).map(([namespace]) => namespace).join() !== qualifier.text.replace(/\s+/g, '').replace(/^global::/, '') ||
      AMBIGUOUS_BCL_NAMES[simpleName] === true ||
      localTypes.has(simpleName) ||
      facts.others.typeNames.has(simpleName) ||
      values.has(simpleName) ||
      members.has(simpleName) ||
      suppressed(name)
    ) {
      return [];
    }

    return [{ start: name.startIndex, end: name.endIndex, text: simple.text }];
  });
};

// ---------------------------------------------------------------------------------------------
// IDE0058 / IDE0059 Unused values
// ---------------------------------------------------------------------------------------------

const EXPRESSION_STATEMENT_OPTION = 'csharp_style_unused_value_expression_statement_preference';
const ASSIGNMENT_OPTION = 'csharp_style_unused_value_assignment_preference';
const AWAITABLE = /^(?:System\.Threading\.Tasks\.)?(?:Task|ValueTask)(?:<.+>)?$/;

/**
 * IDE0058: a call to a method of the calling type that returns a value, as a statement, becomes
 * `_ = Call();` (`discard_variable`). Only methods declared once in a type whose members are all
 * in view (no base class or base interface, not partial); the value of any other call is unknown.
 */
function collectDiscardedValues(_source: string, root: Node, context: RuleContext, value: string, report: (node: Node, message: string) => void): TextEdit[] {
  if (languageVersion(context) < 7) {
    return [];
  }

  // The methods of each type a call can bind to without seeing members declared elsewhere.
  const methodsOf = new Map<Node, Node[]>();
  let interfaces: Set<string> | undefined;
  const edits: TextEdit[] = [];
  for (const statement of findAll(root, 'expression_statement')) {
    const call = statement.namedChildren[0];
    const callee = call?.type === 'invocation_expression' ? call.childForFieldName('function') : undefined;
    const name = callee?.type === 'identifier' ? callee.text : callee?.type === 'member_access_expression' && callee.childForFieldName('expression')?.type === 'this_expression' ? callee.childForFieldName('name')?.text : undefined;
    const type = name ? enclosingType(statement) : undefined;
    if (!call || !name || !type) {
      continue;
    }

    let methods = methodsOf.get(type);
    if (!methods) {
      const hidden = inheritsMembers(type, (interfaces ??= knownInterfaces(root, context)));
      const body = type.childForFieldName('body') ?? type.namedChildren.find((child) => child.type === 'declaration_list');
      methods = hidden ? [] : (body?.namedChildren ?? []).filter((member) => member.type === 'method_declaration');
      methodsOf.set(type, methods);
    }

    const declared = methods.filter((method) => method.childForFieldName('name')?.text === name);
    const returns = declared.length === 1 ? declared[0].childForFieldName('type')?.text.replace(/\s+/g, '') : undefined;
    const inScope = declaredNames(enclosingMember(statement) ?? root);
    if (!returns || returns === 'void' || returns === 'dynamic' || AWAITABLE.test(returns) || inScope.has(name)) {
      continue;
    }

    // A parameter, local, member or primary constructor parameter named `_` turns `_ = Call();` into an assignment to it.
    const primaryParameters = type.childForFieldName('parameters')?.namedChildren ?? [];
    if (inScope.has('_') || membersOf(type).has('_') || primaryParameters.some((parameter) => parameter.childForFieldName('name')?.text === '_')) {
      continue;
    }

    if (value === 'discard_variable') {
      edits.push({ start: call.startIndex, end: call.startIndex, text: '_ = ' });
    } else {
      report(statement, `the value of '${call.text}' is unused; no variable was introduced for it, as a name would have to be chosen.`);
    }
  }

  return edits;
}

const INITIAL_LITERALS: Record<string, true> = { integer_literal: true, real_literal: true, string_literal: true, character_literal: true, boolean_literal: true, null_literal: true, default_expression: true };

/**
 * IDE0059: `T x = literal;` overwritten by the next statement (`x = ...;` not reading `x`) loses
 * its initializer. With any other initializer (which may have side effects) it is reported.
 */
function collectOverwrittenInitializers(source: string, root: Node, _context: RuleContext, _value: string, report: (node: Node, message: string) => void): TextEdit[] {
  const edits: TextEdit[] = [];
  for (const block of findAll(root, 'block')) {
    const statements = block.namedChildren;
    for (let i = 0; i + 1 < statements.length; i++) {
      const declaration = statements[i].type === 'local_declaration_statement' ? statements[i].namedChildren.find((child) => child.type === 'variable_declaration') : undefined;
      const declarators = declaration?.namedChildren.filter((child) => child.type === 'variable_declarator') ?? [];
      const clause = declarators.length === 1 ? declarators[0].namedChildren.find((child) => child.type === 'equals_value_clause') : undefined;
      const initial = clause?.namedChildren[0];
      const name = declarators[0]?.childForFieldName('name')?.text;
      const assignment = statements[i + 1].type === 'expression_statement' ? statements[i + 1].namedChildren[0] : undefined;
      const overwrites =
        assignment?.type === 'assignment_expression' &&
        assignment.children.some((child) => child.type === '=') &&
        assignment.childForFieldName('left')?.text === name &&
        !findAll(assignment.childForFieldName('right') ?? assignment, 'identifier').some((identifier) => identifier.text === name);
      const modifiers = statements[i].namedChildren.some((child) => child.type === 'modifier');
      // A local function or lambda of the member may read the variable before the assignment
      // (`x = Next();` with `int Next() => x + 1;`): without the initializer, it is unassigned there.
      const readByFunction = () =>
        findAll(enclosingMember(block) ?? root, ['local_function_statement', 'lambda_expression', 'anonymous_method_expression']).some((fn) =>
          findAll(fn, 'identifier').some((identifier) => identifier.text === name)
        );
      if (!declaration || !clause || !initial || !name || !overwrites || modifiers || declaration.childForFieldName('type')?.type === 'implicit_type' || readByFunction()) {
        continue;
      }

      if (INITIAL_LITERALS[initial.type] === true) {
        edits.push({ start: declarators[0].childForFieldName('name')!.endIndex, end: clause.endIndex, text: '' });
      } else {
        report(statements[i], `the value assigned to '${name}' is never read; it was kept, as '${source.slice(initial.startIndex, initial.endIndex)}' may have side effects.`);
      }
    }
  }

  return edits;
}

// ---------------------------------------------------------------------------------------------
// Reported only: IDE0079, IDE0390/IDE0391, IDE0210/IDE0211, IDE0220
// ---------------------------------------------------------------------------------------------

/**
 * IDE0079: `#pragma warning disable` of an IDE/CA rule the configuration sets to `none` or
 * `silent`, so it reports nothing to suppress (`dotnet_remove_unnecessary_suppression_exclusions`
 * lists rules to leave alone).
 */
const reportUnnecessarySuppressions: Collect = (source, _root, context, { reportAt }) => {
  const exclusions = (context.props.get('dotnet_remove_unnecessary_suppression_exclusions') ?? '').toLowerCase();
  const kinds = classifyCSharp(source);
  for (const match of source.matchAll(/^[ \t]*#[ \t]*pragma[ \t]+warning[ \t]+disable[ \t]+([^\r\n/]+)/gm)) {
    if (kinds[match.index + match[0].indexOf('#')] !== CODE) {
      continue;
    }

    for (const id of match[1].split(',').map((part) => part.trim().toUpperCase())) {
      const severity = /^(?:IDE|CA)\d{4}$/.test(id) ? resolveDiagnosticSeverity(context.props, id) : undefined;
      if (severity !== undefined && !isEnforced(severity) && !exclusions.includes(id.toLowerCase()) && exclusions.trim() !== 'all') {
        reportAt(match.index, `the suppression of ${id} may be unnecessary: the configuration sets it to ${severity}. It was not removed, as other analyzer configuration may still report it.`);
      }
    }
  }

  return [];
};

/** IDE0390 / IDE0391: `async` methods without `await` (IDE0391 for overrides and explicit interface implementations). */
function asyncWithoutAwait(diagnosticId: 'IDE0390' | 'IDE0391'): Collect {
  return (source, root, _context, { report }) => {
    const kinds = classifyCSharp(source);
    for (const method of findAll(root, ['method_declaration', 'local_function_statement'])) {
      const body = method.childForFieldName('body') ?? method.namedChildren.find((child) => child.type === 'block' || child.type === 'arrow_expression_clause');
      const code = body ? [...source.slice(body.startIndex, body.endIndex)].map((ch, i) => (kinds[body.startIndex + i] === CODE ? ch : ' ')).join('') : '';
      const inherited = hasModifier(method, 'override') || method.namedChildren.some((child) => child.type === 'explicit_interface_specifier');
      if (!hasModifier(method, 'async') || !body || /\bawait\b/.test(code) || (diagnosticId === 'IDE0391') !== inherited) {
        continue;
      }

      report(method, `'${method.childForFieldName('name')?.text}' is async but never awaits; it was not made synchronous, as its return type and callers would change.`);
    }

    return [];
  };
}

/** IDE0210 (`true`): a `Main` that top-level statements could replace. IDE0211 (`false`): top-level statements. */
function collectTopLevelStatements(_source: string, root: Node, _context: RuleContext, value: string, report: (node: Node, message: string) => void): TextEdit[] {
  if (value === 'false') {
    const statement = root.namedChildren.find((child) => child.type === 'global_statement' || /_statement$/.test(child.type));
    if (statement) {
      report(statement, 'the top-level statements were not moved into a Program.Main method: the generated class and method would need names and modifiers.');
    }

    return [];
  }

  for (const type of root.namedChildren.flatMap((child) => (child.type === 'class_declaration' ? [child] : child.type.endsWith('namespace_declaration') ? findAll(child, 'class_declaration') : []))) {
    const nested = type.parent?.type === 'declaration_list' && type.parent.parent?.type === 'class_declaration';
    if (nested || hasModifier(type, 'public') || type.namedChildren.some((child) => child.type === 'base_list' || child.type === 'attribute_list')) {
      continue;
    }

    const main = findAll(type, 'method_declaration').find((method) => method.childForFieldName('name')?.text === 'Main' && hasModifier(method, 'static') && method.childForFieldName('body'));
    if (main) {
      report(main, "'Main' was not converted to top-level statements: the rest of the file would have to move.");
    }
  }

  return [];
}

const LEGACY_COLLECTIONS = /^(?:System\.Collections\.)?(?:ArrayList|IEnumerable|ICollection|IList|Hashtable|Queue|Stack)$/;

/** IDE0220: `foreach (T x in items)` over elements declared `object`, where the compiler casts each element. */
function collectForeachCasts(_source: string, root: Node, _context: RuleContext, value: string, report: (node: Node, message: string) => void): TextEdit[] {
  for (const loop of findAll(root, 'for_each_statement')) {
    const variable = loop.namedChildren[0];
    const type = variable?.type === 'variable_declaration' ? variable.childForFieldName('type') : undefined;
    const collection = loop.namedChildren[1]?.type === 'identifier' ? loop.namedChildren[1] : undefined;
    const declared = collection ? declaredTypeText(collection) : undefined;
    const element = declared ? /^(?:[\w.]+)<(.+)>$/.exec(declared)?.[1] ?? /^(.+)\[\]$/.exec(declared)?.[1] : undefined;
    const legacy = declared !== undefined && LEGACY_COLLECTIONS.test(declared);
    if (!type || type.type === 'implicit_type' || type.text === 'var' || (!element && !(legacy && value === 'always'))) {
      continue;
    }

    const from = element ?? 'object';
    if ((from === 'object' || from === 'Object') && type.text !== 'object') {
      report(loop, `the elements of '${collection!.text}' are cast from ${from} to ${type.text} without a visible cast; none was added, as the collection's cast method depends on its type.`);
    }
  }

  return [];
}

export const LANGUAGE_RULES: readonly Rule[] = [
  optionRule('dotnet_style_coalesce_expression', 'IDE0270', ['true'], collectCoalesceThrows),
  optionRule('csharp_style_pattern_matching_over_as_with_null_check', 'IDE0260', ['true'], collectAsPatterns),
  diagnosticRule('IDE0280', collectParameterNameOf),
  optionRule('csharp_prefer_static_anonymous_function', 'IDE0320', ['true'], collectStaticLambdas),
  optionRule('csharp_style_prefer_simple_property_accessors', 'IDE0360', ['true'], collectSimpleAccessors),
  diagnosticRule('IDE0380', collectUnsafeModifiers),
  diagnosticRule('IDE0064', collectWritableStructFields),
  diagnosticRule('IDE0240', collectRedundantNullableDirectives),
  diagnosticRule('IDE0120', collectWherePredicates),
  diagnosticRule('IDE0121', collectOfType),
  diagnosticRule('IDE0002', collectTypeQualifiedMembers),
  diagnosticRule('IDE0001', collectQualifiedNames),
  optionRule(EXPRESSION_STATEMENT_OPTION, 'IDE0058', ['discard_variable', 'unused_local_variable'], collectDiscardedValues),
  optionRule(ASSIGNMENT_OPTION, 'IDE0059', ['discard_variable', 'unused_local_variable'], collectOverwrittenInitializers),
  diagnosticRule('IDE0241', reportUnnecessaryNullableDirectives),
  diagnosticRule('IDE0079', reportUnnecessarySuppressions),
  diagnosticRule('IDE0390', asyncWithoutAwait('IDE0390')),
  diagnosticRule('IDE0391', asyncWithoutAwait('IDE0391')),
  optionRule('csharp_style_prefer_top_level_statements', 'IDE0210', ['true'], collectTopLevelStatements),
  optionRule('csharp_style_prefer_top_level_statements', 'IDE0211', ['false'], collectTopLevelStatements),
  optionRule('dotnet_style_prefer_foreach_explicit_cast_in_source', 'IDE0220', ['always', 'when_strongly_typed'], collectForeachCasts),
];

