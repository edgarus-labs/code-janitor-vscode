import { Node, TextEdit, applyEdits, findAll, parseCSharp, walk } from '../parser';
import { SourceTransformation } from '../types';

const NAMESPACE_TYPES = ['namespace_declaration', 'file_scoped_namespace_declaration'];

/** Updates the single top-level namespace declaration to match an expected namespace. */
export function fixNamespace(source: string, expectedNamespace: string): string {
  if (!source || !source.trim() || !expectedNamespace || !expectedNamespace.trim()) {
    return source;
  }

  const tree = parseCSharp(source);

  try {
    const namespaces = findAll(tree.rootNode, NAMESPACE_TYPES).filter(
      (node) => node.parent?.type === 'compilation_unit'
    );

    if (namespaces.length !== 1) {
      return source;
    }

    const name = namespaces[0].childForFieldName('name');
    if (!name || name.text === expectedNamespace) {
      return source;
    }

    return source.slice(0, name.startIndex) + expectedNamespace + source.slice(name.endIndex);
  } finally {
    tree.delete();
  }
}

const TARGET_EXCEPTION_TYPES = new Set([
  'ArgumentNullException',
  'ArgumentException',
  'ArgumentOutOfRangeException',
  'InvalidEnumArgumentException',
]);

const VALID_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Converts string literals that name a parameter in scope into `nameof(...)` expressions, inside
 * the argument-validation exception constructors.
 */
export const nameOfOperatorConverter: SourceTransformation = {
  name: 'Convert String Literals to nameof(...)',
  apply(source: string): string {
    if (!source || !source.trim()) {
      return source;
    }

    const tree = parseCSharp(source);

    try {
      const edits: TextEdit[] = [];

      for (const creation of findAll(tree.rootNode, 'object_creation_expression')) {
        const typeName = creation.childForFieldName('type')?.text;
        if (!typeName) {
          continue;
        }

        const simpleTypeName = typeName.includes('.') ? typeName.slice(typeName.lastIndexOf('.') + 1) : typeName;
        if (!TARGET_EXCEPTION_TYPES.has(simpleTypeName)) {
          continue;
        }

        const argumentList = creation.childForFieldName('arguments');
        const args = argumentList?.namedChildren.filter((child) => child?.type === 'argument') ?? [];
        if (args.length === 0) {
          continue;
        }

        const availableIdentifiers = getAvailableIdentifiers(creation);
        if (availableIdentifiers.size === 0) {
          continue;
        }

        for (const argument of args) {
          const literal = argument!.namedChildren.find((child) => child?.type === 'string_literal');
          if (!literal) {
            continue;
          }

          const value = stringLiteralValue(literal);
          if (!value || !VALID_IDENTIFIER.test(value) || !availableIdentifiers.has(value)) {
            continue;
          }

          edits.push({ start: literal.startIndex, end: literal.endIndex, text: `nameof(${value})` });
        }
      }

      return applyEdits(source, edits);
    } finally {
      tree.delete();
    }
  },
};

function stringLiteralValue(literal: Node): string | undefined {
  const text = literal.text;

  if (text.startsWith('@"') && text.endsWith('"')) {
    return text.slice(2, -1).replace(/""/g, '"');
  }

  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    const inner = text.slice(1, -1);

    return inner.includes('\\') ? undefined : inner;
  }

  return undefined;
}

function getAvailableIdentifiers(node: Node): Set<string> {
  const identifiers = new Set<string>();

  for (let current = node.parent; current; current = current.parent) {
    for (const parameterName of parameterNames(current)) {
      identifiers.add(parameterName);
    }
  }

  return identifiers;
}

function parameterNames(node: Node): string[] {
  switch (node.type) {
    case 'method_declaration':
    case 'constructor_declaration':
    case 'local_function_statement': {
      const list = node.childForFieldName('parameters');

      return list ? collectParameterNames(list) : [];
    }

    case 'lambda_expression': {
      const parameters = node.childForFieldName('parameters');
      if (parameters) {
        return parameters.type === 'identifier' ? [parameters.text] : collectParameterNames(parameters);
      }

      const first = node.namedChild(0);

      return first?.type === 'identifier' ? [first.text] : first ? collectParameterNames(first) : [];
    }

    default:
      return [];
  }
}

function collectParameterNames(parameterList: Node): string[] {
  const names: string[] = [];

  for (const node of walk(parameterList)) {
    if (node.type !== 'parameter') {
      continue;
    }

    const name = node.childForFieldName('name');
    if (name) {
      names.push(name.text);
    }
  }

  return names;
}
