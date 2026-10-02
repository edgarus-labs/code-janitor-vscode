import { Node, TextEdit, applyEdits, findAll, parseCSharp } from '../parser';
import type { Rule, RuleContext } from './editorConfigCodeStyle';
import { declaredTypeText } from './editorConfigExpressionPreferences';
import { operatorOf } from './editorConfigPrecedence';
import { attributeName, describeDiagnostic, isRuleActive } from './editorConfigQualityRulesSupport';
import { loadProjectFacts, suppressionsOf } from './editorConfigQualityRulesProject';
import { describeIssue, hasParseErrors, readCodeStyleOption } from './editorConfigSupport';
import { isInPossibleExpressionTree } from './nullCheckPatternMatching';

/**
 * Rules without a code-style option that simplify code (IDE0035, IDE0080, IDE0082, IDE0100,
 * IDE0110), and rules only reported because their fix needs semantic information (IDE0050,
 * IDE0070, IDE0072, IDE0076, IDE0077). Each applies while its diagnostic is enforced, outside
 * generated code and `#pragma warning disable` / `[SuppressMessage]` regions.
 */

export interface Tools {
  readonly suppressed: (node: Node) => boolean;
  readonly report: (node: Node, message: string) => void;
  /** Reports at an offset without a node (preprocessor directives). */
  readonly reportAt: (offset: number, message: string) => void;
}

export type Collect = (source: string, root: Node, context: RuleContext, tools: Tools) => TextEdit[];

