import { Node, TextEdit, applyEdits, findAll, parseCSharp } from '../parser';
import { SourceTransformation } from '../types';

const BLOCKING_MODIFIERS = new Set(['sealed', 'abstract', 'static', 'partial']);
const NAMESPACE_TYPES = new Set(['namespace_declaration', 'file_scoped_namespace_declaration']);

/**
 * Adds the `sealed` modifier to classes only when provably safe from a single syntax tree.
 *
 * Sealing changes the public API surface (CA1852), so this is deliberately conservative: only
 * top-level classes and records are considered, and only when no other type declared in the same
 * file derives from them. Nested and partial types are left untouched.
 */
export const sealedClassConverter: SourceTransformation = {
  name: 'Sealed Class',
  apply(source: string): string {
    if (!source) {
      return source;
    }

    const tree = parseCSharp(source);

    try {
      const derivedFromNames = new Set<string>();
      for (const baseList of findAll(tree.rootNode, 'base_list')) {
        for (const baseType of baseList.namedChildren) {
          if (baseType) {
            derivedFromNames.add(simpleName(baseType));
          }
        }
      }

      const edits: TextEdit[] = [];

      for (const declaration of findAll(tree.rootNode, ['class_declaration', 'record_declaration'])) {
        if (!isEligibleForSealing(declaration) || !isTopLevel(declaration)) {
          continue;
        }

        if (!isSafeToSeal(declaration, derivedFromNames)) {
          continue;
        }

        const keyword = typeKeyword(declaration);
        if (keyword) {
          edits.push({ start: keyword.startIndex, end: keyword.startIndex, text: 'sealed ' });
        }
      }

      return applyEdits(source, edits);
    } finally {
      tree.delete();
    }
  },
};

function isEligibleForSealing(declaration: Node): boolean {
  if (declaration.type === 'class_declaration') {
    return true;
  }

  return !declaration.children.some((child) => child?.type === 'struct');
}

function isTopLevel(declaration: Node): boolean {
  const parent = declaration.parent;
  if (!parent) {
    return false;
  }

  // A file-scoped namespace holds its members directly; a block-scoped one wraps them in a body.
  if (parent.type === 'compilation_unit' || NAMESPACE_TYPES.has(parent.type)) {
    return true;
  }

  return parent.type === 'declaration_list' && parent.parent !== null && NAMESPACE_TYPES.has(parent.parent.type);
}

function isSafeToSeal(declaration: Node, derivedFromNames: ReadonlySet<string>): boolean {
  const hasBlockingModifier = declaration.namedChildren.some(
    (child) => child?.type === 'modifier' && BLOCKING_MODIFIERS.has(child.text)
  );

  if (hasBlockingModifier) {
    return false;
  }

  const name = declaration.childForFieldName('name')?.text;

  return name !== undefined && !derivedFromNames.has(name);
}

function typeKeyword(declaration: Node): Node | undefined {
  const keyword = declaration.type === 'class_declaration' ? 'class' : 'record';

  return declaration.children.find((child): child is Node => child?.type === keyword) ?? undefined;
}

/** Recursively extracts the rightmost simple identifier of a (possibly qualified) type name. */
function simpleName(type: Node): string {
  switch (type.type) {
    case 'identifier':
      return type.text;

    case 'generic_name':
      return type.namedChild(0)?.text ?? type.text;

    case 'qualified_name':
    case 'alias_qualified_name': {
      const right = type.childForFieldName('name') ?? type.namedChild(type.namedChildCount - 1);

      return right ? simpleName(right) : type.text;
    }

    default: {
      const first = type.namedChild(0);

      return first && first.type !== type.type ? simpleName(first) : type.text;
    }
  }
}
