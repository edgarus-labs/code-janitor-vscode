import { Node, TextEdit, applyEdits, findAll, parseCSharp, walk } from '../parser';
import { SourceTransformation } from '../types';

const NON_STATEMENT_PREFIXES = ['comment', 'preproc'];

/**
 * Statements whose expression variables share the scope of the enclosing block, so `out T x` in
 * them declares `x` exactly where the separate declaration did.
 */
const SAME_SCOPE_STATEMENTS: Record<string, true> = {
  expression_statement: true,
  local_declaration_statement: true,
  return_statement: true,
  if_statement: true,
};

/** Nodes that open a scope (or a deferred execution) of their own inside a statement. */
const NESTED_SCOPES: Record<string, true> = {
  lambda_expression: true,
  anonymous_method_expression: true,
  local_function_statement: true,
  query_expression: true,
  block: true,
  switch_expression: true,
};

export interface OutVariableInliningOptions {
  /**
   * Only inline when the inlined declaration keeps the variable's scope: the next statement is an
   * expression, declaration, `return` or `if` (condition only) statement, the argument is not
   * inside a nested lambda/local function/query/block, and nothing but whitespace separates the
   * two statements.
   */
  readonly preserveScope?: boolean;
  /** Write the declared type (`out int x`) instead of `out var x`. */
  readonly keepDeclaredType?: boolean;
}

/**
 * Inlines a separate uninitialized local declaration into the `out` argument that follows it,
 * producing `out var x`. The declaration is only merged when the very next statement uses the
 * variable as an `out` argument and does not read it beforehand.
 */
export const outVarInliningConverter: SourceTransformation = {
  name: 'Inline out Variable Declarations',
  apply: (source) => inlineOutVariableDeclarations(source),
};

export function inlineOutVariableDeclarations(source: string, options: OutVariableInliningOptions = {}): string {
  if (!source || !source.trim()) {
    return source;
  }

  const tree = parseCSharp(source);

  try {
    const edits: TextEdit[] = [];

    for (const block of findAll(tree.rootNode, 'block')) {
      collectBlockEdits(source, block, edits, options);
    }

    return applyEdits(source, edits);
  } finally {
    tree.delete();
  }
}

function collectBlockEdits(source: string, block: Node, edits: TextEdit[], options: OutVariableInliningOptions): void {
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

    // An out variable declared in a nested block, or in a `while`/`for`/`foreach`/`using` header,
    // is scoped to it, so later uses would not compile
    // (https://learn.microsoft.com/dotnet/csharp/language-reference/keywords/out-parameter-modifier#out-parameter-modifier).
    if (
      !keepsScope(next, outArgument.expression) ||
      (options.preserveScope === true && (declaration.hasModifiers || source.slice(statements[i].endIndex, next.startIndex).trim() !== ''))
    ) {
      continue;
    }

    edits.push({ start: statements[i].startIndex, end: next.startIndex, text: '' });
    edits.push({
      start: outArgument.expression.startIndex,
      end: outArgument.expression.endIndex,
      text: `${options.keepDeclaredType === true ? declaration.type : 'var'} ${declaration.name}`,
    });

    // The merged statement is no longer a declaration, so the following pair starts after it.
    i++;
  }
}

function keepsScope(statement: Node, expression: Node): boolean {
  if (SAME_SCOPE_STATEMENTS[statement.type] !== true) {
    return false;
  }

  if (statement.type === 'if_statement') {
    const closeParen = statement.children.find((child) => child.type === ')');
    if (!closeParen || expression.startIndex > closeParen.startIndex) {
      return false;
    }
  }

  for (let current = expression.parent; current && current !== statement; current = current.parent) {
    if (NESTED_SCOPES[current.type] === true) {
      return false;
    }
  }

  return true;
}

function blockStatements(block: Node): Node[] {
  return block.namedChildren.filter(
    (child): child is Node => Boolean(child) && !NON_STATEMENT_PREFIXES.some((prefix) => child!.type.startsWith(prefix))
  );
}

function singleUninitializedDeclaration(
  statement: Node
): { name: string; type: string; hasModifiers: boolean } | undefined {
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
  const type = declaration?.childForFieldName('type');

  return name?.type === 'identifier' && type
    ? {
        name: name.text,
        type: type.text,
        hasModifiers: statement.namedChildren.some((child) => child.type === 'modifier'),
      }
    : undefined;
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
