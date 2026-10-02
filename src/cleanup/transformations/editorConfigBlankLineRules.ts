import { CODE, classifyCSharp } from '../csharpScanner';
import { EditorConfigProperties } from '../editorconfig';
import { Node, TextEdit, applyEdits, findAll, parseCSharp } from '../parser';
import type { Rule, RuleContext } from './editorConfigCodeStyle';
import { lineIndentAt, newlineOf, readCodeStyleOption } from './editorConfigSupport';

/**
 * The experimental blank-line and wrapping options (IDE2000 - IDE2006). Each applies for `false`
 * (the construct is not allowed); `true` allows it, so nothing changes. Only whitespace between
 * tokens changes: never text inside strings or comments.
 * https://learn.microsoft.com/dotnet/fundamentals/code-analysis/style-rules/ide2000
 */

const MULTIPLE_BLANK_LINES = 'dotnet_style_allow_multiple_blank_lines_experimental';
const EMBEDDED_STATEMENTS = 'csharp_style_allow_embedded_statements_on_same_line_experimental';
const CONSECUTIVE_BRACES = 'csharp_style_allow_blank_lines_between_consecutive_braces_experimental';
const STATEMENT_AFTER_BLOCK = 'dotnet_style_allow_statement_immediately_after_block_experimental';
const INITIALIZER_COLON = 'csharp_style_allow_blank_line_after_colon_in_constructor_initializer_experimental';
const CONDITIONAL_TOKEN = 'csharp_style_allow_blank_line_after_token_in_conditional_expression_experimental';
const ARROW_TOKEN = 'csharp_style_allow_blank_line_after_token_in_arrow_expression_clause_experimental';

function disallowed(props: EditorConfigProperties, option: string, diagnosticId: string): boolean {
  const value = readCodeStyleOption(props, option, diagnosticId);

  return value?.enforced === true && value.value === 'false';
}

function whenDisallowed(option: string, diagnosticId: string, fix: (source: string, context: RuleContext) => string): Rule {
  return { option, apply: (source, context) => (disallowed(context.props, option, diagnosticId) ? fix(source, context) : source) };
}

function withTree(source: string, collect: (root: Node) => TextEdit[]): string {
  const tree = parseCSharp(source);
  try {
    return applyEdits(source, collect(tree.rootNode));
  } finally {
    tree.delete();
  }
}

/**
 * Replaces each match of `pattern` whose first and last characters are code (not string or comment).
 * A `\r\n` counts by its `\n`: the scanner ends a `//` comment before the `\n`, so the `\r` is comment.
 */
function replaceInCode(source: string, pattern: RegExp, replace: (match: RegExpExecArray) => string): string {
  const kinds = classifyCSharp(source);
  const isCode = (index: number): boolean => kinds[source[index] === '\r' && source[index + 1] === '\n' ? index + 1 : index] === CODE;
  const edits: TextEdit[] = [];
  for (const match of source.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    if (isCode(start) && isCode(end - 1)) {
      edits.push({ start, end, text: replace(match as RegExpExecArray) });
    }
  }

  return applyEdits(source, edits);
}

/** IDE2000: two or more blank lines in a row become one. */
function collapseMultipleBlankLines(source: string): string {
  return replaceInCode(source, /(\r?\n)(?:[ \t]*\r?\n){2,}/g, (match) => match[1] + match[1]);
}

/**
 * IDE2002: no blank line between a closing brace and the closing brace on a following line. The
 * following brace is only looked at, so it can start the next match of a chain of closing braces.
 */
function removeBlankLinesBetweenClosingBraces(source: string): string {
  return replaceInCode(source, /\}([ \t]*)(\r?\n)(?:[ \t]*\r?\n)+(?=[ \t]*\})/g, (match) => `}${match[1]}${match[2]}`);
}

const EMBEDDING_STATEMENTS = [
  'if_statement',
  'while_statement',
  'for_statement',
  'for_each_statement',
  'using_statement',
  'lock_statement',
  'fixed_statement',
];

/**
 * IDE2001: an embedded statement written on the line of its `if (...)`, `else`, `while (...)`...
 * moves to its own line, one level deeper. `else if` stays together; a statement spanning several
 * lines is left as it is (its other lines would need re-indenting).
 */
