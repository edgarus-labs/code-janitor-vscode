import { Node } from '../parser';

/**
 * C# operator precedence, for rules that build expressions: whether a part needs parentheses where
 * it ends up. Levels: primary 15, unary 14, `switch`/`with` 13, the binary operators 12 (`*`) down
 * to 2 (`??`), conditional 1, assignment and lambda 0.
 */

export const BINARY_PRECEDENCE: Record<string, number> = {
  '*': 12,
  '/': 12,
  '%': 12,
  '+': 11,
  '-': 11,
  '<<': 10,
  '>>': 10,
  '>>>': 10,
  '<': 9,
  '>': 9,
  '<=': 9,
  '>=': 9,
  '==': 8,
  '!=': 8,
  '&': 7,
  '^': 6,
  '|': 5,
  '&&': 4,
  '||': 3,
  '??': 2,
};
export const RELATIONAL = 9;
export const UNARY = 14;
export const PRIMARY = 15;

export function operatorOf(node: Node): string | undefined {
  return node.type === 'binary_expression' ? node.children.find((child) => !child.isNamed)?.type : undefined;
}

/** Binding strength of an expression: primary 15, unary 14, then the binary levels down to 0. */
export function precedenceOf(node: Node): number {
  switch (node.type) {
    case 'binary_expression':
      return BINARY_PRECEDENCE[operatorOf(node) ?? ''] ?? 0;
    case 'conditional_expression':
      return 1;
    case 'assignment_expression':
    case 'lambda_expression':
    case 'throw_expression':
      return 0;
    case 'is_pattern_expression':
    case 'is_expression':
    case 'as_expression':
      return RELATIONAL;
    case 'switch_expression':
    case 'with_expression':
      return 13;
    case 'prefix_unary_expression':
    case 'cast_expression':
    case 'await_expression':
      return UNARY;
    default:
      return PRIMARY;
  }
}

/** The precedence an expression needs at `node`'s position to stand there without parentheses. */
export function requiredPrecedence(node: Node): number {
  const parent = node.parent;
  switch (parent?.type) {
    case 'binary_expression': {
      const operator = operatorOf(parent) ?? '';
      const precedence = BINARY_PRECEDENCE[operator] ?? PRIMARY;
      const isLeft = parent.childForFieldName('left') === node;

      // `??` is right-associative, every other binary operator left-associative.
      return operator === '??' ? (isLeft ? precedence + 1 : precedence) : isLeft ? precedence : precedence + 1;
    }
    case 'conditional_expression':
      return parent.childForFieldName('condition') === node ? 2 : 1;
    case 'is_pattern_expression':
    case 'is_expression':
    case 'as_expression':
      return RELATIONAL;
    case 'prefix_unary_expression':
    case 'cast_expression':
    case 'await_expression':
      return UNARY;
    case 'postfix_unary_expression':
      return PRIMARY;
    case 'member_access_expression':
    case 'conditional_access_expression':
    case 'element_access_expression':
      return parent.childForFieldName('expression') === node ? PRIMARY : 0;
    case 'invocation_expression':
      return parent.childForFieldName('function') === node ? PRIMARY : 0;
    case 'switch_expression':
      return parent.namedChildren[0] === node ? UNARY : 0;
    default:
      return 0;
  }
}

export function withParentheses(text: string, precedence: number, required: number): string {
  return precedence >= required ? text : `(${text})`;
}

export function unparenthesized(node: Node): Node {
  let current = node;
  while (current.type === 'parenthesized_expression' && current.namedChildCount === 1) {
    current = current.namedChildren[0];
  }

  return current;
}
