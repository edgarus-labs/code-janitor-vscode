import { SourceModel, buildSourceModel, typeAt } from '../naming/sourceModel';
import { Node, TextEdit, applyEdits, parseCSharp, walk } from '../parser';
import type { RuleContext } from './editorConfigCodeStyle';
import { hasModifier, hasParseErrors } from './editorConfigSupport';
import { loadProjectFacts, suppressionsOf, targetFrameworksOf } from './editorConfigQualityRulesProject';
import {
  DeclaredTypes,
  Suppressions,
  attributesOf,
  charLiteral,
  containingTypeDeclaration,
  describeDiagnostic,
  enclosingNames,
  frameworksSupport,
  isGenericType,
  isInsideAttribute,
  isInsideLambda,
  isRecordStruct,
  isRuleActive,
  normalizeType,
  parentSkippingParentheses,
  removeDeclarationEdit,
  resultantVisibility,
  simpleTypeName,
  singleCharacterOf,
  unwrapParentheses,
} from './editorConfigQualityRulesSupport';

/**
 * Expression-level code-quality rules (CA1805, CA1825, CA1827-CA1829, CA1860, CA1507, CA1834,
 * CA1847, CA1865-CA1867, CA2249) and IDE0004/IDE0005. A rewrite needs the receiver's type (or the
 * target framework) to be certain from the file; a violation found without that proof is reported.
 */

/** A parsed file with the lookups the rules share. */
export interface FileView {
  readonly source: string;
  readonly model: SourceModel;
  readonly types: DeclaredTypes;
  readonly suppressions: Suppressions;
  readonly edits: TextEdit[];
  report(diagnosticId: string, node: Node, message: string): void;
}

export function viewOf(source: string, context: RuleContext): FileView {
  const model = buildSourceModel(source);
  const project = context.project ? loadProjectFacts(context.project, context.filePath) : undefined;

  return {
    source,
    model,
    types: new DeclaredTypes(model, project?.others.typeNames),
    suppressions: suppressionsOf(source, context),
    edits: [],
    report: (diagnosticId, node, message) => context.report(describeDiagnostic(diagnosticId, source, node.startIndex, message)),
  };
}

/** The node's argument expressions, or `undefined` when one is named, passed by reference or has no expression. */
export function positionalArguments(call: Node): Node[] | undefined {
  const list = call.childForFieldName('arguments');
  const argumentNodes = list?.namedChildren.filter((child) => child.type === 'argument') ?? [];
  if (!list || argumentNodes.some((argument) => argument.childForFieldName('name') || /^(?:ref|out|in)\b/.test(argument.text) || argument.namedChildren.length === 0)) {
    return undefined;
  }

  return argumentNodes.map((argument) => argument.namedChildren[argument.namedChildren.length - 1]);
}

/** Imports of a namespace in the file (`using System;`), or by every file of the project. */
export function importsNamespace(view: FileView, context: RuleContext, name: string): boolean {
  const imported = view.model.root.descendantsOfType('using_directive').some((directive) => {
    const text = directive.text.replace(/\s+/g, ' ').replace(/;$/, '').trim();

    return text === `using ${name}` || text === `global using ${name}`;
  });
  if (imported) {
    return true;
  }

  const project = context.project ? loadProjectFacts(context.project, context.filePath) : undefined;

  return name === 'System' ? project?.importsSystem === true : project?.others.globalUsings.has(name) === true;
}

/**
 * True when a simple name at `at` may bind to something the file or project declares rather than
 * to the namespace or imported type of that name: a type, member, local, parameter or namespace of
 * the file, a type of the project, a namespace of the project nested in a namespace around `at`
 * (`Acme.System` inside `Acme` or `Acme.Models`), or a using alias.
 */
function mayBeHidden(view: FileView, context: RuleContext, name: string, at: Node): boolean {
  if (view.types.declaresType(name) || view.model.symbolsByName.has(name)) {
    return true;
  }

  const alias = new RegExp(`^(?:global\\s+)?using\\s+@?${name}\\s*=`);
  if (view.model.root.descendantsOfType('using_directive').some((directive) => alias.test(directive.text))) {
    return true;
  }

  const project = context.project ? loadProjectFacts(context.project, context.filePath) : undefined;
  if (!project) {
    return false;
  }

  // Namespace lookup sees the members of each namespace around `at`, innermost first.
  const around = enclosingNames(at).namespaces;
  const nested = around.some((_, index) => project.others.nestedNamespaces.has([...around.slice(0, index + 1), name].join('.')));

  return nested || project.others.globalUsingAliases.has(name);
}

/** True when a simple name at `at` certainly binds to a type of an imported namespace: nothing of the file, project or a base type declares it. */
function namesImportedType(view: FileView, context: RuleContext, name: string, at: Node): boolean {
  if (mayBeHidden(view, context, name, at)) {
    return false;
  }

  // Member lookup comes before namespace lookup and also sees inherited members and other partial parts.
  for (let type = typeAt(view.model, at.startIndex); type; type = type.parent) {
    if (type.hasBaseList || type.isPartial) {
      return false;
    }
  }

  return true;
}

/**
 * How to write the `System` type `name` (`Array`, `StringComparison`) at `at`: unqualified where the
 * file imports `System` and no member, local, parameter, type, namespace or alias of that name can
 * bind instead, else `System.`-qualified; `undefined` when the file or project declares something
 * named `System` too (the `global::` alias the fix would need is outside what the cleanup can verify).
 */
export function systemTypeReference(view: FileView, context: RuleContext, name: string, at: Node): string | undefined {
  if (importsNamespace(view, context, 'System') && namesImportedType(view, context, name, at)) {
    return name;
  }

  // An inherited member named `System` is too unlikely to give up the fix for; a declared one is not.
  return mayBeHidden(view, context, 'System', at) ? undefined : `System.${name}`;
}

export const STRING_TYPES: Record<string, true> = { string: true, String: true, 'System.String': true };

export function isString(view: FileView, expression: Node): boolean {
  const type = view.types.typeOf(expression);

  return type !== undefined && STRING_TYPES[type] === true && (type === 'string' || !view.types.declaresType('String'));
}

// ---------------------------------------------------------------------------------------------
// CA1805 Do not initialize unnecessarily
// ---------------------------------------------------------------------------------------------

const NUMERIC_TYPES: Record<string, true> = {
  byte: true, sbyte: true, short: true, ushort: true, int: true, uint: true, long: true, ulong: true, float: true, double: true,
};

