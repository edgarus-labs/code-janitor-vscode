import { Node, applyEdits, walk } from '../parser';
import type { RuleContext } from './editorConfigCodeStyle';
import { FileView, STRING_TYPES, importsNamespace, isString, positionalArguments, viewOf } from './editorConfigQualityRulesExpressions';
import { targetFrameworksOf } from './editorConfigQualityRulesProject';
import { frameworksSupport, isRuleActive, unwrapParentheses } from './editorConfigQualityRulesSupport';

/**
 * String code-quality rules: CA1858 (StartsWith instead of IndexOf), CA1862 (case-insensitive
 * comparison without changing case), and the globalization rules CA1305, CA1307 and CA1310, which
 * are only reported: choosing a culture or a comparison changes what the code does.
 */

interface Call {
  readonly invocation: Node;
  /** `receiver.name(...)`, or `Type.name(...)` for a static call. */
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

/** The operator and the two operands of a binary expression. */
function binaryParts(node: Node): { left: Node; right: Node; operator: string } | undefined {
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  const operator = node.children.find((child) => !child.isNamed && child !== left && child !== right)?.type;

  return left && right && operator ? { left, right, operator } : undefined;
}

const comparisonName = (node: Node): string | undefined => /^(?:System\.)?StringComparison\.(\w+)$/.exec(node.text.replace(/\s+/g, ''))?.[1];

/** A static call on `string`/`String`/`System.String`. */
function isStringType(view: FileView, receiver: Node): boolean {
  const text = receiver.text.replace(/\s+/g, '');

  return text === 'string' || ((text === 'String' || text === 'System.String') && !view.types.declaresType('String'));
}

function isStringValue(view: FileView, node: Node): boolean {
  const type = view.types.typeOf(node);

  return type !== undefined && STRING_TYPES[type] === true;
}

function isCharValue(view: FileView, node: Node): boolean {
  return unwrapParentheses(node).type === 'character_literal' || view.types.typeOf(node) === 'char';
}

// ---------------------------------------------------------------------------------------------
// CA1858 Use StartsWith instead of IndexOf
// ---------------------------------------------------------------------------------------------

export function applyStartsWith(source: string, context: RuleContext): string {
  if (!isRuleActive(context, 'CA1858', source) || !/\.\s*IndexOf\s*\(/.test(source)) {
    return source;
  }

  const view = viewOf(source, context);
  const charSupport = frameworksSupport(targetFrameworksOf(context.project), 'stringCharOverloads');
  for (const binary of walk(view.model.root)) {
    const parts = binary.type === 'binary_expression' ? binaryParts(binary) : undefined;
    if (!parts || (parts.operator !== '==' && parts.operator !== '!=')) {
      continue;
    }

    const [candidate, zero] = unwrapParentheses(parts.right).text === '0' ? [parts.left, parts.right] : [parts.right, parts.left];
    const call = callOf(unwrapParentheses(candidate));
    if (!call || call.name !== 'IndexOf' || unwrapParentheses(zero).text !== '0' || !isString(view, call.receiver) || view.suppressions.isSuppressed('CA1858', binary)) {
      continue;
    }

    const [value, comparison] = call.args;
    const ordinalComparison = comparison !== undefined && /^Ordinal(?:IgnoreCase)?$/.test(comparisonName(comparison) ?? '');
    const charValue = value !== undefined && isCharValue(view, value);
    let problem: string | undefined;
    if (call.args.length === 1 && charValue) {
      problem = charSupport === false ? undefined : charSupport === undefined ? "the project's target framework is unknown, so StartsWith(char) may not exist" : undefined;
      if (charSupport === false) {
        continue;
      }
    } else if (call.args.length === 2 && ordinalComparison && value && isStringValue(view, value)) {
      problem = undefined;
    } else if (call.args.length === 1 || (call.args.length === 2 && comparisonName(comparison) !== undefined)) {
      problem = 'it compares by culture, where ignorable characters can make StartsWith differ';
    } else {
      continue;
    }

    if (problem) {
      view.report('CA1858', binary, `${binary.text} tests for a prefix, but ${problem}; it was kept.`);
      continue;
    }

    const replacement = `${parts.operator === '!=' ? '!' : ''}${call.receiver.text}.StartsWith(${call.args.map((arg) => arg.text).join(', ')})`;
    view.edits.push({ start: binary.startIndex, end: binary.endIndex, text: replacement });
  }

  return applyEdits(source, view.edits);
}

// ---------------------------------------------------------------------------------------------
// CA1862 Use the 'StringComparison' method overloads to perform case-insensitive string comparisons
// ---------------------------------------------------------------------------------------------

const CASE_CHANGES = new Set(['ToLower', 'ToUpper', 'ToLowerInvariant', 'ToUpperInvariant']);

/** `x.ToLower()` and its kin: the call, when `node` is one. */
function caseChange(node: Node): Call | undefined {
  const call = callOf(unwrapParentheses(node));

  return call && CASE_CHANGES.has(call.name) && call.args.length <= 1 ? call : undefined;
}

/** A regular string literal of printable ASCII that `ToUpperInvariant` leaves as it is. */
function isUpperAsciiLiteral(node: Node): boolean {
  const literal = unwrapParentheses(node);

  return literal.type === 'string_literal' && /^"[\x20-\x21\x23-\x5B\x5D-\x7E]*"$/.test(literal.text) && literal.text === literal.text.toUpperCase();
}

export function applyCaseInsensitiveComparison(source: string, context: RuleContext): string {
  if (!isRuleActive(context, 'CA1862', source) || !/\.\s*To(?:Lower|Upper)(?:Invariant)?\s*\(/.test(source)) {
    return source;
  }

  const view = viewOf(source, context);
  let systemPrefix: string | undefined;
  for (const binary of walk(view.model.root)) {
    const parts = binary.type === 'binary_expression' ? binaryParts(binary) : undefined;
    if (!parts || (parts.operator !== '==' && parts.operator !== '!=')) {
      continue;
    }

    const leftCase = caseChange(parts.left);
    const rightCase = caseChange(parts.right);
    const changed = leftCase ?? rightCase;
    if (!changed || view.suppressions.isSuppressed('CA1862', binary)) {
      continue;
    }

    const other = leftCase ? parts.right : parts.left;
    const fixable = !(leftCase && rightCase) && changed.name === 'ToUpperInvariant' && changed.args.length === 0 && isUpperAsciiLiteral(other) && isString(view, changed.receiver);
    if (!fixable) {
      view.report('CA1862', binary, `${binary.text} changes case to compare, but no StringComparison compares exactly like ${changed.name}; it was kept.`);
      continue;
    }

    systemPrefix ??= importsNamespace(view, context, 'System') ? '' : 'System.';
    const equals = `string.Equals(${changed.receiver.text}, ${unwrapParentheses(other).text}, ${systemPrefix}StringComparison.OrdinalIgnoreCase)`;
    view.edits.push({ start: binary.startIndex, end: binary.endIndex, text: `${parts.operator === '!=' ? '!' : ''}${equals}` });
  }

  return applyEdits(source, view.edits);
}

// ---------------------------------------------------------------------------------------------
// CA1305 Specify IFormatProvider, CA1307 Specify StringComparison for clarity,
// CA1310 Specify StringComparison for correctness (reported only)
// ---------------------------------------------------------------------------------------------

/** Types whose `ToString()`/`ToString(format)` and `Parse(s)` have an `IFormatProvider` overload. */
const FORMATTABLE_TYPES = new Set([
  'byte', 'sbyte', 'short', 'ushort', 'int', 'uint', 'long', 'ulong', 'float', 'double', 'decimal',
  'Byte', 'SByte', 'Int16', 'UInt16', 'Int32', 'UInt32', 'Int64', 'UInt64', 'Single', 'Double', 'Decimal',
  'DateTime', 'DateTimeOffset', 'TimeSpan',
]);

/** Instance methods of `string` that compare with the current culture unless told otherwise. */
const CULTURE_METHODS = new Set(['StartsWith', 'EndsWith', 'IndexOf', 'LastIndexOf', 'CompareTo']);

export function reportGlobalization(source: string, context: RuleContext): string {
  const active = ['CA1305', 'CA1307', 'CA1310'].filter((id) => isRuleActive(context, id, source));
  if (active.length === 0) {
    return source;
  }

  const view = viewOf(source, context);
  const frameworks = targetFrameworksOf(context.project);
  const charSupport = frameworksSupport(frameworks, 'stringCharOverloads') === true;
  const replaceSupport = frameworksSupport(frameworks, 'coreApis') === true;
  const report = (id: string, call: Call, message: string): void => {
    if (active.includes(id) && !view.suppressions.isSuppressed(id, call.invocation)) {
      view.report(id, call.invocation, `${call.invocation.text} ${message}; it was not changed, because choosing one changes what the code does.`);
    }
  };

  for (const node of walk(view.model.root)) {
    const call = callOf(node);
    if (!call) {
      continue;
    }

    const [first, second] = call.args;
    const staticString = isStringType(view, call.receiver);
    const instanceString = !staticString && isString(view, call.receiver);
    const noComparison = !call.args.some((arg) => comparisonName(arg) !== undefined);

    // CA1310 / CA1307: comparisons without a StringComparison.
    if (noComparison) {
      const cultureCompare =
        (staticString && call.name === 'Compare' && (call.args.length === 2 || call.args.length === 3 || call.args.length === 5 || call.args.length === 6)) ||
        (instanceString && CULTURE_METHODS.has(call.name) && first !== undefined && isStringValue(view, first) && call.args.length <= 3);
      const ordinalCompare =
        (staticString && call.name === 'Equals' && call.args.length === 2 && isStringValue(view, first) && isStringValue(view, second)) ||
        (instanceString && call.name === 'Equals' && call.args.length === 1 && isStringValue(view, first)) ||
        (instanceString && call.name === 'Contains' && call.args.length === 1 && charSupport) ||
        (instanceString && (call.name === 'IndexOf' || call.name === 'LastIndexOf') && call.args.length === 1 && isCharValue(view, first) && charSupport) ||
        (instanceString && call.name === 'Replace' && call.args.length === 2 && isStringValue(view, first) && replaceSupport);
      if (cultureCompare) {
        report('CA1310', call, 'compares strings with the current culture without a StringComparison');
      }

      if (cultureCompare || ordinalCompare) {
        report('CA1307', call, 'compares strings without a StringComparison');
      }
    }

    // CA1305: formatting and parsing without an IFormatProvider.
    const receiverType = view.types.typeOf(call.receiver);
    const formattable = (type: string | undefined): boolean => type !== undefined && FORMATTABLE_TYPES.has(type) && (/^[a-z]/.test(type) || !view.types.declaresType(type));
    const staticType = call.receiver.text.replace(/^System\./, '');
    const providerMissing =
      (call.name === 'ToString' && formattable(receiverType) && (call.args.length === 0 || (call.args.length === 1 && isStringValue(view, first)))) ||
      (call.name === 'Parse' && formattable(staticType) && call.args.length === 1 && isStringValue(view, first)) ||
      (staticString && call.name === 'Format' && first !== undefined && isStringValue(view, first));
    if (providerMissing) {
      report('CA1305', call, 'formats or parses with the current culture without an IFormatProvider');
    }
  }

  return source;
}
