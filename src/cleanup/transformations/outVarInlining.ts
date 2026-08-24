import { Node } from 'web-tree-sitter';
import { TextEdit, applyEdits, findAll, parseCSharp, walk } from '../parser';
import { SourceTransformation } from '../types';

const NON_STATEMENT_PREFIXES = ['comment', 'preproc'];

/**
 * Inlines a separate uninitialized local declaration into the `out` argument that follows it,
 * producing `out var x`. The declaration is only merged when the very next statement uses the
 * variable as an `out` argument and does not read it beforehand.
 */
export const outVarInliningConverter: SourceTransformation = {
  name: 'Inline out Variable Declarations',
  apply(source: string): string {
    if (!source || !source.trim()) {
      return source;
    }

    const tree = parseCSharp(source);

    try {
      const edits: TextEdit[] = [];

      for (const block of findAll(tree.rootNode, 'block')) {
        collectBlockEdits(block, edits);
      }

      return applyEdits(source, edits);
    } finally {
      tree.delete();
    }
  },
};

function collectBlockEdits(block: Node, edits: TextEdit[]): void {
  const statements = blockStatements(block);

  for (let i = 0; i < statements.length - 1; i++) {
    const declaration = singleUninitializedDeclaration(statements[i]);
    if (!declaration) {
      continue;
    }

    const next = statements[i + 1];
    const outArgument = findOutArgument(next, declaration.name);
    if (!outArgument) {
      continue;
    }

    if (hasUsageBefore(next, declaration.name, outArgument.expression.startIndex)) {
      continue;
    }

    edits.push({ start: statements[i].startIndex, end: next.startIndex, text: '' });
    edits.push({
      start: outArgument.expression.startIndex,
      end: outArgument.expression.endIndex,
      text: `var ${declaration.name}`,
    });

    // The merged statement is no longer a declaration, so the following pair starts after it.
    i++;
  }
}

function blockStatements(block: Node): Node[] {
  return block.namedChildren.filter(
    (child): child is Node => Boolean(child) && !NON_STATEMENT_PREFIXES.some((prefix) => child!.type.startsWith(prefix))
  );
}

function singleUninitializedDeclaration(statement: Node): { name: string } | undefined {
  if (statement.type !== 'local_declaration_statement') {
    return undefined;
  }

  const declaration = statement.namedChildren.find((child) => child?.type === 'variable_declaration');
  const declarators = declaration?.namedChildren.filter((child) => child?.type === 'variable_declarator') ?? [];
  if (declarators.length !== 1) {
    return undefined;
  }

  const declarator = declarators[0]!;
  if (declarator.namedChildren.some((child) => child?.type === 'equals_value_clause')) {
    return undefined;
  }

  const name = declarator.childForFieldName('name') ?? declarator.namedChild(0);

  return name?.type === 'identifier' ? { name: name.text } : undefined;
}

function findOutArgument(statement: Node, variableName: string): { expression: Node } | undefined {
  for (const node of walk(statement)) {
    if (node.type !== 'argument') {
      continue;
    }

    if (!node.children.some((child) => child?.type === 'out')) {
      continue;
    }

    const expression = node.namedChildren.find((child) => Boolean(child));
    if (expression?.type === 'identifier' && expression.text === variableName) {
      return { expression };
    }
  }

  return undefined;
}

function hasUsageBefore(statement: Node, variableName: string, limit: number): boolean {
  for (const node of walk(statement)) {
    if (node.type === 'identifier' && node.text === variableName && node.startIndex < limit) {
      return true;
    }
  }

  return false;
}