export function diagnosticRule(diagnosticId: string, collect: Collect): Rule {
  return {
    option: diagnosticId,
    apply: (source, context) => {
      if (!isRuleActive(context, diagnosticId, source)) {
        return source;
      }

      const tree = parseCSharp(source);
      try {
        const suppressions = suppressionsOf(source, context);
        const suppressed = (node: Node): boolean => suppressions.isSuppressed(diagnosticId, node);
        const report = (node: Node, message: string): void => {
          if (!suppressed(node)) {
            context.report(describeDiagnostic(diagnosticId, source, node.startIndex, message));
          }
        };

        const reportAt = (offset: number, message: string): void => {
          if (!suppressions.isSuppressedAt(diagnosticId, offset)) {
            context.report(describeDiagnostic(diagnosticId, source, offset, message));
          }
        };

        return applyEdits(source, collect(source, tree.rootNode, context, { suppressed, report, reportAt }));
      } finally {
        tree.delete();
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// IDE0100 Remove unnecessary equality operator
// ---------------------------------------------------------------------------------------------

const BOOL_TYPES: Record<string, true> = { bool: true, Boolean: true, 'System.Boolean': true };
const NUMERIC_TYPES: Record<string, true> = {
  int: true, long: true, short: true, byte: true, sbyte: true, uint: true, ulong: true, ushort: true,
  float: true, double: true, decimal: true, char: true, nint: true, nuint: true,
};

function isBuiltInNumeric(node: Node): boolean {
  return node.type === 'integer_literal' || node.type === 'real_literal' || (node.type === 'identifier' && NUMERIC_TYPES[declaredTypeText(node) ?? ''] === true);
}

/**
 * True when `node` is certainly of type `bool` (not `bool?`, not a type with its own operators): a
 * variable declared `bool`, a comparison of built-in numbers, `!`, `&&`, `||` of such values, or
 * an `is` test.
 */
function isBool(node: Node): boolean {
  switch (node.type) {
    case 'identifier':
      return BOOL_TYPES[declaredTypeText(node) ?? ''] === true;
    case 'parenthesized_expression':
      return node.namedChildCount === 1 && isBool(node.namedChildren[0]);
    case 'is_pattern_expression':
      return true;
    case 'prefix_unary_expression':
      return node.children[0]?.type === '!' && node.namedChildCount === 1 && isBool(node.namedChildren[0]);
    case 'binary_expression': {
      const operator = operatorOf(node) ?? '';
      const [left, right] = [node.childForFieldName('left'), node.childForFieldName('right')];
      if (!left || !right) {
        return false;
      }

      if (operator === '&&' || operator === '||') {
        return isBool(left) && isBool(right);
      }

      return ['<', '>', '<=', '>=', '==', '!='].includes(operator) && isBuiltInNumeric(left) && isBuiltInNumeric(right);
    }
    default:
      return false;
  }
}

const collectEqualityOperators: Collect = (_source, root, _context, { suppressed }) =>
  findAll(root, 'binary_expression').flatMap((comparison): TextEdit[] => {
    const operator = operatorOf(comparison);
    const left = comparison.childForFieldName('left');
    const right = comparison.childForFieldName('right');
    if ((operator !== '==' && operator !== '!=') || !left || !right || suppressed(comparison) || isInPossibleExpressionTree(comparison)) {
      return [];
    }

    const constant = right.type === 'boolean_literal' ? right : left.type === 'boolean_literal' ? left : undefined;
    const value = constant === right ? left : right;
    if (!constant || value.type === 'boolean_literal' || !isBool(value)) {
      return [];
    }

    // `x == true` and `x != false` are `x`; `x == false` and `x != true` are `!x`.
    const keeps = (operator === '==') === (constant.text === 'true');
    const simple = ['identifier', 'parenthesized_expression', 'invocation_expression', 'member_access_expression'].includes(value.type);
    const text = keeps ? value.text : simple ? `!${value.text}` : `!(${value.text})`;

    return [{ start: comparison.startIndex, end: comparison.endIndex, text }];
  });

// ---------------------------------------------------------------------------------------------
// IDE0110 Remove unnecessary discard
// ---------------------------------------------------------------------------------------------

const PATTERN_TYPES: Record<string, true> = { predefined_type: true, identifier: true, qualified_name: true, generic_name: true, array_type: true };

/** Names the file declares as values (fields, constants, locals, parameters, enum members, properties). */
export function valueNames(root: Node): Set<string> {
  const names = new Set<string>();
  for (const node of findAll(root, ['variable_declarator', 'parameter', 'enum_member_declaration', 'property_declaration'])) {
    const name = node.childForFieldName('name') ?? node.namedChildren.find((child) => child.type === 'identifier');
    if (name) {
      names.add(name.text);
    }
  }

  return names;
}

/**
 * `case T _:`, `x is T _` and `T _ =>` become `case T:`, `x is T` and `T =>` (C# 9 type patterns).
 * A name the file also declares as a value is left alone: without the discard it could be read as
 * a constant pattern.
 */
const collectDiscards: Collect = (_source, root, _context, { suppressed }) => {
  const values = valueNames(root);
  const edits: TextEdit[] = [];
  for (const discard of findAll(root, 'identifier')) {
    if (discard.text !== '_' || suppressed(discard)) {
      continue;
    }

    const parent = discard.parent;
    const siblings = parent?.children ?? [];
    const index = siblings.findIndex((child) => child.startIndex === discard.startIndex && child.type === discard.type);
    const type = index > 0 ? siblings[index - 1] : undefined;
    if (!parent || !type || !type.isNamed || PATTERN_TYPES[type.type] !== true || type.text === 'var' || type.endPosition.row !== discard.startPosition.row) {
      continue;
    }

    const inPattern = parent.type === 'pattern' && parent.namedChildCount === 2;
    const before = siblings[index - 2]?.type;
    const after = siblings[index + 1]?.type;
    const inLabelOrArm =
      parent.type === 'switch_body' && (before === 'case' || before === '{' || before === ',') && (after === ':' || after === '=>' || after === 'when');
    const lastName = type.text.split('.').pop() ?? '';
    if ((!inPattern && !inLabelOrArm) || values.has(lastName)) {
      continue;
    }

    edits.push({ start: type.endIndex, end: discard.endIndex, text: '' });
  }

  return edits;
};

// ---------------------------------------------------------------------------------------------
// IDE0082 Convert typeof to nameof
// ---------------------------------------------------------------------------------------------

const CLR_NAMES: Record<string, string> = {
  bool: 'Boolean', byte: 'Byte', sbyte: 'SByte', char: 'Char', decimal: 'Decimal', double: 'Double', float: 'Single',
  int: 'Int32', uint: 'UInt32', long: 'Int64', ulong: 'UInt64', short: 'Int16', ushort: 'UInt16', object: 'Object', string: 'String',
  nint: 'IntPtr', nuint: 'UIntPtr',
};

/**
 * `typeof(T).Name` becomes `nameof(T)` when both give the same name: not for generic types
 * (`List`1`), type parameters (their runtime name) or using aliases (the aliased type's name).
 * A single name may be an alias of another file (`global using`, a project `<Using Alias>`): it
 * changes only when it names a type of the file, or the project facts show it is no such alias.
 * Built-in types become their CLR name, when `System` is imported.
 */
const collectTypeofNames: Collect = (source, root, context, { suppressed }) => {
  const aliases = new Set(
    findAll(root, 'using_directive').flatMap((directive) => /^using\s+(?:static\s+)?(@?\w+)\s*=/.exec(directive.text)?.[1] ?? [])
  );
  const importsSystem = findAll(root, 'using_directive').some((directive) => /^(?:global\s+)?using\s+System\s*;$/.test(directive.text.trim()));
  const facts = context.project ? loadProjectFacts(context.project, context.filePath) : undefined;
  const otherAliases = facts && !facts.incomplete ? facts.others.globalUsingAliases : undefined;
  const fileTypes = new Set(
    findAll(root, ['class_declaration', 'struct_declaration', 'record_declaration', 'interface_declaration', 'enum_declaration', 'delegate_declaration']).map(
      (declaration) => declaration.childForFieldName('name')?.text
    )
  );

  return findAll(root, 'member_access_expression').flatMap((access): TextEdit[] => {
    const typeOf = access.childForFieldName('expression');
    const type = typeOf?.type === 'typeof_expression' && typeOf.namedChildCount === 1 ? typeOf.namedChildren[0] : undefined;
    if (!type || access.childForFieldName('name')?.text !== 'Name' || suppressed(access) || hasParseErrors(access)) {
      return [];
    }

    if (type.type === 'predefined_type') {
      return importsSystem && CLR_NAMES[type.text] ? [{ start: access.startIndex, end: access.endIndex, text: `nameof(${CLR_NAMES[type.text]})` }] : [];
    }

    const plainName = (type.type === 'identifier' || type.type === 'qualified_name') && /^[\w.:@]+$/.test(type.text);
    const first = type.text.replace(/^global::/, '').split('.')[0];
    const mayBeOtherAlias = type.type === 'identifier' && !fileTypes.has(type.text) && (otherAliases === undefined || otherAliases.has(type.text.replace(/^@/, '')));
    if (!plainName || aliases.has(first) || mayBeOtherAlias || typeParametersAround(access).has(first)) {
      return [];
    }

    return [{ start: access.startIndex, end: access.endIndex, text: `nameof(${source.slice(type.startIndex, type.endIndex)})` }];
  });
};

function typeParametersAround(node: Node): Set<string> {
  const names = new Set<string>();
  for (let current = node.parent; current; current = current.parent) {
    for (const list of current.namedChildren.filter((child) => child.type === 'type_parameter_list')) {
      list.text
        .replace(/[<>]/g, '')
        .split(',')
        .map((part) => part.trim().split(/\s+/).pop() ?? '')
        .forEach((name) => names.add(name));
    }
  }

  return names;
}

// ---------------------------------------------------------------------------------------------
// IDE0035 Remove unreachable code
// ---------------------------------------------------------------------------------------------

const JUMPS: Record<string, true> = { return_statement: true, throw_statement: true, break_statement: true, continue_statement: true };

/**
 * Statements after a `return`, `throw`, `break` or `continue` of the same block are removed. The
 * block is left alone when that code holds a label (a `goto` target), a local function (callable
 * from before), a comment or a preprocessor directive, or declares a name used elsewhere.
 */
const collectUnreachableCode: Collect = (source, root, _context, { suppressed }) => {
  const edits: TextEdit[] = [];
  for (const block of findAll(root, 'block')) {
    const children = block.namedChildren;
    const jump = children.findIndex((child) => JUMPS[child.type] === true);
    const unreachable = jump < 0 ? [] : children.slice(jump + 1);
    if (unreachable.length === 0 || suppressed(children[jump]) || hasParseErrors(block)) {
      continue;
    }

    const start = children[jump].endIndex;
    const end = unreachable[unreachable.length - 1].endIndex;
    const unsafeToRemove = unreachable.some(
      (statement) =>
        !/_statement$/.test(statement.type) && statement.type !== 'block' ||
        statement.type === 'local_function_statement' ||
        statement.type === 'labeled_statement' ||
        statement.descendantsOfType(['labeled_statement', 'local_function_statement']).length > 0
    );
    const declared = unreachable.flatMap((statement) => statement.descendantsOfType('variable_declarator').map((declarator) => declarator.childForFieldName('name')?.text ?? ''));
    const member = enclosingMember(block);
    const usedElsewhere = declared.some((name) =>
      (member ?? root).descendantsOfType('identifier').some((identifier) => identifier.text === name && (identifier.startIndex < start || identifier.startIndex >= end))
    );
    if (unsafeToRemove || usedElsewhere || /\/\/|\/\*|^\s*#/m.test(source.slice(start, end))) {
      continue;
    }

    edits.push({ start, end, text: '' });
  }

  return edits;
};

export function enclosingMember(node: Node): Node | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (/_declaration$/.test(current.type) && current.type !== 'variable_declaration') {
      return current;
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------------------------
// IDE0080 Remove unnecessary suppression operator
// ---------------------------------------------------------------------------------------------

const NEVER_NULL: Record<string, true> = {
  string_literal: true,
  verbatim_string_literal: true,
  raw_string_literal: true,
  interpolated_string_expression: true,
  character_literal: true,
  integer_literal: true,
  real_literal: true,
  boolean_literal: true,
  object_creation_expression: true,
  implicit_object_creation_expression: true,
  this_expression: true,
};

/**
 * `x!` has no effect on a value that is never null (a literal other than `null`/`default`, `new`,
 * `this`) and as the operand of `is` (`o !is string` is `o is string`).
 */
const collectSuppressionOperators: Collect = (_source, root, _context, { suppressed }) =>
  findAll(root, 'postfix_unary_expression').flatMap((suppression): TextEdit[] => {
    const operator = suppression.children[suppression.children.length - 1];
    const operand = suppression.namedChildren[0];
    const parent = suppression.parent;
    const isOperandOfIs = parent?.type === 'is_pattern_expression' && parent.namedChildren[0] === suppression;
    if (operator?.type !== '!' || !operand || suppressed(suppression) || (!isOperandOfIs && NEVER_NULL[operand.type] !== true)) {
      return [];
    }

    return [{ start: operator.startIndex, end: operator.endIndex, text: '' }];
  });

// ---------------------------------------------------------------------------------------------
// Reported only
// ---------------------------------------------------------------------------------------------

const SUPPRESSION_SCOPES: Record<string, true> = { module: true, namespace: true, namespaceanddescendants: true, resource: true, type: true, member: true };

function globalSuppressions(root: Node): { attribute: Node; scope?: string; target?: string }[] {
  return findAll(root, 'attribute_list')
    .filter((list) => /^\[\s*assembly\s*:/.test(list.text))
    .flatMap((list) => list.namedChildren.filter((child) => child.type === 'attribute'))
    .filter((attribute) => /^(?:[\w.]+\.)?SuppressMessage(?:Attribute)?$/.test(attributeName(attribute)))
    .map((attribute) => ({
      attribute,
      scope: /\bScope\s*=\s*"([^"]*)"/.exec(attribute.text)?.[1],
      target: /\bTarget\s*=\s*"([^"]*)"/.exec(attribute.text)?.[1],
    }));
}

/** IDE0076: a global `[SuppressMessage]` with a scope the compiler does not know suppresses nothing. */
const reportInvalidSuppressions: Collect = (_source, root, _context, { report }) => {
  for (const { attribute, scope } of globalSuppressions(root)) {
    if (scope !== undefined && SUPPRESSION_SCOPES[scope.toLowerCase()] !== true) {
      report(attribute, `the global SuppressMessage has scope '${scope}', which is not valid; it was not removed, as the intended scope is unknown.`);
    }
  }

  return [];
};

/** IDE0077: targets in the legacy format (not a documentation id starting with `~`). */
const reportLegacyTargets: Collect = (_source, root, _context, { report }) => {
  for (const { attribute, target } of globalSuppressions(root)) {
    if (target !== undefined && !target.startsWith('~')) {
      report(attribute, `the target '${target}' uses the legacy format; it was not converted, as the documentation id needs the compiler's symbol information.`);
    }
  }

  return [];
};

/** IDE0050: converting an anonymous type to a tuple changes how its members are read elsewhere. */
const reportAnonymousTypes: Collect = (_source, root, _context, { report }) => {
  for (const creation of findAll(root, 'anonymous_object_creation_expression')) {
    report(creation, 'the anonymous type was not converted to a tuple: every use of its members would need to change.');
  }

  return [];
};

/** IDE0072: a switch expression over an enum of the file that misses some of its members. */
const reportMissingSwitchCases: Collect = (_source, root, _context, { report }) => {
  const enums = new Map(
    findAll(root, 'enum_declaration').map((declaration) => [
      declaration.childForFieldName('name')?.text ?? '',
      findAll(declaration, 'enum_member_declaration').map((member) => member.childForFieldName('name')?.text ?? member.namedChildren[0]?.text ?? ''),
    ])
  );
  for (const expression of findAll(root, 'switch_expression')) {
    const governing = expression.namedChildren[0];
    const enumName = governing?.type === 'identifier' ? declaredTypeText(governing) : undefined;
    const members = enumName ? enums.get(enumName) : undefined;
    const body = expression.namedChildren.find((child) => child.type === 'switch_body');
    if (!members || !body) {
      continue;
    }

    // The parser keeps arms flat: each arm's pattern is the text before its `=>`.
    const arms = splitArms(body.text.replace(/^\{|\}$/g, ''));
    const covered = arms.map((arm) => new RegExp(`^\\s*${enumName}\\.(\\w+)\\s*=>`).exec(arm)?.[1]);
    if (arms.length === 0 || covered.some((name) => name === undefined)) {
      continue;
    }

    const missing = members.filter((member) => !covered.includes(member));
    if (missing.length > 0) {
      report(expression, `the switch expression does not handle ${missing.join(', ')}; the cases were not added, as what they return is unknown.`);
    }
  }

  return [];
};

/** The arms of a switch expression body: its text split at commas outside brackets and strings. */
function splitArms(text: string): string[] {
  const arms: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const end = text.indexOf(ch, i + 1);
      if (end < 0 || text.slice(i + 1, end).includes('\\')) {
        return [];
      }

      i = end;
    } else if ('([{'.includes(ch)) {
      depth++;
    } else if (')]}'.includes(ch)) {
      depth--;
    } else if (ch === ',' && depth === 0) {
      arms.push(text.slice(start, i));
      start = i + 1;
    }
  }

  return [...arms, text.slice(start)].filter((arm) => arm.trim() !== '');
}

