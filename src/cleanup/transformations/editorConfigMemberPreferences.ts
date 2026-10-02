import * as path from 'node:path';
import { effectiveEditorConfigValue } from '../editorConfigRegistry';
import { Node, TextEdit, applyEdits, findAll, parseCSharp, walk } from '../parser';
import type { Rule, RuleContext } from './editorConfigCodeStyle';
import { hasComment } from './editorConfigStatementPreferences';
import { EditorConfigIssueReporter, describeIssue, hasModifier, hasParseErrors, lineEndAt, lineStartAt, modifiersOf } from './editorConfigSupport';

/**
 * Declaration-level preferences: modifier order, `readonly` structs, `static` local functions and
 * auto properties are rewritten when the file shows everything the change depends on; the folder
 * a namespace should match and unused parameters are reported, since fixing them changes code in
 * other files.
 */

function edit(source: string, collect: (root: Node) => TextEdit[]): string {
  const tree = parseCSharp(source);
  try {
    return applyEdits(source, collect(tree.rootNode));
  } finally {
    tree.delete();
  }
}

const TYPE_DECLARATIONS = ['class_declaration', 'struct_declaration', 'record_declaration', 'interface_declaration'];

// ---------------------------------------------------------------------------------------------
// IDE0036 csharp_preferred_modifier_order
// ---------------------------------------------------------------------------------------------

const MODIFIER_ORDER_OPTION = 'csharp_preferred_modifier_order';

/** Reorders the modifiers of every declaration whose modifiers are all in the preferred list. */
function modifierOrder(source: string, { props }: RuleContext): string {
  const value = effectiveEditorConfigValue(props, MODIFIER_ORDER_OPTION);
  if (!value) {
    return source;
  }

  const order = value.split(',').map((modifier) => modifier.trim());

  return edit(source, (root) => {
    const edits: TextEdit[] = [];
    for (const node of walk(root)) {
      const modifiers = modifiersOf(node);
      if (modifiers.length < 2 || node.type === 'parameter' || hasParseErrors(node)) {
        continue;
      }

      // `partial` must stay last; any other modifier outside the list leaves the declaration alone.
      const rank = (modifier: Node): number => (modifier.text === 'partial' ? order.length : order.indexOf(modifier.text));
      const indexes = modifiers.map((modifier) => node.children.indexOf(modifier));
      const contiguous = indexes.every((index, i) => i === 0 || index === indexes[i - 1] + 1);
      const gaps = modifiers.slice(1).map((modifier, i) => source.slice(modifiers[i].endIndex, modifier.startIndex));
      // `ref` may belong to a `ref readonly` return type, where the order is fixed.
      if (!contiguous || modifiers.some((modifier) => rank(modifier) < 0 || modifier.text === 'ref') || gaps.some((gap) => !/^\s+$/.test(gap))) {
        continue;
      }

      const sorted = [...modifiers].sort((a, b) => rank(a) - rank(b));
      if (sorted.every((modifier, i) => modifier === modifiers[i])) {
        continue;
      }

      const text = sorted.map((modifier, i) => (i === 0 ? modifier.text : gaps[i - 1] + modifier.text)).join('');
      edits.push({ start: modifiers[0].startIndex, end: modifiers[modifiers.length - 1].endIndex, text });
    }

    return edits;
  });
}

// ---------------------------------------------------------------------------------------------
// IDE0250 csharp_style_prefer_readonly_struct
// ---------------------------------------------------------------------------------------------

/**
 * Adds `readonly` to a (non-partial) struct whose instance fields are all `readonly`, which has
 * no settable auto property, no field-like instance event, never assigns `this` outside a
 * constructor and never writes a primary constructor parameter (instance state a `readonly`
 * struct may not change), so nothing in it can change the instance.
 */
