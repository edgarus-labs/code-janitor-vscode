import { Node, TextEdit, applyEdits, findAll, parseCSharp } from '../parser';
import { SourceTransformation } from '../types';

/**
 * LINQ query operators that have a `System.Linq.Queryable` overload taking `Expression<TDelegate>`
 * instead of a plain delegate. A lambda passed to one of these is compiled to an expression tree
 * whenever the receiver is `IQueryable<T>` (EF Core and every other ORM), and C# forbids pattern
 * matching (`is`/`is not`) inside an expression tree - CS8122. We have no type information to tell
 * an `IQueryable<T>` receiver from a plain `IEnumerable<T>` one, so every call to one of these
 * names is treated as unsafe: the cost of a missed `is null` simplification is negligible, the cost
 * of a broken build is not.
 */
const QUERYABLE_METHOD_NAMES = new Set([
  'Where', 'Select', 'SelectMany', 'OrderBy', 'OrderByDescending', 'ThenBy', 'ThenByDescending',
  'GroupBy', 'GroupJoin', 'Join', 'Any', 'All', 'Count', 'LongCount', 'First', 'FirstOrDefault',
  'Single', 'SingleOrDefault', 'Last', 'LastOrDefault', 'Average', 'Sum', 'Min', 'Max', 'Aggregate',
  'TakeWhile', 'SkipWhile', 'DefaultIfEmpty',
]);

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
 * True when `node` sits inside the nearest enclosing lambda/anonymous method and that lambda may
 * be converted to an `Expression<TDelegate>` rather than a plain delegate. Only the innermost
 * enclosing lambda matters: whether an outer lambda is itself an expression tree has no bearing on
 * whether the inner one is.
 */
function isInPossibleExpressionTree(node: Node): boolean {
  const lambda = enclosingLambda(node);

  return lambda !== undefined && (isAssignedToExpressionType(lambda) || isArgumentToQueryableCall(lambda));
}

function enclosingLambda(node: Node): Node | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === 'lambda_expression' || current.type === 'anonymous_method_expression') {
      return current;
    }
  }

  return undefined;
}

/** `Expression<Func<...>> predicate = x => ...;` and `(Expression<Func<...>>)(x => ...)`. */
function isAssignedToExpressionType(lambda: Node): boolean {
  const clause = lambda.parent;
  if (clause?.type === 'equals_value_clause') {
    const declarator = clause.parent;
    const declaration = declarator?.type === 'variable_declarator' ? declarator.parent : undefined;
    const type = declaration?.type === 'variable_declaration' ? declaration.childForFieldName('type') : undefined;

    if (isExpressionType(type)) {
      return true;
    }
  }

  const cast = lambda.parent?.type === 'parenthesized_expression' ? lambda.parent.parent : undefined;

  return cast?.type === 'cast_expression' && isExpressionType(cast.childForFieldName('type'));
}

function isExpressionType(type: Node | null | undefined): boolean {
  if (!type) {
    return false;
  }

  const name = type.type === 'generic_name' ? (type.namedChild(0)?.text ?? '') : type.text;

  return name === 'Expression' || name.endsWith('.Expression');
}

/** `source.Where(x => ...)`, including `queryable.Where(predicate: x => ...)`. */
function isArgumentToQueryableCall(lambda: Node): boolean {
  const argument = lambda.parent?.type === 'argument' ? lambda.parent : undefined;
  const argumentList = argument?.parent?.type === 'argument_list' ? argument.parent : undefined;
  const invocation = argumentList?.parent?.type === 'invocation_expression' ? argumentList.parent : undefined;
  const target = invocation?.childForFieldName('function');

  if (target?.type !== 'member_access_expression') {
    return false;
  }

  const name = target.childForFieldName('name');
  const methodName = name?.type === 'generic_name' ? (name.namedChild(0)?.text ?? '') : name?.text ?? '';

  return QUERYABLE_METHOD_NAMES.has(methodName);
}
