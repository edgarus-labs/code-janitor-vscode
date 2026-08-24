import { Node } from 'web-tree-sitter';
import { TextEdit, applyEdits, findAll, parseCSharp } from '../parser';
import { SourceTransformation } from '../types';

const STRING_FORMAT_RECEIVERS = new Set(['string', 'String', 'System.String']);
const PLACEHOLDER = /\{(\d+)(?:,(-?\d+))?(?::([^}]+))?\}/g;

/** Converts `string.Format` calls with a literal format string into an interpolated string. */
export const stringInterpolationConverter: SourceTransformation = {
  name: 'Convert string.Format to String Interpolation',
  apply(source: string): string {
    if (!source || !source.trim()) {
      return source;
    }

    const tree = parseCSharp(source);

    try {
      const edits: TextEdit[] = [];

      for (const invocation of findAll(tree.rootNode, 'invocation_expression')) {
        const replacement = tryBuildInterpolatedString(invocation);
        if (replacement !== undefined) {
          edits.push({ start: invocation.startIndex, end: invocation.endIndex, text: replacement });
        }
      }

      return applyEdits(source, edits);
    } finally {
      tree.delete();
    }
  },
};

function tryBuildInterpolatedString(invocation: Node): string | undefined {
  const target = invocation.childForFieldName('function');
  if (target?.type !== 'member_access_expression') {
    return undefined;
  }

  if (target.childForFieldName('name')?.text !== 'Format') {
    return undefined;
  }

  const receiver = target.childForFieldName('expression')?.text;
  if (!receiver || !STRING_FORMAT_RECEIVERS.has(receiver)) {
    return undefined;
  }

  const args = invocation.childForFieldName('arguments')?.namedChildren.filter((c) => c?.type === 'argument') ?? [];
  if (args.length < 2) {
    return undefined;
  }

  const formatLiteral = args[0]!.namedChild(0);
  if (formatLiteral?.type !== 'string_literal' && formatLiteral?.type !== 'verbatim_string_literal') {
    return undefined;
  }

  const formatString = stringLiteralValue(formatLiteral);
  if (formatString === undefined) {
    return undefined;
  }

  const formatArgs = args.slice(1).map((argument) => argument!.namedChild(argument!.namedChildCount - 1)?.text ?? '');

  PLACEHOLDER.lastIndex = 0;
  const matches = [...formatString.matchAll(PLACEHOLDER)];
  if (matches.length === 0) {
    return undefined;
  }

  if (matches.some((match) => Number.parseInt(match[1], 10) >= formatArgs.length)) {
    return undefined;
  }

  let result = '$"';
  let lastIndex = 0;

  for (const match of matches) {
    const matchIndex = match.index ?? 0;
    if (matchIndex > lastIndex) {
      result += escapeForInterpolatedString(formatString.slice(lastIndex, matchIndex));
    }

    const alignment = match[2] !== undefined ? `,${match[2]}` : '';
    const formatSpecifier = match[3] !== undefined ? `:${match[3]}` : '';
    result += `{${formatArgs[Number.parseInt(match[1], 10)]}${alignment}${formatSpecifier}}`;
    lastIndex = matchIndex + match[0].length;
  }

  if (lastIndex < formatString.length) {
    result += escapeForInterpolatedString(formatString.slice(lastIndex));
  }

  return `${result}"`;
}

function escapeForInterpolatedString(text: string): string {
  return text.replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
}

/** The decoded value of a C# string literal token, or `undefined` when it cannot be decoded. */
function stringLiteralValue(literal: Node): string | undefined {
  const text = literal.text;

  if (text.startsWith('@"') && text.endsWith('"')) {
    return text.slice(2, -1).replace(/""/g, '"');
  }

  if (!text.startsWith('"') || !text.endsWith('"') || text.length < 2) {
    return undefined;
  }

  const inner = text.slice(1, -1);
  let value = '';

  for (let i = 0; i < inner.length; i++) {
    if (inner[i] !== '\\') {
      value += inner[i];
      continue;
    }

    const escape = inner[++i];
    switch (escape) {
      case 'n':
        value += '\n';
        break;
      case 'r':
        value += '\r';
        break;
      case 't':
        value += '\t';
        break;
      case '0':
        value += '\0';
        break;
      case '\\':
      case '"':
      case "'":
        value += escape;
        break;
      case 'u': {
        const code = Number.parseInt(inner.slice(i + 1, i + 5), 16);
        if (Number.isNaN(code)) {
          return undefined;
        }

        value += String.fromCharCode(code);
        i += 4;
        break;
      }

      default:
        return undefined;
    }
  }

  return value;
}