function readonlyStructs(source: string): string {
  return edit(source, (root) => {
    const edits: TextEdit[] = [];
    for (const struct of findAll(root, 'struct_declaration')) {
      const keyword = struct.children.find((child) => child.type === 'struct');
      const body = struct.childForFieldName('body');
      if (!keyword || hasModifier(struct, 'readonly') || hasModifier(struct, 'partial') || hasModifier(struct, 'unsafe') || hasParseErrors(struct)) {
        continue;
      }

      const members = body?.namedChildren ?? [];
      const instance = (member: Node): boolean => !hasModifier(member, 'static') && !hasModifier(member, 'const');
      const mutable = members.some(
        (member) =>
          (member.type === 'field_declaration' && instance(member) && !hasModifier(member, 'readonly')) ||
          (member.type === 'event_field_declaration' && instance(member)) ||
          (member.type === 'property_declaration' &&
            instance(member) &&
            (member.childForFieldName('accessors')?.namedChildren ?? []).some(
              (accessor) => !accessor.childForFieldName('body') && /^(?:\w+\s+)*set\s*;$/.test(accessor.text)
            ))
      );
      const assignsThis = findAll(struct, 'assignment_expression').some(
        (assignment) => assignment.childForFieldName('left')?.type === 'this_expression' && !isInside(assignment, 'constructor_declaration')
      );
      const parameterTypes = primaryConstructorParameterTypes(struct);
      const writesParameter = !!body && findAll(body, 'identifier').some((identifier) => parameterTypes.has(identifier.text) && changesParameter(identifier, parameterTypes.get(identifier.text)!));
      if (mutable || assignsThis || writesParameter || /&\s*this\b|\bref\s+this\b/.test(struct.text)) {
        continue;
      }

      const before = modifiersOf(struct).find((modifier) => modifier.text === 'ref') ?? keyword;
      edits.push({ start: before.startIndex, end: before.startIndex, text: 'readonly ' });
    }

    return edits;
  });
}

function isInside(node: Node, type: string): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === type) {
      return true;
    }
  }

  return false;
}

/** Name to whitespace-free type text of every primary constructor parameter of `type`. */
function primaryConstructorParameterTypes(type: Node): Map<string, string> {
  const types = new Map<string, string>();
  for (const parameter of type.childForFieldName('parameters')?.namedChildren ?? []) {
    const name = parameter.childForFieldName('name')?.text;
    if (name) {
      types.set(name, parameter.childForFieldName('type')?.text.replace(/\s+/g, '') ?? '');
    }
  }

  return types;
}

/**
 * True when a `readonly` struct could not change `identifier` (a captured primary constructor
 * parameter of the given type) the way the code does: it is written, or, unless its type is a
 * reference type, a member reached through it is written or has a method called on it (which
 * would run on a defensive copy).
 */
function changesParameter(identifier: Node, type: string): boolean {
  if (isWritten(identifier)) {
    return true;
  }

  if (REFERENCE_FIELD_TYPE.test(type)) {
    return false;
  }

  let chain = identifier;
  while (chain.parent && RECEIVER_CHAINS[chain.parent.type] && (chain.parent.type === 'parenthesized_expression' || chain.parent.childForFieldName('expression') === chain)) {
    chain = chain.parent;
  }

  return chain !== identifier && (isWritten(chain) || (chain.type === 'member_access_expression' && chain.parent?.type === 'invocation_expression' && chain.parent.childForFieldName('function') === chain));
}

/** True when `identifier` is written: assigned (also in a deconstructing tuple), incremented, or taken by `ref`/`out`. */
function isWritten(identifier: Node): boolean {
  let target = identifier;
  while (target.parent?.type === 'tuple_expression' || target.parent?.type === 'parenthesized_expression' || (target.parent?.type === 'argument' && target.parent.parent?.type === 'tuple_expression')) {
    target = target.parent;
  }

  const parent = target.parent;

  return (
    (parent?.type === 'assignment_expression' && parent.childForFieldName('left') === target) ||
    parent?.type === 'postfix_unary_expression' ||
    (parent?.type === 'prefix_unary_expression' && /^(?:\+\+|--)/.test(parent.text)) ||
    parent?.type === 'ref_expression' ||
    (identifier.parent?.type === 'argument' && /^(?:ref|out)\b/.test(identifier.parent.text))
  );
}

// ---------------------------------------------------------------------------------------------
// IDE0251 csharp_style_prefer_readonly_struct_member
// ---------------------------------------------------------------------------------------------

/** Field types whose methods cannot change the field itself (reference types). */
const REFERENCE_FIELD_TYPE = /^(?:string|object|String|Object|(?:List|Dictionary|HashSet|Queue|Stack|SortedDictionary|SortedList|SortedSet|IList|ICollection|IEnumerable|IDictionary|IReadOnlyList|IReadOnlyCollection|IReadOnlyDictionary)<.+>|.+\[\])\??$/;