type DefaultVerdict = 'default' | 'other' | { readonly unknownType: string };

export function applyDefaultInitializers(source: string, context: RuleContext): string {
  if (!isRuleActive(context, 'CA1805', source) || !/=\s*(?:0|false|null|default|'\\0'|new\s)/.test(source)) {
    return source;
  }

  const view = viewOf(source, context);
  const valueTypes = new Map(view.model.types.map((type) => [type.name, type.kind]));
  for (const declaration of walk(view.model.root)) {
    if (declaration.type !== 'field_declaration' && declaration.type !== 'property_declaration') {
      continue;
    }

    const type = containingTypeDeclaration(declaration);
    const structInstance = !hasModifier(declaration, 'static') && (type?.type === 'struct_declaration' || (type !== undefined && isRecordStruct(type)));
    if (!type || structInstance || hasModifier(declaration, 'const') || attributesOf(declaration).length > 0 || hasParseErrors(declaration)) {
      continue;
    }

    if (declaration.type === 'property_declaration') {
      const accessors = declaration.childForFieldName('accessors');
      const value = declaration.childForFieldName('value');
      const typeNode = declaration.childForFieldName('type');
      const name = declaration.childForFieldName('name')?.text ?? '';
      if (!accessors || !value || !typeNode || value.type === 'arrow_expression_clause') {
        continue;
      }

      const verdict = defaultVerdict(typeNode, value, valueTypes);
      if (verdict !== 'other' && !view.suppressions.isSuppressed('CA1805', declaration)) {
        if (verdict === 'default') {
          view.edits.push({ start: accessors.endIndex, end: declaration.endIndex, text: '' });
        } else {
          view.report('CA1805', declaration, unknownTypeMessage(name, value, verdict.unknownType));
        }
      }

      continue;
    }

    const variable = declaration.namedChildren.find((child) => child.type === 'variable_declaration');
    const typeNode = variable?.childForFieldName('type');
    for (const declarator of variable?.namedChildren.filter((child) => child.type === 'variable_declarator') ?? []) {
      const nameNode = declarator.childForFieldName('name');
      const clause = declarator.namedChildren.find((child) => child.type === 'equals_value_clause');
      const value = clause?.namedChildren[0];
      if (!typeNode || !nameNode || !clause || !value || !/^\s*$/.test(source.slice(nameNode.endIndex, clause.startIndex))) {
        continue;
      }

      const verdict = defaultVerdict(typeNode, value, valueTypes);
      if (verdict === 'other' || view.suppressions.isSuppressed('CA1805', declaration)) {
        continue;
      }

      const name = nameNode.text;
      if (verdict !== 'default') {
        view.report('CA1805', declaration, unknownTypeMessage(name, value, verdict.unknownType));
      } else if (hasModifier(type, 'partial')) {
        view.report('CA1805', declaration, `'${name}' is explicitly initialized to its default value, but ${type.childForFieldName('name')?.text} is partial and its other parts may never assign it (CS0649); the initializer was kept.`);
      } else if (resultantVisibility(declaration) !== 'public' && !isAssignedIn(view, type, name)) {
        view.report('CA1805', declaration, `'${name}' is explicitly initialized to its default value, but nothing else assigns it, so removing the initializer would raise CS0649; the initializer was kept.`);
      } else {
        view.edits.push({ start: nameNode.endIndex, end: clause.endIndex, text: '' });
      }
    }
  }

  return applyEdits(source, view.edits);
}

function unknownTypeMessage(name: string, value: Node, type: string): string {
  return `'${name}' is initialized with ${value.text}, which is its default value only if '${type}' is an enum or numeric type, and that cannot be resolved syntactically; the initializer was kept.`;
}

/** Whether `value` is the default value of `typeNode` (Roslyn's `UsesKnownDefaultValue`), as far as the syntax tells. */
function defaultVerdict(typeNode: Node, value: Node, declaredKinds: ReadonlyMap<string, string>): DefaultVerdict {
  const typeText = typeNode.text.replace(/\s+/g, '');
  const nullable = typeText.endsWith('?');
  switch (value.type) {
    case 'default_expression': {
      const explicit = /^default\s*\(([\s\S]*)\)$/.exec(value.text)?.[1];

      return explicit === undefined || explicit.replace(/\s+/g, '') === typeText ? 'default' : 'other';
    }
    case 'null_literal': {
      if (nullable || typeNode.type === 'array_type' || /^(?:string|object|dynamic)$/.test(typeText)) {
        return 'default';
      }

      const kind = declaredKinds.get(simpleTypeName(typeText));

      return typeNode.type !== 'predefined_type' && kind !== 'struct' && kind !== 'enum' ? 'default' : 'other';
    }
  }

  if (nullable) {
    return 'other';
  }

  if (typeNode.type === 'predefined_type') {
    if (typeText === 'bool') {
      return value.type === 'boolean_literal' && value.text === 'false' ? 'default' : 'other';
    }

    if (typeText === 'char') {
      return value.type === 'character_literal' && /^'\\(?:0|u0000|x0{1,4})'$/.test(value.text) ? 'default' : 'other';
    }

    if (NUMERIC_TYPES[typeText] === true) {
      const zero = (value.type === 'integer_literal' || value.type === 'real_literal') && isZeroLiteral(value.text);
      const constructed = value.type === 'object_creation_expression' && /^new\s*[a-z]+\s*\(\s*\)$/.test(value.text) && value.childForFieldName('type')?.text === typeText;

      return zero || constructed ? 'default' : 'other';
    }

    return 'other';
  }

  if (value.type === 'integer_literal' && isZeroLiteral(value.text)) {
    const kind = declaredKinds.get(simpleTypeName(typeText));
    if (kind === 'enum') {
      return 'default';
    }

    return kind === undefined ? { unknownType: typeText } : 'other';
  }

  return 'other';
}

function isZeroLiteral(text: string): boolean {
  const digits = text.replace(/_/g, '').toLowerCase();
  if (/^0[xb]/.test(digits)) {
    return /^0[xb]0+(?:u|l|ul|lu)?$/.test(digits);
  }

  return /^(?:\d*\.?\d*)(?:e[+-]?\d+)?(?:u|l|ul|lu|f|d|m)?$/.test(digits) && /\d/.test(digits) && Number(digits.replace(/[uldfm]+$/, '')) === 0;
}

