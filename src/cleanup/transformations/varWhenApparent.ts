import { Node } from 'web-tree-sitter';
import { TextEdit, applyEdits, findAll, parseCSharp } from '../parser';
import { SourceTransformation } from '../types';

/**
 * Converts explicitly-typed local declarations to `var` only when the type is apparent from the
 * right-hand side and textually matches the declared type.
 *
 * The match is textual rather than semantic, so the transformation is safe without a full
 * compilation: `IFoo x = new Foo()` is left unchanged because the declared type differs from the
 * created type.
 */
export const varWhenApparentConverter: SourceTransformation = {
  name: 'Var When Apparent',
  apply(source: string): string {
    if (!source) {
      return source;
    }

    const tree = parseCSharp(source);

    try {
      const edits: TextEdit[] = [];

      for (const statement of findAll(tree.rootNode, 'local_declaration_statement')) {
        const declaration = statement.namedChildren.find((child) => child?.type === 'variable_declaration');
        if (!declaration) {
          continue;
        }

        const declarators = declaration.namedChildren.filter((child) => child?.type === 'variable_declarator');
        if (declarators.length !== 1) {
          continue;
        }

        const initializer = initializerValue(declarators[0]!);
        if (!initializer) {
          continue;
        }

        const declaredType = declaration.childForFieldName('type');
        if (!declaredType || declaredType.type === 'implicit_type') {
          continue;
        }

        if (isTypeApparent(declaredType, initializer)) {
          edits.push({ start: declaredType.startIndex, end: declaredType.endIndex, text: 'var' });
        }
      }

      return applyEdits(source, edits);
    } finally {
      tree.delete();
    }
  },
};

function initializerValue(declarator: Node): Node | undefined {
  const clause = declarator.namedChildren.find((child) => child?.type === 'equals_value_clause');

  return clause?.namedChildren.find((child) => Boolean(child)) ?? undefined;
}

function isTypeApparent(declaredType: Node, initializer: Node): boolean {
  const declaredText = declaredType.text;

  switch (initializer.type) {
    case 'object_creation_expression':
    case 'cast_expression':
      return initializer.childForFieldName('type')?.text === declaredText;

    case 'array_creation_expression': {
      if (declaredType.type !== 'array_type') {
        return false;
      }

      const createdArrayType = initializer.namedChildren.find((child) => child?.type === 'array_type');

      return (
        createdArrayType !== undefined &&
        declaredType.childForFieldName('type')?.text === createdArrayType!.childForFieldName('type')?.text
      );
    }

    default:
      return false;
  }
}