/** Expressions whose value is a part of the expression they start with: `x.A`, `x[0]`, `(x)`. */
const RECEIVER_CHAINS: Record<string, true> = { member_access_expression: true, element_access_expression: true, parenthesized_expression: true };

/**
 * Adds `readonly` to the methods and get-only properties of a non-readonly, non-partial struct
 * that cannot change the instance: they assign nothing but their own locals, pass nothing by
 * reference, use `this` only to read members, and call only static or `readonly` members of the
 * struct and methods of fields of reference types. Anything else might mutate the instance
 * through a defensive copy, so it is left alone.
 */
function readonlyStructMembers(source: string): string {
  return edit(source, (root) => {
    const edits: TextEdit[] = [];
    for (const struct of findAll(root, 'struct_declaration')) {
      const members = struct.childForFieldName('body')?.namedChildren ?? [];
      if (hasModifier(struct, 'readonly') || hasModifier(struct, 'partial') || hasParseErrors(struct)) {
        continue;
      }

      // Captured primary constructor parameters are instance state, read and called like fields.
      const fieldTypes = primaryConstructorParameterTypes(struct);
      const safeMembers = new Set<string>();
      for (const member of members) {
        const declaration = member.namedChildren.find((child) => child.type === 'variable_declaration');
        for (const declarator of member.type === 'field_declaration' ? declaration?.namedChildren.filter((child) => child.type === 'variable_declarator') ?? [] : []) {
          fieldTypes.set(declarator.childForFieldName('name')?.text ?? '', declaration?.childForFieldName('type')?.text.replace(/\s+/g, '') ?? '');
        }

        const name = member.childForFieldName('name')?.text;
        const accessors = member.childForFieldName('accessors')?.namedChildren ?? [];
        const autoProperty = member.type === 'property_declaration' && accessors.length > 0 && accessors.every((accessor) => !accessor.childForFieldName('body'));
        if (name && (hasModifier(member, 'static') || hasModifier(member, 'readonly') || hasModifier(member, 'const') || autoProperty)) {
          safeMembers.add(name);
        }
      }

      const memberNames = new Set([...fieldTypes.keys(), ...members.map((member) => member.childForFieldName('name')?.text).filter((name): name is string => name !== undefined)]);
      for (const member of members) {
        const name = member.childForFieldName('name');
        const body = member.childForFieldName('body') ?? member.childForFieldName('value');
        const accessors = member.childForFieldName('accessors')?.namedChildren ?? [];
        const getterOnly = member.type === 'property_declaration' && (member.childForFieldName('value') !== null || (accessors.length === 1 && accessors[0].text.trimStart().startsWith('get') && accessors[0].childForFieldName('body') !== null));
        if (
          !name ||
          !(member.type === 'method_declaration' || getterOnly) ||
          safeMembers.has(name.text) ||
          // `ref` returns a writable reference into the instance: `readonly` would turn it into `ref readonly`.
          ['static', 'readonly', 'abstract', 'extern', 'partial', 'unsafe', 'ref'].some((modifier) => hasModifier(member, modifier)) ||
          !(body ?? accessors[0])
        ) {
          continue;
        }

        if (isNonMutating(member, memberNames, safeMembers, fieldTypes)) {
          const type = member.childForFieldName('type');
          if (type) {
            edits.push({ start: type.startIndex, end: type.startIndex, text: 'readonly ' });
          }
        }
      }
    }

    return edits;
  });
}