/** True when a member of `type` named `name` is written somewhere besides its initializer. */
function isAssignedIn(view: FileView, type: Node, name: string): boolean {
  return (view.model.occurrencesByName.get(name) ?? []).some((occurrence) => {
    let target = occurrence.node;
    if (!target || occurrence.start < type.startIndex || occurrence.end > type.endIndex) {
      return false;
    }

    if (target.parent?.type === 'member_access_expression' && target.parent.childForFieldName('name') === target) {
      target = target.parent;
    }

    const parent = target.parent;
    switch (parent?.type) {
      case 'assignment_expression':
        return parent.childForFieldName('left') === target;
      case 'prefix_unary_expression':
      case 'postfix_unary_expression':
        return /^(?:\+\+|--)|(?:\+\+|--)$/.test(parent.text);
      case 'argument':
        return /^(?:ref|out)\b/.test(parent.text);
      default:
        return false;
    }
  });
}

// ---------------------------------------------------------------------------------------------
// CA1825 Avoid zero-length array allocations
// ---------------------------------------------------------------------------------------------

export function applyArrayEmpty(source: string, context: RuleContext): string {
  if (!isRuleActive(context, 'CA1825', source) || !/\[\s*(?:0[xXbB]?0*)?\s*\]/.test(source)) {
    return source;
  }

  const view = viewOf(source, context);
  const support = frameworksSupport(targetFrameworksOf(context.project), 'arrayEmpty');
  for (const creation of walk(view.model.root)) {
    if (creation.type !== 'array_creation_expression' || !isZeroLengthArray(creation) || isInsideAttribute(creation) || support === false) {
      continue;
    }

    if (view.suppressions.isSuppressed('CA1825', creation)) {
      continue;
    }

    const elementType = creation.namedChildren.find((child) => child.type === 'array_type')?.childForFieldName('type');
    if (!elementType) {
      continue;
    }

    const arrayType = support === undefined || isInsideLambda(creation) ? undefined : systemTypeReference(view, context, 'Array', creation);
    if (arrayType !== undefined) {
      view.edits.push({ start: creation.startIndex, end: creation.endIndex, text: `${arrayType}.Empty<${elementType.text}>()` });
    } else if (support === undefined) {
      view.report('CA1825', creation, `${creation.text} allocates an empty array, but the project's target framework is unknown, so Array.Empty<T>() may not exist; it was kept.`);
    } else if (isInsideLambda(creation)) {
      view.report('CA1825', creation, `${creation.text} allocates an empty array inside a lambda that may be an expression tree; it was kept.`);
    } else {
      view.report('CA1825', creation, `${creation.text} allocates an empty array, but the file or project declares something named System, so System.Array cannot be named safely; it was kept.`);
    }
  }

  return applyEdits(source, view.edits);
}

/** `new T[0]`, `new T[] { }` or `new T[0] { }` with a one-dimensional, non-pointer, non-jagged element type. */
function isZeroLengthArray(creation: Node): boolean {
  const arrayType = creation.namedChildren.find((child) => child.type === 'array_type');
  const initializer = creation.namedChildren.find((child) => child.type === 'initializer_expression');
  const elementType = arrayType?.childForFieldName('type');
  const rank = arrayType?.childForFieldName('rank');
  if (!elementType || !rank || elementType.type === 'array_type' || elementType.text.includes('*') || rank.text.includes(',')) {
    return false;
  }

  const emptyInitializer = initializer === undefined || initializer.namedChildren.length === 0;
  const sizes = rank.namedChildren;
  if (sizes.length === 0) {
    return initializer !== undefined && emptyInitializer;
  }

  return sizes.length === 1 && sizes[0].type === 'integer_literal' && isZeroLiteral(sizes[0].text) && emptyInitializer;
}

// ---------------------------------------------------------------------------------------------
// CA1827 / CA1828 / CA1829 / CA1860 Count() and Any()
// ---------------------------------------------------------------------------------------------

/** Collection types (by simple name, generic) with a `Count` property and no `IsEmpty`. */
const COUNT_PROPERTY_TYPES: Record<string, true> = {
  List: true,
  IList: true,
  ICollection: true,
  IReadOnlyCollection: true,
  IReadOnlyList: true,
  HashSet: true,
  SortedSet: true,
  ISet: true,
  IReadOnlySet: true,
  Dictionary: true,
  IDictionary: true,
  IReadOnlyDictionary: true,
  SortedDictionary: true,
  SortedList: true,
  Queue: true,
  Stack: true,
  LinkedList: true,
  Collection: true,
  ObservableCollection: true,
  ReadOnlyCollection: true,
  ReadOnlyDictionary: true,
};

/** Sequences with neither a count nor an emptiness property. */
const SEQUENCE_TYPES: Record<string, true> = { IEnumerable: true, IQueryable: true, IOrderedEnumerable: true, IOrderedQueryable: true };

/** LINQ operators returning a sequence of the same shape (`IEnumerable<T>`/`IQueryable<T>`). */
const SEQUENCE_OPERATORS: Record<string, true> = {
  Where: true, Select: true, SelectMany: true, OrderBy: true, OrderByDescending: true, ThenBy: true, ThenByDescending: true,
  Distinct: true, DistinctBy: true, Skip: true, SkipWhile: true, SkipLast: true, Take: true, TakeWhile: true, TakeLast: true,
  Concat: true, Union: true, Intersect: true, Except: true, GroupBy: true, Cast: true, OfType: true, Zip: true, Append: true,
  Prepend: true, DefaultIfEmpty: true, AsEnumerable: true, AsQueryable: true,
};

type CollectionKind = { readonly property: 'Length' | 'Count' } | { readonly property?: undefined };

/** What the receiver of `Count()`/`Any()` is known to be: a collection with a count property, a plain sequence, or unknown. */
function collectionKind(view: FileView, expression: Node): CollectionKind | undefined {
  const node = unwrapParentheses(expression);
  if (node.type === 'invocation_expression') {
    const callee = node.childForFieldName('function');
    const name = callee?.type === 'member_access_expression' ? callee.childForFieldName('name')?.text : undefined;
    const receiver = callee?.childForFieldName('expression');

    return name && SEQUENCE_OPERATORS[name] === true && receiver && collectionKind(view, receiver) ? {} : undefined;
  }

  const type = view.types.typeOf(node);
  if (!type) {
    return undefined;
  }

  if (type.endsWith('[]') || STRING_TYPES[type] === true) {
    return { property: 'Length' };
  }

  const name = simpleTypeName(type);
  if (!isGenericType(type) || view.types.declaresType(name)) {
    return undefined;
  }

  if (COUNT_PROPERTY_TYPES[name] === true) {
    return { property: 'Count' };
  }

  return SEQUENCE_TYPES[name] === true ? {} : undefined;
}

