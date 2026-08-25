import { Node, TextEdit, applyEdits, findAll, parseCSharp } from '../parser';
import { SourceTransformation } from '../types';

const TYPE_DECLARATIONS = new Set([
  'class_declaration',
  'struct_declaration',
  'record_declaration',
  'interface_declaration',
]);

const MEMBER_BOUNDARIES = new Set([
  'lambda_expression',
  'anonymous_method_expression',
  'local_function_statement',
  'method_declaration',
  'accessor_declaration',
  'destructor_declaration',
  'operator_declaration',
  'conversion_operator_declaration',
]);

const enum FieldAccess {
  None,
  Direct,
  SubMember,
}

/**
 * Adds the `readonly` modifier to fields only when provably safe from a single syntax tree.
 *
 * Deliberately conservative: only private fields of non-partial types with a single declarator are
 * considered, and only when every write happens directly in the declaring type's own constructor
 * (instance fields) or static constructor (static fields) - never in a method, accessor, local
 * function or lambda, which could run after construction.
 */
export const readonlyFieldConverter: SourceTransformation = {
  name: 'Readonly Field',
  apply(source: string): string {
    if (!source) {
      return source;
    }

    const tree = parseCSharp(source);

    try {
      const edits: TextEdit[] = [];

      for (const typeDeclaration of findAll(tree.rootNode, [...TYPE_DECLARATIONS])) {
        if (hasModifier(typeDeclaration, 'partial')) {
          continue;
        }

        for (const field of directFields(typeDeclaration)) {
          if (!isSafeToMakeReadonly(typeDeclaration, field)) {
            continue;
          }

          const declaration = field.namedChildren.find((child) => child?.type === 'variable_declaration');
          const type = declaration?.childForFieldName('type');
          if (type) {
            edits.push({ start: type.startIndex, end: type.startIndex, text: 'readonly ' });
          }
        }
      }

      return applyEdits(source, edits);
    } finally {
      tree.delete();
    }
  },
};

function directFields(typeDeclaration: Node): Node[] {
  const body = typeDeclaration.childForFieldName('body');

  return (body?.namedChildren ?? []).filter((child): child is Node => child?.type === 'field_declaration');
}

function hasModifier(node: Node, ...names: readonly string[]): boolean {
  return node.namedChildren.some((child) => child?.type === 'modifier' && names.includes(child.text));
}

function isSafeToMakeReadonly(typeDeclaration: Node, field: Node): boolean {
  const declaration = field.namedChildren.find((child) => child?.type === 'variable_declaration');
  const declarators = declaration?.namedChildren.filter((child) => child?.type === 'variable_declarator') ?? [];
  if (declarators.length !== 1) {
    return false;
  }

  if (hasModifier(field, 'readonly', 'const', 'volatile')) {
    return false;
  }

  // Writes to non-private fields cannot be ruled out from a single file.
  if (hasModifier(field, 'public', 'internal', 'protected')) {
    return false;
  }

  const isStatic = hasModifier(field, 'static');
  const fieldName = (declarators[0]!.childForFieldName('name') ?? declarators[0]!.namedChild(0))?.text;
  if (!fieldName) {
    return false;
  }

  const writes: Node[] = [];

  for (const node of scopeNodes(typeDeclaration)) {
    switch (node.type) {
      case 'argument': {
        const isByReference = node.children.some((child) => child?.type === 'ref' || child?.type === 'out');
        const expression = node.namedChild(node.namedChildCount - 1);
        if (isByReference && expression && fieldAccessKind(expression, fieldName) !== FieldAccess.None) {
          return false;
        }

        break;
      }

      case 'ref_expression': {
        const expression = node.namedChild(0);
        if (expression && fieldAccessKind(expression, fieldName) !== FieldAccess.None) {
          return false;
        }

        break;
      }

      case 'assignment_expression': {
        const left = node.childForFieldName('left');
        if (left && fieldAccessKind(left, fieldName) !== FieldAccess.None) {
          writes.push(node);
        }

        break;
      }

      case 'postfix_unary_expression':
      case 'prefix_unary_expression': {
        if (!node.children.some((child) => child?.type === '++' || child?.type === '--')) {
          break;
        }

        const operand = node.namedChild(0);
        if (operand && fieldAccessKind(operand, fieldName) !== FieldAccess.None) {
          writes.push(node);
        }

        break;
      }
    }
  }

  return writes.every((write) => isWriteInMatchingConstructor(write, typeDeclaration, isStatic));
}