function isNonMutating(member: Node, memberNames: Set<string>, safeMembers: Set<string>, fieldTypes: Map<string, string>): boolean {
  const locals = new Set(member.descendantsOfType(['variable_declarator', 'parameter', 'declaration_expression']).map((node) => node.childForFieldName('name')?.text ?? ''));
  const refersToMember = (node: Node): string | undefined => {
    if (node.type === 'identifier' && memberNames.has(node.text) && !locals.has(node.text)) {
      return node.text;
    }

    const name = node.childForFieldName('name');

    return node.type === 'member_access_expression' && node.childForFieldName('expression')?.type === 'this_expression' && name ? name.text : undefined;
  };

  for (const node of member.descendantsOfType(['assignment_expression', 'postfix_unary_expression', 'prefix_unary_expression', 'argument', 'this_expression', 'invocation_expression', 'identifier', 'ref_expression'])) {
    switch (node.type) {
      // `ref _x` (a ref local, a ref return) can write the instance through the reference.
      case 'ref_expression':
        return false;
      case 'assignment_expression': {
        const left = node.childForFieldName('left');
        if (left?.type !== 'identifier' || !locals.has(left.text)) {
          return false;
        }

        break;
      }
      case 'postfix_unary_expression':
      case 'prefix_unary_expression': {
        const operand = node.namedChildren[0];
        if (/^(?:\+\+|--)|(?:\+\+|--)$/.test(node.text) && (operand?.type !== 'identifier' || !locals.has(operand.text))) {
          return false;
        }

        break;
      }
      case 'argument':
        if (/^(?:ref|out|in)\b/.test(node.text)) {
          return false;
        }

        break;
      case 'this_expression':
        if (node.parent?.type !== 'member_access_expression' || node.parent.childForFieldName('expression') !== node) {
          return false;
        }

        break;
      case 'invocation_expression': {
        const callee = node.childForFieldName('function');
        const called = callee ? refersToMember(callee) : undefined;
        // `_o.A.M()` copies `_o` in a readonly member too: check the field the receiver chain starts at.
        let receiver = callee?.type === 'member_access_expression' ? callee.childForFieldName('expression') : null;
        let field = receiver ? refersToMember(receiver) : undefined;
        while (receiver && !field && RECEIVER_CHAINS[receiver.type]) {
          receiver = receiver.type === 'parenthesized_expression' ? receiver.namedChildren[0] : receiver.childForFieldName('expression');
          field = receiver ? refersToMember(receiver) : undefined;
        }

        if ((called && !safeMembers.has(called)) || (field && !REFERENCE_FIELD_TYPE.test(fieldTypes.get(field) ?? ''))) {
          return false;
        }

        break;
      }
      case 'identifier': {
        // A property with a getter body may mutate; reading it from a readonly member copies the instance.
        const isDeclaredName = node.parent?.childForFieldName('name') === node && node.parent.type !== 'member_access_expression';
        const used = isDeclaredName ? undefined : refersToMember(node);
        if (used && !fieldTypes.has(used) && !safeMembers.has(used) && node.parent?.type !== 'invocation_expression') {
          return false;
        }

        break;
      }
    }
  }

  return true;
}

// ---------------------------------------------------------------------------------------------
// IDE0062 csharp_prefer_static_local_function
// ---------------------------------------------------------------------------------------------

const OBJECT_INSTANCE_METHODS = ['ToString', 'GetHashCode', 'Equals', 'GetType', 'MemberwiseClone'];

/**
 * Names `member` declares in scopes around `local` (parameters, locals, pattern and query
 * variables); lambdas and other local functions that do not contain `local` are skipped.
 */
function localNames(member: Node, local: Node): Set<string> {
  const names = new Set<string>();
  const visit = (node: Node): void => {
    const name = node.childForFieldName('name');
    const containsLocal = node.startIndex <= local.startIndex && local.endIndex <= node.endIndex;
    if (node === local || ((node.type === 'local_function_statement' || node.type === 'lambda_expression' || node.type === 'anonymous_method_expression') && !containsLocal)) {
      if (node.type === 'local_function_statement' && name) {
        names.add(name.text);
      }

      return;
    }

    if ((node.type === 'variable_declarator' || node.type === 'parameter' || node.type === 'local_function_statement' || node.type === 'declaration_expression') && name) {
      names.add(name.text);
    } else if (node.type === 'lambda_expression' && node.childForFieldName('parameters')?.type === 'identifier') {
      names.add(node.childForFieldName('parameters')!.text);
    } else if (node.type === 'pattern' || node.type === 'from_clause' || node.type === 'let_clause' || node.type === 'join_clause' || node.type === 'for_each_statement') {
      node.descendantsOfType('identifier').forEach((identifier) => names.add(identifier.text));
    } else if (node.type === 'invocation_expression' && node.childForFieldName('function')?.text === 'var') {
      // `var (a, b) = ...` reads as a call of `var`.
      node.descendantsOfType('identifier').forEach((identifier) => names.add(identifier.text));
    }

    node.namedChildren.forEach(visit);
  };
  visit(member);

  return names;
}