/** `Count() > 0` and its equivalents: the comparison and whether it tests for emptiness. */
export function countComparison(expression: Node): { readonly comparison: Node; readonly empty: boolean } | undefined {
  const { parent, child } = parentSkippingParentheses(expression);
  if (parent?.type !== 'binary_expression') {
    return undefined;
  }

  const left = parent.childForFieldName('left');
  const right = parent.childForFieldName('right');
  const operator = parent.children.find((node) => !node.isNamed && node !== left && node !== right)?.type;
  const onLeft = left === child;
  const other = onLeft ? right : left;
  const constant = other ? unwrapParentheses(other) : undefined;
  if (constant?.type !== 'integer_literal' || (constant.text !== '0' && constant.text !== '1')) {
    return undefined;
  }

  // [Count() OP constant] or [constant OP Count()] -> Count() is zero (true) / at least one (false).
  const table: Record<string, boolean> = onLeft
    ? constant.text === '0'
      ? { '==': true, '<=': true, '!=': false, '>': false }
      : { '<': true, '>=': false }
    : constant.text === '0'
      ? { '==': true, '>=': true, '!=': false, '<': false }
      : { '>': true, '<=': false };
  const empty = operator === undefined ? undefined : table[operator];

  return empty === undefined ? undefined : { comparison: parent, empty };
}

/** Parents under which `a != 0` can replace a primary expression without parentheses. */
const LOOSE_CONTEXTS: Record<string, true> = {
  parenthesized_expression: true,
  if_statement: true,
  while_statement: true,
  do_statement: true,
  return_statement: true,
  arrow_expression_clause: true,
  equals_value_clause: true,
  argument: true,
  assignment_expression: true,
  conditional_expression: true,
  lambda_expression: true,
  expression_statement: true,
};

export function inContext(node: Node, text: string): string {
  const parent = node.parent;
  if (!parent || LOOSE_CONTEXTS[parent.type] === true) {
    return text;
  }

  if (parent.type === 'binary_expression' && /^(?:&&|\|\|)$/.test(parent.children.find((child) => !child.isNamed)?.type ?? '')) {
    return text;
  }

  return `(${text})`;
}

