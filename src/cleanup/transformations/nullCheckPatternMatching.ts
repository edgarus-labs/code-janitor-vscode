import { TextEdit, applyEdits, findAll, parseCSharp } from '../parser';
import { SourceTransformation } from '../types';

/**
 * Converts traditional null equality checks (`== null`, `!= null`) to pattern matching
 * (`is null`, `is not null`).
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