function moveEmbeddedStatements(source: string, context: RuleContext): string {
  const newline = newlineOf(source);

  return withTree(source, (root) => {
    const edits: TextEdit[] = [];
    for (const statement of findAll(root, EMBEDDING_STATEMENTS)) {
      const children = statement.children;
      for (let i = 1; i < children.length; i++) {
        const previous = children[i - 1];
        const child = children[i];
        const isEmbedded = child.isNamed && child.type !== 'block' && /_statement$/.test(child.type) && (previous.type === ')' || previous.type === 'else');
        if (
          !isEmbedded ||
          (previous.type === 'else' && child.type === 'if_statement') ||
          child.startPosition.row !== previous.endPosition.row ||
          child.startPosition.row !== child.endPosition.row
        ) {
          continue;
        }

        // The moved statement sits one level deeper than the line its header starts on, not the
        // header's last line (a wrapped condition) - for `else` that is the `else` line.
        const headerStart = previous.type === 'else' ? previous.startIndex : statement.startIndex;
        edits.push({ start: previous.endIndex, end: child.startIndex, text: `${newline}${lineIndentAt(source, headerStart)}${context.indent}` });
      }
    }

    return edits;
  });
}

/**
 * The statement lists of a file: each block's statements, and the statements of each switch
 * section. The parser puts a section's `case`/`default` labels and statements directly under
 * `switch_body`, so a section's statements are a run of statements between labels.
 */
function statementLists(root: Node): Node[][] {
  const lists = findAll(root, 'block').map((block) => block.namedChildren);
  for (const body of findAll(root, 'switch_body')) {
    if (body.parent?.type !== 'switch_statement') {
      continue;
    }

    let section: Node[] = [];
    for (const child of body.children) {
      if (child.isNamed && isStatement(child)) {
        section.push(child);
      } else if (section.length > 0) {
        lists.push(section);
        section = [];
      }
    }
  }

  return lists;
}

function isStatement(node: Node): boolean {
  return node.type === 'block' || /_statement$/.test(node.type);
}

/** IDE2003: a statement right after a block (`}`) gets a blank line in front of it. */
function separateStatementsAfterBlocks(source: string): string {
  const newline = newlineOf(source);

  return withTree(source, (root) => {
    const edits: TextEdit[] = [];
    for (const statements of statementLists(root)) {
      for (let i = 1; i < statements.length; i++) {
        const previous = statements[i - 1];
        const next = statements[i];
        if (
          !isStatement(previous) ||
          !isStatement(next) ||
          !previous.text.endsWith('}') ||
          next.startPosition.row !== previous.endPosition.row + 1
        ) {
          continue;
        }

        const lineStart = source.lastIndexOf('\n', next.startIndex - 1) + 1;
        edits.push({ start: lineStart, end: lineStart, text: newline });
      }
    }

    return edits;
  });
}

/**
 * IDE2004 - IDE2006: no blank line after a token that ends its line. The first line break stays,
 * the blank lines after it go.
 */
function removeBlankLinesAfter(tokens: (root: Node) => Node[]): (source: string) => string {
  return (source) =>
    withTree(source, (root) =>
      tokens(root).flatMap((token): TextEdit[] => {
        const gap = /^[ \t]*\r?\n(?:[ \t]*\r?\n)+/.exec(source.slice(token.endIndex));
        const firstBreak = gap ? /^[ \t]*\r?\n/.exec(gap[0])![0] : '';

        return gap ? [{ start: token.endIndex, end: token.endIndex + gap[0].length, text: firstBreak }] : [];
      })
    );
}

const tokensOf = (types: string[], tokenTypes: string[]) => (root: Node): Node[] =>
  findAll(root, types).flatMap((node) => node.children.filter((child) => !child.isNamed && tokenTypes.includes(child.type)));

export const BLANK_LINE_RULES: readonly Rule[] = [
  whenDisallowed(EMBEDDED_STATEMENTS, 'IDE2001', moveEmbeddedStatements),
  whenDisallowed(STATEMENT_AFTER_BLOCK, 'IDE2003', separateStatementsAfterBlocks),
  whenDisallowed(INITIALIZER_COLON, 'IDE2004', removeBlankLinesAfter(tokensOf(['constructor_initializer'], [':']))),
  whenDisallowed(CONDITIONAL_TOKEN, 'IDE2005', removeBlankLinesAfter(tokensOf(['conditional_expression'], ['?', ':']))),
  whenDisallowed(ARROW_TOKEN, 'IDE2006', removeBlankLinesAfter(tokensOf(['arrow_expression_clause'], ['=>']))),
  whenDisallowed(CONSECUTIVE_BRACES, 'IDE2002', removeBlankLinesBetweenClosingBraces),
  whenDisallowed(MULTIPLE_BLANK_LINES, 'IDE2000', collapseMultipleBlankLines),
];