/**
 * Converts `List<T>` and array initializations to C# 12 collection expressions (`[]` / `[a, b]`)
 * when the declared type is explicit and textually matches the created type.
 */
export const collectionExpressionConverter: SourceTransformation = {
  name: 'Collection Expression',
  apply(source: string): string {
    if (!source) {
      return source;
    }

    const tree = parseCSharp(source);

    try {
      const edits: TextEdit[] = [];

      for (const declarator of findAll(tree.rootNode, 'variable_declarator')) {
        const declaration = declarator.parent;
        if (declaration?.type !== 'variable_declaration') {
          continue;
        }

        collectEdit(declaration.childForFieldName('type'), initializerValue(declarator), edits);
      }

      for (const property of findAll(tree.rootNode, 'property_declaration')) {
        collectEdit(property.childForFieldName('type'), propertyInitializer(property), edits);
      }

      return applyEdits(source, edits);
    } finally {
      tree.delete();
    }
  },
};

function collectEdit(declaredType: Node | null, initializer: Node | undefined, edits: TextEdit[]): void {
  if (!declaredType || !initializer) {
    return;
  }

  const replacement = tryConvertToCollectionExpression(declaredType, initializer);
  if (replacement !== undefined) {
    edits.push({ start: initializer.startIndex, end: initializer.endIndex, text: replacement });
  }
}

function initializerValue(node: Node): Node | undefined {
  const clause = node.namedChildren.find((child) => child?.type === 'equals_value_clause');

  return clause?.namedChild(clause.namedChildCount - 1) ?? undefined;
}

/** The `value` field also carries `=> expression` bodies, which are not initializers. */
function propertyInitializer(property: Node): Node | undefined {
  const value = property.childForFieldName('value');

  return value && value.type !== 'arrow_expression_clause' ? value : undefined;
}

function tryConvertToCollectionExpression(declaredType: Node, initializer: Node): string | undefined {
  switch (initializer.type) {
    case 'object_creation_expression':
      return tryConvertObjectCreation(declaredType, initializer);

    case 'array_creation_expression':
      return tryConvertArrayCreation(declaredType, initializer);

    case 'implicit_array_creation_expression':
      return declaredType.type === 'array_type' ? buildCollectionExpression(initializerElements(initializer)) : undefined;

    default:
      return undefined;
  }
}

function tryConvertObjectCreation(declaredType: Node, creation: Node): string | undefined {
  const args = creation.childForFieldName('arguments');
  if (args && args.namedChildren.some((child) => child?.type === 'argument')) {
    return undefined;
  }

  const createdType = creation.childForFieldName('type');
  if (!createdType || !isSupportedListType(createdType) || createdType.text !== declaredType.text) {
    return undefined;
  }

  return buildCollectionExpression(initializerElements(creation));
}

function tryConvertArrayCreation(declaredType: Node, creation: Node): string | undefined {
  if (declaredType.type !== 'array_type') {
    return undefined;
  }

  const createdArrayType = creation.namedChildren.find((child) => child?.type === 'array_type');
  if (!createdArrayType || declaredType.childForFieldName('type')?.text !== createdArrayType.childForFieldName('type')?.text) {
    return undefined;
  }

  const initializer = creation.namedChildren.find((child) => child?.type === 'initializer_expression');
  if (initializer) {
    return buildCollectionExpression(initializer.namedChildren.filter((child): child is Node => Boolean(child)));
  }

  // Without an initializer only an explicitly zero-length array is safe: `new T[5]` differs.
  const rank = createdArrayType.childForFieldName('rank');
  const size = rank?.namedChild(0);
  if (!size) {
    return undefined;
  }

  return size.type === 'integer_literal' && size.text === '0' ? '[]' : undefined;
}

function initializerElements(creation: Node): Node[] {
  const initializer =
    creation.childForFieldName('initializer') ??
    creation.namedChildren.find((child) => child?.type === 'initializer_expression');

  return initializer?.namedChildren.filter((child): child is Node => Boolean(child)) ?? [];
}

function isSupportedListType(type: Node): boolean {
  return type.type === 'generic_name' && type.namedChild(0)?.text === 'List';
}

function buildCollectionExpression(elements: readonly Node[]): string {
  return `[${elements.map((element) => element.text).join(', ')}]`;
}
