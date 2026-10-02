import { Node, TextEdit, applyEdits, findAll, parseCSharp } from '../parser';
import { interpolationAccessesMember, interpolationWritesName } from './interpolation';
import { SourceTransformation } from '../types';
import { hasModifier } from './editorConfigSupport';

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

function isSafeToMakeReadonly(typeDeclaration: Node, field: Node): boolean {
  const declaration = field.namedChildren.find((child) => child?.type === 'variable_declaration');
  const declarators = declaration?.namedChildren.filter((child) => child?.type === 'variable_declarator') ?? [];
  if (declarators.length !== 1) {
    return false;
  }

  if (['readonly', 'const', 'volatile'].some((name) => hasModifier(field, name))) {
    return false;
  }

  // Writes to non-private fields cannot be ruled out from a single file.
  if (['public', 'internal', 'protected'].some((name) => hasModifier(field, name))) {
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

      case 'interpolated_string_expression': {
        // The parser reads the whole literal as one node: a write inside a hole is only visible in its text.
        if (interpolationWritesName(node.text, fieldName)) {
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

      case 'postfix_unary_expression': {
        if (!node.children.some((child) => child?.type === '++' || child?.type === '--')) {
          break;
        }

        const operand = node.namedChild(0);
        if (operand && fieldAccessKind(operand, fieldName) !== FieldAccess.None) {
          writes.push(node);
        }

        break;
      }

      case 'prefix_unary_expression': {
        // `&x` and `++x`/`--x` share this node type; only the token child tells them apart.
        const isIncrementOrDecrement = node.children.some((child) => child?.type === '++' || child?.type === '--');
        const isAddressOf = node.children.some((child) => child?.type === '&');
        if (!isIncrementOrDecrement && !isAddressOf) {
          break;
        }

        const operand = node.namedChild(0);
        if (!operand || fieldAccessKind(operand, fieldName) === FieldAccess.None) {
          break;
        }

        if (isAddressOf) {
          // Taking a field's address can expose it to arbitrary pointer writes that this
          // single-file analysis cannot rule out, so it unconditionally disqualifies `readonly`.
          return false;
        }

        writes.push(node);

        break;
      }
    }
  }

  if (!writes.every((write) => isWriteInMatchingConstructor(write, typeDeclaration, isStatic))) {
    return false;
  }

  // Outside its constructor, a readonly field of a mutable struct is copied before each member
  // access, so a call that changed it would change the copy instead
  // (https://learn.microsoft.com/dotnet/csharp/language-reference/keywords/readonly#readonly-field-example).
  // Unless the field's type is known to be a reference type, it must not be accessed that way,
  // inside an interpolation hole (only visible in the literal's text) either.
  const type = declaration?.childForFieldName('type')?.text.replace(/\s+/g, '') ?? '';
  let root: Node = typeDeclaration;
  while (root.parent) {
    root = root.parent;
  }

  return (
    isKnownReferenceType(type, root) ||
    ![...scopeNodes(typeDeclaration)].some(
      (node) =>
        (node.type === 'interpolated_string_expression'
          ? interpolationAccessesMember(node.text, fieldName)
          : (node.type === 'member_access_expression' || node.type === 'element_access_expression' || node.type === 'conditional_access_expression') &&
            fieldAccessKind(node.childForFieldName('expression') ?? node.namedChild(0)!, fieldName) === FieldAccess.Direct) &&
        !isWriteInMatchingConstructor(node, typeDeclaration, isStatic)
    )
  );
}

/** Reference types whose members cannot change a field holding them: known framework types and the file's own. */
const KNOWN_REFERENCE_TYPES =
  /^(?:(?:System\.)?(?:string|object|String|Object|Random|Exception|Type|Uri|Task|StringBuilder|Stopwatch|SemaphoreSlim|CancellationTokenSource|HttpClient|Regex|Timer)|(?:List|Dictionary|HashSet|Queue|Stack|SortedDictionary|SortedList|SortedSet|LinkedList|ConcurrentDictionary|ConcurrentQueue|ConcurrentBag|Lazy|Func|Action|Task|ObservableCollection|Collection|WeakReference)<.+>|I[A-Z]\w*(?:<.+>)?|.+\[\])\??$/;

function isKnownReferenceType(type: string, root: Node): boolean {
  if (KNOWN_REFERENCE_TYPES.test(type)) {
    return true;
  }

  const name = type.replace(/\?$/, '').replace(/<.*>$/, '');

  return findAll(root, ['class_declaration', 'interface_declaration', 'delegate_declaration', 'record_declaration']).some(
    (declaration) => declaration.childForFieldName('name')?.text === name && !declaration.children.some((child) => child.type === 'struct')
  );
}

/** Every descendant of the type, including any nested type declarations it contains. */
function* scopeNodes(typeDeclaration: Node): Generator<Node> {
  function* visit(node: Node): Generator<Node> {
    yield node;

    for (const child of node.namedChildren) {
      if (child) {
        yield* visit(child);
      }
    }
  }

  yield* visit(typeDeclaration);
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