const HASH_CODE_OPTION = 'dotnet_prefer_system_hash_code';

/** IDE0070: a hand-written `GetHashCode` that combines values, where `HashCode.Combine` would do. */
const reportHashCodes: Rule = {
  option: HASH_CODE_OPTION,
  apply: (source, context) => {
    const option = readCodeStyleOption(context.props, HASH_CODE_OPTION, 'IDE0070');
    if (!option?.enforced || option.value !== 'true' || !source.includes('GetHashCode')) {
      return source;
    }

    const tree = parseCSharp(source);
    try {
      for (const method of findAll(tree.rootNode, 'method_declaration')) {
        const isOverride = method.namedChildren.some((child) => child.type === 'modifier' && child.text === 'override');
        const body = method.childForFieldName('body') ?? method.namedChildren.find((child) => child.type === 'arrow_expression_clause');
        if (
          method.childForFieldName('name')?.text === 'GetHashCode' &&
          isOverride &&
          body &&
          /[*^]/.test(body.text) &&
          !body.text.includes('HashCode.Combine')
        ) {
          context.report(
            describeIssue('IDE0070', HASH_CODE_OPTION, source, method.startIndex, "'GetHashCode' was not changed to use 'System.HashCode.Combine': which values it combines, and the target framework, are not certain.")
          );
        }
      }
    } finally {
      tree.delete();
    }

    return source;
  },
};

export const SIMPLIFICATION_RULES: readonly Rule[] = [
  diagnosticRule('IDE0035', collectUnreachableCode),
  diagnosticRule('IDE0100', collectEqualityOperators),
  diagnosticRule('IDE0110', collectDiscards),
  diagnosticRule('IDE0082', collectTypeofNames),
  diagnosticRule('IDE0080', collectSuppressionOperators),
  diagnosticRule('IDE0076', reportInvalidSuppressions),
  diagnosticRule('IDE0077', reportLegacyTargets),
  diagnosticRule('IDE0050', reportAnonymousTypes),
  diagnosticRule('IDE0072', reportMissingSwitchCases),
  reportHashCodes,
];