export function applyCountPreferences(source: string, context: RuleContext): string {
  const active = ['CA1827', 'CA1828', 'CA1829', 'CA1860'].filter((id) => isRuleActive(context, id, source));
  if (active.length === 0 || !/\.\s*(?:(?:Long)?Count(?:Async)?|Any)\s*\(/.test(source)) {
    return source;
  }

  const view = viewOf(source, context);
  const enabled = (id: string): boolean => active.includes(id);
  const entityFramework = view.model.root
    .descendantsOfType('using_directive')
    .some((directive) => /^using\s+(?:Microsoft\.EntityFrameworkCore|System\.Data\.Entity)\s*;$/.test(directive.text.trim()));
  const declaresCountAsync = view.model.symbols.some((symbol) => symbol.category === 'member' && /^(?:Long)?CountAsync$/.test(symbol.name));

  for (const invocation of walk(view.model.root)) {
    const callee = invocation.type === 'invocation_expression' ? invocation.childForFieldName('function') : null;
    const name = callee?.type === 'member_access_expression' ? callee.childForFieldName('name')?.text : undefined;
    const receiver = callee?.childForFieldName('expression');
    const args = positionalArguments(invocation);
    if (!name || !receiver || !args || !callee || invocation.parent?.type === 'conditional_access_expression') {
      continue;
    }

    const argumentText = source.slice((invocation.childForFieldName('arguments')?.startIndex ?? 0) + 1, (invocation.childForFieldName('arguments')?.endIndex ?? 1) - 1);
    const lambda = isInsideLambda(invocation);
    const check = (id: string): boolean => enabled(id) && !view.suppressions.isSuppressed(id, invocation);

    if ((name === 'Count' || name === 'LongCount') && args.length <= 1) {
      const kind = collectionKind(view, receiver);
      const comparison = countComparison(invocation);
      // Only a lambda or anonymous method is certainly LINQ's predicate: `s.Count(',')` may bind MemoryExtensions.Count(span, item).
      const predicate = args.length === 1 && /^(?:lambda_expression|anonymous_method_expression)$/.test(unwrapParentheses(args[0]).type);
      if (comparison && args.length === 1 && !predicate) {
        if (check('CA1827')) {
          view.report('CA1827', invocation, `${invocation.text} is compared with a constant where Any() would do, but its argument may not be a predicate (Any has no overload taking an item); it was kept.`);
        }

        continue;
      }

      if (comparison && (predicate || (kind && !kind.property))) {
        if (!check('CA1827')) {
          continue;
        }

        if (!kind) {
          view.report('CA1827', invocation, `${receiver.text}.${name}() is compared with a constant where Any() would do, but the type of ${receiver.text} cannot be determined syntactically; it was kept.`);
        } else if (lambda) {
          view.report('CA1827', invocation, `${invocation.text} is compared where Any() would do, inside a lambda that may be an expression tree; it was kept.`);
        } else {
          view.edits.push({ start: comparison.comparison.startIndex, end: comparison.comparison.endIndex, text: `${comparison.empty ? '!' : ''}${receiver.text}.Any(${argumentText})` });
        }
      } else if (kind?.property && args.length === 0 && (name === 'Count' || comparison) && check('CA1829')) {
        if (lambda) {
          view.report('CA1829', invocation, `${invocation.text} could use the ${kind.property} property, but it is inside a lambda that may be an expression tree; it was kept.`);
        } else {
          view.edits.push({ start: invocation.startIndex, end: invocation.endIndex, text: `${receiver.text}.${kind.property}` });
        }
      } else if (comparison && !kind && args.length === 0 && check('CA1827')) {
        view.report('CA1827', invocation, `${receiver.text}.${name}() is compared with a constant where Any() would do, but the type of ${receiver.text} cannot be determined syntactically; it was kept.`);
      }
    } else if (name === 'Any' && args.length === 0 && check('CA1860')) {
      const property = collectionKind(view, receiver)?.property;
      if (!property) {
        continue;
      }

      if (lambda) {
        view.report('CA1860', invocation, `${invocation.text} could test ${property}, but it is inside a lambda that may be an expression tree; it was kept.`);
        continue;
      }

      const { parent, child } = parentSkippingParentheses(invocation);
      const negated = parent?.type === 'prefix_unary_expression' && parent.text.trimStart().startsWith('!') && parent.namedChildren[0] === child;
      const replaced = negated && parent ? parent : invocation;
      view.edits.push({ start: replaced.startIndex, end: replaced.endIndex, text: inContext(replaced, `${receiver.text}.${property} ${negated ? '==' : '!='} 0`) });
    } else if ((name === 'CountAsync' || name === 'LongCountAsync') && args.length <= 2 && check('CA1828')) {
      const awaited = parentSkippingParentheses(invocation);
      const comparison = awaited.parent?.type === 'await_expression' ? countComparison(awaited.parent) : undefined;
      if (!comparison) {
        continue;
      }

      if (!entityFramework || declaresCountAsync) {
        view.report('CA1828', invocation, `${receiver.text}.${name}() is compared with a constant where AnyAsync() would do, but it cannot be verified to be Entity Framework's ${name}; it was kept.`);
      } else {
        view.edits.push({ start: comparison.comparison.startIndex, end: comparison.comparison.endIndex, text: `${comparison.empty ? '!' : ''}await ${receiver.text}.AnyAsync(${argumentText})` });
      }
    }
  }

  return applyEdits(source, view.edits);
}

// ---------------------------------------------------------------------------------------------
// CA1507 Use nameof in place of string
// ---------------------------------------------------------------------------------------------

const EXCEPTION_TYPES: Record<string, true> = { ArgumentNullException: true, ArgumentException: true, ArgumentOutOfRangeException: true };

export function applyNameOf(source: string, context: RuleContext): string {
  if (!isRuleActive(context, 'CA1507', source) || !/(?:paramName|propertyName|Argument\w*Exception|Property\w+EventArgs)/.test(source)) {
    return source;
  }

  const tree = parseCSharp(source);
  try {
    const suppressions = suppressionsOf(source, context);
    const edits: TextEdit[] = [];
    for (const argument of walk(tree.rootNode)) {
      const literal = argument.type === 'argument' ? argument.namedChildren[argument.namedChildren.length - 1] : undefined;
      if (!literal || (literal.type !== 'string_literal' && literal.type !== 'verbatim_string_literal')) {
        continue;
      }

      const value = literal.type === 'string_literal' ? literal.text.slice(1, -1) : literal.text.slice(2, -1);
      const kind = /^[\p{L}_][\p{L}\p{N}_]*$/u.test(value) ? nameArgumentKind(argument) : undefined;
      const names = kind === 'paramName' ? enclosingParameters(argument, source) : kind === 'propertyName' ? containingProperties(argument) : undefined;
      const declared = names?.get(value);
      if (declared && !suppressions.isSuppressed('CA1507', argument)) {
        edits.push({ start: literal.startIndex, end: literal.endIndex, text: `nameof(${declared})` });
      }
    }

    return applyEdits(source, edits);
  } finally {
    tree.delete();
  }
}

/** Whether an argument is passed to a `paramName` or `propertyName` parameter of a known API. */
function nameArgumentKind(argument: Node): 'paramName' | 'propertyName' | undefined {
  const named = argument.childForFieldName('name')?.text;
  if (named !== undefined) {
    return named === 'paramName' || named === 'propertyName' ? named : undefined;
  }

  const list = argument.parent;
  const call = list?.parent;
  const args = list?.namedChildren.filter((child) => child.type === 'argument') ?? [];
  if (!call || args.some((other) => other.childForFieldName('name'))) {
    return undefined;
  }

  const index = args.indexOf(argument);
  const isText = (node: Node | undefined): boolean => node !== undefined && /(?:string_literal|interpolated_string_expression)$/.test(node.namedChildren[node.namedChildren.length - 1]?.type ?? '');
  if (call.type === 'object_creation_expression') {
    const type = simpleTypeName(normalizeType(call.childForFieldName('type')?.text ?? ''));
    switch (type) {
      case 'ArgumentNullException':
        return index === 0 && (args.length === 1 || (args.length === 2 && isText(args[1]))) ? 'paramName' : undefined;
      case 'ArgumentOutOfRangeException':
        return index === 0 && (args.length === 1 || args.length === 3 || (args.length === 2 && isText(args[1]))) ? 'paramName' : undefined;
      case 'ArgumentException':
        return index === 1 && (args.length === 2 || args.length === 3) ? 'paramName' : undefined;
      case 'PropertyChangedEventArgs':
      case 'PropertyChangingEventArgs':
        return index === 0 && args.length === 1 ? 'propertyName' : undefined;
      default:
        return undefined;
    }
  }

  // ArgumentNullException.ThrowIfNull(value, "value") and the other ThrowIf helpers: paramName is last.
  const callee = call.type === 'invocation_expression' ? call.childForFieldName('function') : null;
  const owner = callee?.type === 'member_access_expression' ? simpleTypeName(callee.childForFieldName('expression')?.text ?? '') : '';
  const method = callee?.childForFieldName('name')?.text ?? '';

  return EXCEPTION_TYPES[owner] === true && method.startsWith('ThrowIf') && args.length >= 2 && index === args.length - 1 ? 'paramName' : undefined;
}

/** Parameter names (as declared, keeping `@`) of the member, local functions, lambdas and accessors enclosing `node`. */
function enclosingParameters(node: Node, source: string): Map<string, string> {
  const names = new Map<string, string>();
  const add = (identifier: Node | null | undefined): void => {
    if (identifier?.type === 'identifier') {
      names.set(identifier.text.replace(/^@/, ''), identifier.text);
    }
  };

  for (let current = node.parent; current && current.type !== 'declaration_list'; current = current.parent) {
    const parameters = current.childForFieldName('parameters');
    if (current.type === 'lambda_expression' && parameters?.type === 'identifier') {
      add(parameters);
    } else if (parameters && current.type !== 'invocation_expression') {
      for (const parameter of parameters.namedChildren) {
        add(parameter.type === 'identifier' ? parameter : parameter.childForFieldName('name'));
      }
    } else if (current.type === 'accessor_declaration' && /^(?:\[[^\]]*\]\s*)*(?:\w+\s+)*(?:set|init|add|remove)\b/.test(current.text)) {
      names.set('value', 'value');
    }

    // A static local function or lambda cannot reference the enclosing parameters (CS8421).
    const precededByStatic = /\bstatic\s*$/.test(source.slice(Math.max(0, current.startIndex - 20), current.startIndex));
    const isStatic = (current.type === 'local_function_statement' || current.type === 'lambda_expression' || current.type === 'anonymous_method_expression') &&
      (current.namedChildren.some((child) => child.type === 'modifier' && child.text === 'static') || /^(?:async\s+)?static\b/.test(current.text) || precededByStatic);
    if (isStatic) {
      break;
    }
  }

  return names;
}