/** Every descendant of the type, without descending into nested type declarations. */
function* scopeNodes(typeDeclaration: Node): Generator<Node> {
  function* visit(node: Node, isRoot: boolean): Generator<Node> {
    yield node;

    if (!isRoot && TYPE_DECLARATIONS.has(node.type)) {
      return;
    }

    for (const child of node.namedChildren) {
      if (child) {
        yield* visit(child, false);
      }
    }
  }

  yield* visit(typeDeclaration, true);
}

function fieldAccessKind(expression: Node, fieldName: string): FieldAccess {
  let current: Node | null = expression;
  while (current?.type === 'parenthesized_expression') {
    current = current.namedChild(0);
  }

  if (!current) {
    return FieldAccess.None;
  }

  if (current.type === 'identifier') {
    return current.text === fieldName ? FieldAccess.Direct : FieldAccess.None;
  }

  if (current.type === 'member_access_expression') {
    if (current.childForFieldName('name')?.text === fieldName) {
      return FieldAccess.Direct;
    }

    const receiver = current.childForFieldName('expression');

    return receiver && fieldAccessKind(receiver, fieldName) !== FieldAccess.None
      ? FieldAccess.SubMember
      : FieldAccess.None;
  }

  if (current.type === 'element_access_expression' || current.type === 'conditional_access_expression') {
    const receiver = current.childForFieldName('expression') ?? current.namedChild(0);

    return receiver && fieldAccessKind(receiver, fieldName) !== FieldAccess.None
      ? FieldAccess.SubMember
      : FieldAccess.None;
  }

  return FieldAccess.None;
}

function isWriteInMatchingConstructor(write: Node, typeDeclaration: Node, isStatic: boolean): boolean {
  for (let ancestor = write.parent; ancestor; ancestor = ancestor.parent) {
    if (MEMBER_BOUNDARIES.has(ancestor.type)) {
      return false;
    }

    if (ancestor.type === 'constructor_declaration') {
      const declaringType = ancestor.parent?.parent;

      return declaringType?.id === typeDeclaration.id && hasModifier(ancestor, 'static') === isStatic;
    }

    if (TYPE_DECLARATIONS.has(ancestor.type)) {
      return false;
    }
  }

  return false;
}

/**
 * Spreads a single-line method body onto multiple lines, putting each statement on its own line.
 * Unlike the original, the file's own line ending is used instead of a hard-coded CRLF.
 */
export const updateSingleLineMethodsConverter: SourceTransformation = {
  name: 'Update single-line methods',
  apply(source: string): string {
    if (!source) {
      return source;
    }

    const tree = parseCSharp(source);

    try {
      const newline = source.includes('\r\n') ? '\r\n' : '\n';
      const edits: TextEdit[] = [];

      for (const method of findAll(tree.rootNode, 'method_declaration')) {
        if (hasModifier(method, 'abstract')) {
          continue;
        }

        const body = method.childForFieldName('body');
        if (!body || body.type !== 'block') {
          continue;
        }

        const statements = body.namedChildren.filter(
          (child): child is Node => Boolean(child) && !child!.type.startsWith('preproc')
        );

        if (statements.length === 0 || source.slice(body.startIndex, body.endIndex).includes('\n')) {
          continue;
        }

        const lines = ['{', ...statements.map((statement) => `    ${statement.text.trim()}`), '}'];
        edits.push({ start: body.startIndex, end: body.endIndex, text: lines.join(newline) });
      }

      return applyEdits(source, edits);
    } finally {
      tree.delete();
    }
  },
};