/** Instance members declared in `type`'s body. */
function instanceMemberNames(type: Node): Set<string> {
  const names = new Set<string>(OBJECT_INSTANCE_METHODS);
  for (const member of type.childForFieldName('body')?.namedChildren ?? []) {
    if (hasModifier(member, 'static') || hasModifier(member, 'const') || TYPE_DECLARATIONS.includes(member.type) || member.type === 'enum_declaration') {
      continue;
    }

    const declaration = member.namedChildren.find((child) => child.type === 'variable_declaration');
    for (const declarator of declaration?.namedChildren.filter((child) => child.type === 'variable_declarator') ?? []) {
      names.add(declarator.childForFieldName('name')?.text ?? '');
    }

    const name = member.childForFieldName('name');
    if (name && member.type !== 'constructor_declaration') {
      names.add(name.text);
    }
  }

  for (const parameter of type.childForFieldName('parameters')?.namedChildren ?? []) {
    names.add(parameter.childForFieldName('name')?.text ?? '');
  }

  return names;
}

/**
 * Makes a local function `static` when it uses no `this`, `base`, instance member of its type
 * (declared in the file, the type being non-partial and without a base class) or local or
 * parameter of the enclosing member.
 */
function staticLocalFunctions(source: string): string {
  return edit(source, (root) => {
    const edits: TextEdit[] = [];
    for (const local of findAll(root, 'local_function_statement')) {
      if (hasModifier(local, 'static') || hasParseErrors(local)) {
        continue;
      }

      let member: Node | null = local.parent;
      while (member && !/_declaration$/.test(member.type)) {
        member = member.parent;
      }

      const type = member?.parent?.type === 'declaration_list' ? member.parent.parent : null;
      const hasBaseClass = type?.type !== 'struct_declaration' && type?.namedChildren.some((child) => child.type === 'base_list');
      if (!member || !type || !TYPE_DECLARATIONS.includes(type.type) || hasModifier(type, 'partial') || hasBaseClass || hasParseErrors(member)) {
        continue;
      }

      // A name declared both outside and inside counts as captured: telling them apart needs scopes.
      const name = local.childForFieldName('name');
      const captured = new Set([...localNames(member, local), ...instanceMemberNames(type)]);
      captured.delete(name?.text ?? '');
      const isMemberName = (identifier: Node): boolean =>
        (identifier.parent?.type === 'member_access_expression' || identifier.parent?.type === 'conditional_access_expression' || identifier.parent?.type === 'qualified_name') &&
        identifier.parent.childForFieldName('name') === identifier;
      const capturing =
        local.descendantsOfType('this_expression').length > 0 ||
        /\bbase\s*[.[]/.test(local.text) ||
        local.descendantsOfType('identifier').some((identifier) => identifier !== name && !isMemberName(identifier) && captured.has(identifier.text));
      if (capturing) {
        continue;
      }

      const first = modifiersOf(local)[0] ?? local.childForFieldName('type');
      if (first) {
        edits.push({ start: first.startIndex, end: first.startIndex, text: 'static ' });
      }
    }

    return edits;
  });
}

// ---------------------------------------------------------------------------------------------
// IDE0032 dotnet_style_prefer_auto_properties
// ---------------------------------------------------------------------------------------------

const AUTO_PROPERTY_OPTION = 'dotnet_style_prefer_auto_properties';

/** The field a trivial accessor reads (`get { return _f; }`, `get => _f;`) or writes (`set => _f = value;`). */
function accessedField(accessor: Node, kind: 'get' | 'set'): string | undefined {
  const body = accessor.childForFieldName('body');
  const expression =
    body?.type === 'arrow_expression_clause'
      ? body.namedChildren[0]
      : body?.type === 'block' && body.namedChildCount === 1
        ? kind === 'get' && body.namedChildren[0].type === 'return_statement'
          ? body.namedChildren[0].namedChildren[0]
          : kind === 'set' && body.namedChildren[0].type === 'expression_statement'
            ? body.namedChildren[0].namedChildren[0]
            : undefined
        : undefined;
  if (kind === 'get') {
    return expression?.type === 'identifier' ? expression.text : undefined;
  }

  const left = expression?.type === 'assignment_expression' && expression.children.find((child) => !child.isNamed)?.type === '=' ? expression.childForFieldName('left') : null;

  return left?.type === 'identifier' && expression?.childForFieldName('right')?.text === 'value' ? left.text : undefined;
}

/**
 * `private int _x; public int X { get { return _x; } set { _x = value; } }` becomes
 * `public int X { get; set; }` when the field is used nowhere else; a field used elsewhere is
 * reported.
 */
function autoProperties(source: string, report: EditorConfigIssueReporter): string {
  return edit(source, (root) => {
    const edits: TextEdit[] = [];
    for (const type of findAll(root, ['class_declaration', 'struct_declaration', 'record_declaration'])) {
      const members = type.childForFieldName('body')?.namedChildren ?? [];
      if (hasModifier(type, 'partial') || hasParseErrors(type)) {
        continue;
      }

      for (const property of members.filter((member) => member.type === 'property_declaration')) {
        const accessors = property.childForFieldName('accessors')?.namedChildren ?? [];
        const arrow = property.childForFieldName('value');
        const keyword = (accessor: Node): string | undefined => accessor.children.find((child) => !child.isNamed && /^(?:get|set|init)$/.test(child.type))?.type;
        const getter = accessors.find((accessor) => keyword(accessor) === 'get');
        const setter = accessors.find((accessor) => keyword(accessor) === 'set' || keyword(accessor) === 'init');
        const read = arrow?.type === 'arrow_expression_clause' ? (arrow.namedChildren[0]?.type === 'identifier' ? arrow.namedChildren[0].text : undefined) : getter && accessedField(getter, 'get');
        const written = setter ? accessedField(setter, 'set') : undefined;
        if (
          !read ||
          (setter && written !== read) ||
          accessors.length !== (arrow ? 0 : setter ? 2 : 1) ||
          accessors.some((accessor) => accessor.namedChildren.some((child) => child.type === 'attribute_list')) ||
          hasModifier(property, 'abstract') ||
          hasModifier(property, 'extern') ||
          hasComment(source, property.startIndex, property.endIndex)
        ) {
          continue;
        }

        const field = members.find(
          (member) =>
            member.type === 'field_declaration' &&
            member.namedChildren.find((child) => child.type === 'variable_declaration')?.namedChildren.some((d) => d.type === 'variable_declarator' && d.childForFieldName('name')?.text === read)
        );
        const declaration = field?.namedChildren.find((child) => child.type === 'variable_declaration');
        const declarators = declaration?.namedChildren.filter((child) => child.type === 'variable_declarator') ?? [];
        const fieldType = declaration?.childForFieldName('type');
        const propertyType = property.childForFieldName('type');
        if (
          !field ||
          declarators.length !== 1 ||
          !fieldType ||
          !propertyType ||
          fieldType.text.replace(/\s+/g, '') !== propertyType.text.replace(/\s+/g, '') ||
          hasModifier(field, 'static') !== hasModifier(property, 'static') ||
          ['const', 'volatile', 'fixed', 'public', 'protected', 'internal'].some((modifier) => hasModifier(field, modifier)) ||
          field.namedChildren.some((child) => child.type === 'attribute_list') ||
          (hasModifier(field, 'readonly') && setter !== undefined)
        ) {
          continue;
        }

        // Initializers run in textual order: moving one past another member's initializer would
        // reorder them (https://learn.microsoft.com/dotnet/csharp/language-reference/language-specification/classes#1556-variable-initializers).
        const hasInitializer = (member: Node): boolean =>
          member.namedChildren.some((child) => child.type === 'equals_value_clause') ||
          (member.namedChildren.find((child) => child.type === 'variable_declaration')?.descendantsOfType('equals_value_clause').length ?? 0) > 0;
        const [from, to] = [members.indexOf(field), members.indexOf(property)].sort((a, b) => a - b);
        if (hasInitializer(field) && members.slice(from + 1, to).some(hasInitializer)) {
          continue;
        }

        const inProperty = (node: Node): boolean => node.startIndex >= property.startIndex && node.endIndex <= property.endIndex;
        const name = declarators[0].childForFieldName('name')!;
        const otherUses = type
          .descendantsOfType('identifier')
          .filter((identifier) => identifier.text === read && identifier !== name && !inProperty(identifier));
        if (otherUses.length > 0) {
          report(
            describeIssue('IDE0032', AUTO_PROPERTY_OPTION, source, property.startIndex, `'${property.childForFieldName('name')?.text}' was not made an auto property: '${read}' is used outside it.`)
          );
          continue;
        }

        const lineStart = lineStartAt(source, field.startIndex);
        const lineEnd = lineEndAt(source, field.endIndex);
        const fieldAlone = source.slice(lineStart, field.startIndex).trim() === '' && source.slice(field.endIndex, lineEnd).trim() === '';
        const previousLine = source.slice(lineStartAt(source, Math.max(0, lineStart - 1)), lineStart).trim();
        if (!fieldAlone || previousLine.startsWith('//') || previousLine.endsWith('*/') || previousLine.endsWith(']')) {
          continue;
        }

        // Remove the field's line, and a blank line after it when that would leave two in a row.
        const afterLine = (index: number): number => (source.startsWith('\r\n', index) ? index + 2 : source.startsWith('\n', index) ? index + 1 : index);
        let end = afterLine(lineEnd);
        const nextLineEnd = lineEndAt(source, end);
        if (end < source.length && source.slice(end, nextLineEnd).trim() === '' && (previousLine === '' || previousLine.endsWith('{'))) {
          end = afterLine(nextLineEnd);
        }

        edits.push({ start: lineStart, end, text: '' });

        const initializer = declarators[0].namedChildren.find((child) => child.type === 'equals_value_clause');
        const setterText = setter ? ` ${setter.text.replace(/\s*(?:=>[\s\S]*|\{[\s\S]*)$/, '')};` : '';
        const accessorText = `{ get;${setterText} }${initializer ? ` ${initializer.text};` : ''}`;
        const start = property.childForFieldName('name')!.endIndex;
        edits.push({ start, end: property.endIndex, text: ` ${accessorText}` });
      }
    }

    return edits;
  });
}

// ---------------------------------------------------------------------------------------------
// IDE0130 dotnet_style_namespace_match_folder
// ---------------------------------------------------------------------------------------------

const NAMESPACE_FOLDER_OPTION = 'dotnet_style_namespace_match_folder';
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Reports a namespace that differs from the project's root namespace followed by the file's
 * folders. Changing it would break code in other files, so it is never rewritten.
 */
function namespaceMatchesFolder(source: string, { report, filePath, project }: RuleContext): string {
  if (!filePath || !project?.rootNamespace) {
    return source;
  }

  const relative = path.relative(project.directory, path.dirname(path.resolve(filePath)));
  const folders = relative.split(/[\\/]/).filter(Boolean);
  if (relative.startsWith('..') || path.isAbsolute(relative) || folders.some((folder) => !IDENTIFIER.test(folder))) {
    return source;
  }

  const expected = [project.rootNamespace, ...folders].join('.');
  const tree = parseCSharp(source);
  try {
    const namespaces = tree.rootNode.namedChildren.filter((child) => child.type === 'namespace_declaration' || child.type === 'file_scoped_namespace_declaration');
    const name = namespaces[0]?.childForFieldName('name');
    const nested = namespaces[0]?.descendantsOfType('namespace_declaration').length ?? 0;
    if (namespaces.length === 1 && name && nested === 0 && name.text.replace(/\s+/g, '') !== expected) {
      report(describeIssue('IDE0130', NAMESPACE_FOLDER_OPTION, source, name.startIndex, `namespace '${name.text}' does not match the folder structure, expected '${expected}'.`));
    }
  } finally {
    tree.delete();
  }

  return source;
}

// ---------------------------------------------------------------------------------------------
// IDE0060 dotnet_code_quality_unused_parameters
// ---------------------------------------------------------------------------------------------

const UNUSED_PARAMETERS_OPTION = 'dotnet_code_quality_unused_parameters';
const VISIBLE = ['public', 'protected'];

/**
 * Reports parameters a method, constructor or local function never uses. Removing them changes
 * callers in other files, so they are never rewritten. Overrides, virtual, abstract, extern and
 * partial methods, explicit interface implementations, event handlers, methods that only throw
 * and (for `non_public`) methods visible outside the type are skipped, as are public methods of
 * types with a base list (they may implement an interface).
 */
function unusedParameters(source: string, { props, report }: RuleContext): string {
  const value = effectiveEditorConfigValue(props, UNUSED_PARAMETERS_OPTION);
  if (!value) {
    return source;
  }

  const tree = parseCSharp(source);
  try {
    for (const method of findAll(tree.rootNode, ['method_declaration', 'constructor_declaration', 'local_function_statement'])) {
      const body = method.childForFieldName('body');
      const parameters = method.childForFieldName('parameters')?.namedChildren.filter((child) => child.type === 'parameter') ?? [];
      const type = method.parent?.type === 'declaration_list' ? method.parent.parent : null;
      const visible = VISIBLE.some((modifier) => hasModifier(method, modifier));
      const onlyThrows = body?.type === 'block' ? body.namedChildCount === 1 && body.namedChildren[0].type === 'throw_statement' : body?.namedChildren[0]?.type === 'throw_expression';
      const types = parameters.map((parameter) => parameter.childForFieldName('type')?.text ?? '');
      const isEventHandler = parameters.length === 2 && /^object\??$/.test(types[0]) && /EventArgs$/.test(types[1]);
      if (
        !body ||
        parameters.length === 0 ||
        hasParseErrors(method) ||
        ['override', 'virtual', 'abstract', 'extern', 'partial'].some((modifier) => hasModifier(method, modifier)) ||
        type?.type === 'interface_declaration' ||
        /\.\s*\w+\s*$/.test(method.childForFieldName('name')?.text ?? '') ||
        method.namedChildren.some((child) => child.type === 'explicit_interface_specifier') ||
        method.childForFieldName('name')?.text === 'Main' ||
        (visible && (value === 'non_public' || type?.namedChildren.some((child) => child.type === 'base_list'))) ||
        isEventHandler ||
        onlyThrows
      ) {
        continue;
      }

      const scope = [body, ...method.namedChildren.filter((child) => child.type === 'constructor_initializer')];
      for (const parameter of parameters) {
        const name = parameter.childForFieldName('name');
        const used = scope.some((node) => node.descendantsOfType('identifier').some((identifier) => identifier.text === name?.text));
        if (!name || used || name.text.startsWith('_') || hasModifier(parameter, 'this') || /^\s*this\b/.test(parameter.text)) {
          continue;
        }

        const memberName = method.type === 'constructor_declaration' ? 'constructor' : `'${method.childForFieldName('name')?.text}'`;
        report(describeIssue('IDE0060', UNUSED_PARAMETERS_OPTION, source, name.startIndex, `parameter '${name.text}' of ${memberName} is never used.`));
      }
    }
  } finally {
    tree.delete();
  }

  return source;
}

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

export const MEMBER_RULES: readonly Rule[] = [
  {
    option: 'csharp_style_prefer_readonly_struct',
    apply: (source, { props }) => (effectiveEditorConfigValue(props, 'csharp_style_prefer_readonly_struct') === 'true' ? readonlyStructs(source) : source),
  },
  {
    option: 'csharp_style_prefer_readonly_struct_member',
    apply: (source, { props }) => (effectiveEditorConfigValue(props, 'csharp_style_prefer_readonly_struct_member') === 'true' ? readonlyStructMembers(source) : source),
  },
  {
    option: 'csharp_prefer_static_local_function',
    apply: (source, { props }) => (effectiveEditorConfigValue(props, 'csharp_prefer_static_local_function') === 'true' ? staticLocalFunctions(source) : source),
  },
  {
    option: AUTO_PROPERTY_OPTION,
    apply: (source, { props, report }) => (effectiveEditorConfigValue(props, AUTO_PROPERTY_OPTION) === 'true' ? autoProperties(source, report) : source),
  },
  { option: MODIFIER_ORDER_OPTION, apply: modifierOrder },
  {
    option: NAMESPACE_FOLDER_OPTION,
    apply: (source, context) => (effectiveEditorConfigValue(context.props, NAMESPACE_FOLDER_OPTION) === 'true' ? namespaceMatchesFolder(source, context) : source),
  },
  { option: UNUSED_PARAMETERS_OPTION, apply: unusedParameters },
];