/** Property names of the type containing `node` (declared properties and positional record parameters). */
function containingProperties(node: Node): Map<string, string> {
  const names = new Map<string, string>();
  let type: Node | null = node.parent;
  while (type && !['class_declaration', 'struct_declaration', 'record_declaration'].includes(type.type)) {
    type = type.parent;
  }

  for (const member of type?.childForFieldName('body')?.namedChildren ?? []) {
    const name = member.type === 'property_declaration' ? member.childForFieldName('name') : null;
    if (name) {
      names.set(name.text.replace(/^@/, ''), name.text);
    }
  }

  if (type?.type === 'record_declaration') {
    for (const parameter of type.childForFieldName('parameters')?.namedChildren ?? []) {
      const name = parameter.childForFieldName('name');
      if (name) {
        names.set(name.text.replace(/^@/, ''), name.text);
      }
    }
  }

  return names;
}

// ---------------------------------------------------------------------------------------------
// CA1834 StringBuilder.Append(char)
// ---------------------------------------------------------------------------------------------

const STRING_BUILDER_CHAIN: Record<string, true> = {
  Append: true, AppendLine: true, AppendFormat: true, AppendJoin: true, Insert: true, Replace: true, Remove: true, Clear: true,
};

function isStringBuilder(view: FileView, expression: Node): boolean {
  const node = unwrapParentheses(expression);
  if (node.type === 'invocation_expression') {
    const callee = node.childForFieldName('function');
    const name = callee?.type === 'member_access_expression' ? callee.childForFieldName('name')?.text : undefined;
    const receiver = callee?.childForFieldName('expression');

    return name !== undefined && STRING_BUILDER_CHAIN[name] === true && receiver !== null && receiver !== undefined && isStringBuilder(view, receiver);
  }

  const type = view.types.typeOf(node);

  return type === 'System.Text.StringBuilder' || (type === 'StringBuilder' && !view.types.declaresType('StringBuilder'));
}

