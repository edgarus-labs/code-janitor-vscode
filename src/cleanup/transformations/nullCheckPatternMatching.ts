import { Node, TextEdit, applyEdits, findAll, parseCSharp } from '../parser';
import { SourceTransformation } from '../types';

/**
 * Node types that can only ever be reached through a LINQ query-expression clause. Every clause
 * desugars to the same method calls as its fluent-syntax equivalent (`from x in y where ...`
 * becomes `y.Where(x => ...)`), so a null check inside one is just as capable of landing inside an
 * `Expression<TDelegate>` overload as one inside an explicit `.Where(...)` lambda argument.
 * `query_where_clause` is the query-expression `where`; it is a distinct node type from the
 * `where` of a generic type-parameter constraint clause, which is unrelated.
 */
const QUERY_CLAUSE_TYPES: Record<string, true> = {
  from_clause: true, let_clause: true, query_where_clause: true, join_clause: true,
  join_into_clause: true, orderby_clause: true, ordering: true, select_clause: true, group_clause: true,
};

/**
 * Declaration node types with their own executable body. A null check inside one is unaffected by
 * whatever lambda or query clause encloses *that* declaration - local functions and locally
 * declared members compile to ordinary methods, never expression trees.
 */
const MEMBER_DECLARATION_TYPES: Record<string, true> = {
  method_declaration: true, constructor_declaration: true, destructor_declaration: true,
  operator_declaration: true, conversion_operator_declaration: true, accessor_declaration: true,
  property_declaration: true, indexer_declaration: true,
};

/**
 * Converts traditional null equality checks (`== null`, `!= null`) to pattern matching
 * (`is null`, `is not null`), except inside a lambda that may be converted to an expression tree.
 */
export const nullCheckPatternMatchingConverter: SourceTransformation = {
  name: 'Convert to Pattern Matching Null Checks',
  apply(source: string): string {
    if (!source || !source.trim()) {
      return source;
    }

    const tree = parseCSharp(source);

    try {
      const edits: TextEdit[] = [];

      for (const expression of findAll(tree.rootNode, 'binary_expression')) {
        const operator = expression.child(1);
        if (!operator || (operator.type !== '==' && operator.type !== '!=')) {
          continue;
        }

        const left = expression.childForFieldName('left');
        const right = expression.childForFieldName('right');
        if (!left || !right) {
          continue;
        }

        let target;
        if (right.type === 'null_literal') {
          target = left;
        } else if (left.type === 'null_literal') {
          target = right;
        } else {
          continue;
        }

        if (isInPossibleExpressionTree(expression)) {
          continue;
        }

        const pattern = operator.type === '!=' ? 'is not null' : 'is null';
        edits.push({
          start: expression.startIndex,
          end: expression.endIndex,
          text: `${target.text} ${pattern}`,
        });
      }

      return applyEdits(source, edits);
    } finally {
      tree.delete();
    }
  },
};

/**
 * True when converting `node` (a `==`/`!=` null check) to `is`/`is not` could break compilation
 * with CS8122. A lambda can only convert to `Expression<TDelegate>` when it has an expression body
 * (`=> expr`, never `=> { ... }` - CS0834) and is not `async` (CS1989); those two hard compiler
 * restrictions make every block-bodied or async lambda structurally incapable of becoming an
 * expression tree, regardless of what it is assigned to, cast to, passed as, or returned as. LINQ
 * query-expression clauses desugar to the same method calls as their fluent-syntax equivalents, so
 * anything inside one is just as unsafe as inside an explicit `.Where(...)` lambda. We have no type
 * information to rule out a *particular* delegate/queryable overload, so every expression-bodied,
 * non-async lambda (and every query clause) is treated as unsafe: the cost of a missed `is null`
 * simplification is negligible, the cost of a broken build is not. Only the nearest enclosing
 * lambda/query-clause/declaration matters - ancestors further out have no bearing on `node`.
 */
function isInPossibleExpressionTree(node: Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (QUERY_CLAUSE_TYPES[current.type] === true) {
      return true;
    }

    if (
      current.type === 'anonymous_method_expression' ||
      current.type === 'local_function_statement' ||
      MEMBER_DECLARATION_TYPES[current.type] === true
    ) {
      return false;
    }

    if (current.type === 'lambda_expression') {
      return hasExpressionBody(current) && !isAsyncLambda(current);
    }
  }

  return false;
}

/** True when `lambda`'s body is a single expression (`=> expr`) rather than a block (`=> { ... }`). */
function hasExpressionBody(lambda: Node): boolean {
  return lambda.childForFieldName('body')?.type !== 'block';
}

/**
 * True when `lambda` is the inner node of the `async` wrapper the parser builds for
 * `async x => ...`: the parser re-uses the inner lambda's node type for the wrapper, with the
 * `async` token as the wrapper's first child and the unwrapped lambda - the one this function is
 * called with - as its second. See the `async` handling in `parseIdentifierExpression` in the
 * native parser (`src/cleanup/syntax/parser.ts`).
 */
function isAsyncLambda(lambda: Node): boolean {
  const parent = lambda.parent;

  return parent?.type === lambda.type && parent.child(1) === lambda && parent.child(0)?.text === 'async';
}