export function applyStringBuilderChar(source: string, context: RuleContext): string {
  if (!isRuleActive(context, 'CA1834', source) || !/\.\s*Append\s*\(/.test(source)) {
    return source;
  }

  const view = viewOf(source, context);
  for (const invocation of walk(view.model.root)) {
    const callee = invocation.type === 'invocation_expression' ? invocation.childForFieldName('function') : null;
    const receiver = callee?.type === 'member_access_expression' ? callee.childForFieldName('expression') : null;
    const args = positionalArguments(invocation);
    if (callee?.childForFieldName('name')?.text !== 'Append' || !receiver || args?.length !== 1) {
      continue;
    }

    const character = singleCharacterOf(args[0]);
    if (character !== undefined && isStringBuilder(view, receiver) && !view.suppressions.isSuppressed('CA1834', invocation)) {
      view.edits.push({ start: args[0].startIndex, end: args[0].endIndex, text: charLiteral(character) });
    }
  }

  return applyEdits(source, view.edits);
}

// ---------------------------------------------------------------------------------------------
// CA1847 / CA1865 / CA1866 / CA1867 char overloads of string methods
// ---------------------------------------------------------------------------------------------

type Comparison = 'ordinal' | 'invariant' | 'other';

const CHAR_OVERLOAD_METHODS: Record<string, true> = { StartsWith: true, EndsWith: true, IndexOf: true, LastIndexOf: true };

export function applyStringCharOverloads(source: string, context: RuleContext): string {
  const active = ['CA1847', 'CA1865', 'CA1866', 'CA1867'].filter((id) => isRuleActive(context, id, source));
  if (active.length === 0 || !/\.\s*(?:Contains|StartsWith|EndsWith|IndexOf|LastIndexOf)\s*\(\s*@?"/.test(source)) {
    return source;
  }

  const view = viewOf(source, context);
  const support = frameworksSupport(targetFrameworksOf(context.project), 'stringCharOverloads');
  const frameworkMessage = "but the project's target framework is unknown, so the char overload may not exist; it was kept.";
  for (const invocation of walk(view.model.root)) {
    const callee = invocation.type === 'invocation_expression' ? invocation.childForFieldName('function') : null;
    const name = callee?.type === 'member_access_expression' ? callee.childForFieldName('name')?.text ?? '' : '';
    const receiver = callee?.childForFieldName('expression');
    const args = positionalArguments(invocation);
    const character = args?.[0] ? singleCharacterOf(args[0]) : undefined;
    if (!args || character === undefined || !receiver || support === false || (name !== 'Contains' && CHAR_OVERLOAD_METHODS[name] !== true)) {
      continue;
    }

    if (!isString(view, receiver)) {
      continue;
    }

    const check = (id: string): boolean => active.includes(id) && !view.suppressions.isSuppressed(id, invocation);
    const literal = args[0];
    if (name === 'Contains') {
      const comparisonOnly = args.length === 1 || (args.length === 2 && /^(?:System\.)?StringComparison\.\w+$/.test(args[1].text.replace(/\s+/g, '')));
      if (!comparisonOnly || !check('CA1847')) {
        continue;
      }

      if (support === undefined) {
        view.report('CA1847', invocation, `${invocation.text} passes a single-character string, ${frameworkMessage}`);
      } else {
        view.edits.push({ start: literal.startIndex, end: literal.endIndex, text: charLiteral(character) });
      }

      continue;
    }

    const overload = classifyOverload(view, args.slice(1));
    const printableAscii = character >= ' ' && character <= '~';
    if (overload === undefined) {
      if (check('CA1866')) {
        view.report('CA1866', invocation, `${invocation.text} passes a single-character string, but the overload cannot be determined syntactically; it was kept.`);
      }
    } else if (overload.comparison === 'ordinal' || (overload.comparison === 'invariant' && printableAscii)) {
      if (!check('CA1865')) {
        continue;
      }

      if (support === undefined) {
        view.report('CA1865', invocation, `${invocation.text} passes a single-character string, ${frameworkMessage}`);
      } else if (name === 'LastIndexOf' && overload.integers.length > 0) {
        // LastIndexOf(string, startIndex) accepts startIndex == Length; LastIndexOf(char, startIndex) throws for it.
        view.report('CA1865', invocation, `${invocation.text} passes a single-character string, but the char overload throws when the start index equals the string length, which this one accepts; it was kept.`);
      } else {
        const argumentList = invocation.childForFieldName('arguments');
        const kept = overload.integers.map((integer) => `, ${integer.text}`).join('');
        if (argumentList) {
          view.edits.push({ start: argumentList.startIndex, end: argumentList.endIndex, text: `(${charLiteral(character)}${kept})` });
        }
      }
    } else if (overload.comparison === undefined) {
      if (check('CA1866')) {
        view.report('CA1866', invocation, `${invocation.text} passes a single-character string; the char overload compares ordinally while this one uses the current culture, so it was not changed.`);
      }
    } else if (check('CA1867')) {
      view.report('CA1867', invocation, `${invocation.text} passes a single-character string; the char overload does not take this comparison, so it was not changed.`);
    }
  }

  return applyEdits(source, view.edits);
}

/** The comparison and integer arguments after the string, or `undefined` when an argument is not recognized. */
function classifyOverload(view: FileView, args: readonly Node[]): { comparison?: Comparison; integers: Node[] } | undefined {
  let comparison: Comparison | undefined;
  let ignoreCase = false;
  const integers: Node[] = [];
  for (const argument of args) {
    const text = argument.text.replace(/\s+/g, '');
    const stringComparison = /^(?:System\.)?StringComparison\.(\w+)$/.exec(text)?.[1];
    const culture = /^(?:System\.Globalization\.)?CultureInfo\.(\w+)$/.exec(text)?.[1];
    if (stringComparison) {
      comparison = stringComparison === 'Ordinal' ? 'ordinal' : stringComparison === 'InvariantCulture' ? 'invariant' : 'other';
    } else if (culture) {
      comparison = culture === 'InvariantCulture' ? 'invariant' : 'other';
    } else if (argument.type === 'boolean_literal') {
      ignoreCase = argument.text === 'true';
    } else if (argument.type === 'integer_literal' || view.types.typeOf(argument) === 'int') {
      integers.push(argument);
    } else {
      return undefined;
    }
  }

  return { comparison: ignoreCase ? 'other' : comparison, integers };
}

// ---------------------------------------------------------------------------------------------
// CA2249 Use string.Contains instead of string.IndexOf
// ---------------------------------------------------------------------------------------------

export function applyStringContains(source: string, context: RuleContext): string {
  if (!isRuleActive(context, 'CA2249', source) || !/\.\s*IndexOf\s*\(/.test(source)) {
    return source;
  }

  const view = viewOf(source, context);
  const support = frameworksSupport(targetFrameworksOf(context.project), 'stringCharOverloads');
  for (const binary of walk(view.model.root)) {
    if (binary.type !== 'binary_expression' || support === false) {
      continue;
    }

    const match = indexOfComparison(binary);
    const callee = match?.invocation.childForFieldName('function');
    const receiver = callee?.childForFieldName('expression');
    const args = match ? positionalArguments(match.invocation) : undefined;
    if (!match || !receiver || !args || args.length === 0 || args.length > 2 || !isString(view, receiver)) {
      continue;
    }

    const comparison = args[1]?.text.replace(/\s+/g, '');
    if ((comparison !== undefined && !/^(?:System\.)?StringComparison\.\w+$/.test(comparison)) || view.suppressions.isSuppressed('CA2249', binary)) {
      continue;
    }

    const argumentType = args[0].type === 'character_literal' ? 'char' : view.types.typeOf(args[0]);
    if (argumentType !== 'char' && (argumentType === undefined || STRING_TYPES[argumentType] !== true)) {
      view.report('CA2249', binary, `${binary.text} tests whether a string contains a value, but the type of ${args[0].text} cannot be determined syntactically; it was kept.`);
      continue;
    }

    if (support === undefined) {
      view.report('CA2249', binary, `${binary.text} could use Contains, but the project's target framework is unknown, so the Contains overload may not exist; it was kept.`);
      continue;
    }

    const ordinal = comparison !== undefined && /\.Ordinal$/.test(comparison);
    let newArguments = args[0].text;
    if (argumentType === 'char') {
      newArguments += comparison && !ordinal ? `, ${args[1].text}` : '';
    } else if (comparison === undefined) {
      const comparisonType = systemTypeReference(view, context, 'StringComparison', binary);
      if (comparisonType === undefined) {
        view.report('CA2249', binary, `${binary.text} could use Contains, but the file or project declares something named System, so StringComparison cannot be named safely; it was kept.`);
        continue;
      }

      newArguments += `, ${comparisonType}.CurrentCulture`;
    } else if (!ordinal) {
      newArguments += `, ${args[1].text}`;
    }

    view.edits.push({ start: binary.startIndex, end: binary.endIndex, text: `${match.contains ? '' : '!'}${receiver.text}.Contains(${newArguments})` });
  }

  return applyEdits(source, view.edits);
}

/** `s.IndexOf(x) >= 0`, `s.IndexOf(x) != -1` (contains) and `s.IndexOf(x) == -1` (does not contain), either side for equality. */
function indexOfComparison(binary: Node): { readonly invocation: Node; readonly contains: boolean } | undefined {
  const left = binary.childForFieldName('left');
  const right = binary.childForFieldName('right');
  const operator = binary.children.find((child) => !child.isNamed && child !== left && child !== right)?.type;
  if (!left || !right) {
    return undefined;
  }

  const isIndexOf = (node: Node): boolean => {
    const callee = node.type === 'invocation_expression' ? node.childForFieldName('function') : null;

    return callee?.type === 'member_access_expression' && callee.childForFieldName('name')?.text === 'IndexOf';
  };
  const isMinusOne = (node: Node): boolean => node.text.replace(/\s+/g, '') === '-1';
  const leftSide = unwrapParentheses(left);
  const rightSide = unwrapParentheses(right);
  if (isIndexOf(leftSide)) {
    if (operator === '>=' && rightSide.text === '0') {
      return { invocation: leftSide, contains: true };
    }

    if ((operator === '==' || operator === '!=') && isMinusOne(rightSide)) {
      return { invocation: leftSide, contains: operator === '!=' };
    }
  } else if (isIndexOf(rightSide) && (operator === '==' || operator === '!=') && isMinusOne(leftSide)) {
    return { invocation: rightSide, contains: operator === '!=' };
  }

  return undefined;
}

// ---------------------------------------------------------------------------------------------
// IDE0004 Remove unnecessary cast
// ---------------------------------------------------------------------------------------------

/** Parents where the cast's value would be copied or bound differently without it. */
const CAST_SENSITIVE_PARENTS: Record<string, true> = {
  member_access_expression: true,
  element_access_expression: true,
  conditional_access_expression: true,
  invocation_expression: true,
  postfix_unary_expression: true,
};

export function applyUnnecessaryCasts(source: string, context: RuleContext): string {
  if (!isRuleActive(context, 'IDE0004', source) || !/\(\s*[\w.<>?\[\], ]+\s*\)\s*[\w"'@$]/.test(source)) {
    return source;
  }

  const view = viewOf(source, context);
  for (const cast of walk(view.model.root)) {
    const type = cast.type === 'cast_expression' ? cast.childForFieldName('type') : null;
    const value = cast.childForFieldName('value');
    if (!type || !value || CAST_SENSITIVE_PARENTS[parentSkippingParentheses(cast).parent?.type ?? ''] === true) {
      continue;
    }

    const valueType = value.type === 'identifier' ? view.types.declaredTypeText(value.text, value.startIndex) : literalType(value);
    if (valueType === undefined || valueType !== type.text.replace(/\s+/g, '') || view.suppressions.isSuppressed('IDE0004', cast)) {
      continue;
    }

    const separator = /\w/.test(source[cast.startIndex - 1] ?? '') ? ' ' : '';
    view.edits.push({ start: cast.startIndex, end: cast.endIndex, text: separator + value.text });
  }

  return applyEdits(source, view.edits);
}

/** The natural type of a literal, as C# infers it. */
function literalType(literal: Node): string | undefined {
  const text = literal.text.replace(/_/g, '').toLowerCase();
  switch (literal.type) {
    case 'string_literal':
    case 'verbatim_string_literal':
    case 'raw_string_literal':
      return 'string';
    case 'character_literal':
      return 'char';
    case 'boolean_literal':
      return 'bool';
    case 'real_literal':
      return text.endsWith('f') ? 'float' : text.endsWith('m') ? 'decimal' : 'double';
    case 'integer_literal': {
      const suffix = /(ul|lu|u|l)$/.exec(text)?.[1] ?? '';
      const digits = text.slice(0, text.length - suffix.length);
      let value: bigint;
      try {
        value = BigInt(digits);
      } catch {
        return undefined;
      }

      const fitsInt = value <= 2147483647n;
      const fitsUint = value <= 4294967295n;
      const fitsLong = value <= 9223372036854775807n;
      if (suffix === '') {
        return fitsInt ? 'int' : fitsUint ? 'uint' : fitsLong ? 'long' : 'ulong';
      }

      if (suffix === 'u') {
        return fitsUint ? 'uint' : 'ulong';
      }

      return suffix === 'l' ? (fitsLong ? 'long' : 'ulong') : 'ulong';
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// IDE0005 Remove unnecessary using directives
// ---------------------------------------------------------------------------------------------

/**
 * Removes the using directives that are unnecessary by syntax alone: duplicates in the same scope
 * and file-level imports of the file's own namespace (or one containing it), whose types the
 * namespace already sees. Other unnecessary usings need the compiler's binding and are left.
 */
export function applyUnnecessaryUsings(source: string, context: RuleContext): string {
  if (!isRuleActive(context, 'IDE0005', source)) {
    return source;
  }

  const tree = parseCSharp(source);
  try {
    const root = tree.rootNode;
    const suppressions = suppressionsOf(source, context);
    const containers = [root, ...root.namedChildren.filter((child) => /namespace_declaration$/.test(child.type)).map((namespace) => namespace.childForFieldName('body') ?? namespace)];
    const namespaces = root.namedChildren.filter((child) => /namespace_declaration$/.test(child.type));
    const firstNamespace = namespaces[0];
    const rootDirectives = root.namedChildren.filter((child) => child.type === 'using_directive');
    // Conditional compilation around the usings could make duplicates alternatives of each other.
    if (rootDirectives.length > 0 && /^[ \t]*#\s*(?:if|else|elif)\b/m.test(source.slice(0, firstNamespace?.startIndex ?? source.length))) {
      return source;
    }

    const removed = new Set<Node>();
    for (const container of containers) {
      const directives = container.namedChildren.filter((child) => child.type === 'using_directive');
      // A conditional directive among the container's usings could make duplicates alternatives of each other.
      const usingBlock = directives.length > 0 ? source.slice(container.startIndex, directives[directives.length - 1].endIndex) : '';
      if (/^[ \t]*#\s*(?:if|else|elif|endif)\b/m.test(usingBlock)) {
        continue;
      }

      const seen = new Set<string>();
      for (const directive of directives) {
        const key = directive.text.replace(/\s+/g, ' ').replace(/\s*;$/, '');
        if (key.startsWith('global ') || key.includes('=')) {
          continue;
        }

        if (seen.has(key)) {
          removed.add(directive);
        }

        seen.add(key);
      }
    }

    // Global attributes bind with the file-level usings, outside the namespace.
    const onlyUsingsAndNamespace =
      root.namedChildren.every((child) => ['using_directive', 'extern_alias_directive', 'comment'].includes(child.type) || child === firstNamespace) &&
      !/^[ \t]*\[\s*(?:assembly|module)\s*:/m.test(source);
    const namespaceName = firstNamespace?.childForFieldName('name')?.text.replace(/\s+/g, '');
    if (namespaces.length === 1 && onlyUsingsAndNamespace && namespaceName) {
      for (const directive of rootDirectives) {
        const imported = /^using\s+([\w.]+)\s*;$/.exec(directive.text.replace(/\s+/g, ' ').replace(/ ;$/, ';'))?.[1];
        if (imported && (namespaceName === imported || namespaceName.startsWith(`${imported}.`))) {
          removed.add(directive);
        }
      }
    }

    const edits: TextEdit[] = [];
    for (const directive of removed) {
      const edit = suppressions.isSuppressed('IDE0005', directive) ? undefined : removeDeclarationEdit(source, directive);
      if (edit) {
        edits.push(edit);
      }
    }

    return applyEdits(source, edits);
  } finally {
    tree.delete();
  }
}
