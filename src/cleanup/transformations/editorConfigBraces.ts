import { CODE, COMMENT, classifyCSharp } from '../csharpScanner';
import { EditorConfigProperties } from '../editorconfig';
import { Node, TextEdit, applyEdits, findAll, parseCSharp } from '../parser';
import {
  EditorConfigIssueReporter,
  containsMultiLineString,
  describeIssue,
  hasParseErrors,
  indentFollowingLines,
  lineEndAt,
  lineIndentAt,
  newlineOf,
  readCodeStyleOption,
} from './editorConfigSupport';

const OPTION = 'csharp_prefer_braces';

/** Statements owning an embedded statement, keyed to the token that precedes it. */
const OWNERS = [
  'if_statement',
  'for_statement',
  'for_each_statement',
  'while_statement',
  'do_statement',
  'using_statement',
  'lock_statement',
  'fixed_statement',
];

/** Upper bound on nesting levels handled; every pass braces the outermost remaining statements. */
const MAX_PASSES = 64;

interface EmbeddedStatement {
  readonly owner: Node;
  /** The token right before the statement: `)`, `else` or `do`. */
  readonly anchor: Node;
  readonly statement: Node;
}

/**
 * Applies `csharp_prefer_braces` (IDE0011): `true` wraps every embedded statement of
 * `if`/`else`/`for`/`foreach`/`while`/`do`/`using`/`lock`/`fixed` in a block, `when_multiline`
 * only those spanning several lines. `else if` chains and directly nested `using`/`fixed`
 * statements are left as they are. `false` never removes braces (Roslyn offers no such fix).
 */
export function applyBracePreference(
  source: string,
  props: EditorConfigProperties,
  report: EditorConfigIssueReporter,
  indentUnit: string
): string {
  const option = readCodeStyleOption(props, OPTION, 'IDE0011');
  if (!option?.enforced || (option.value !== 'true' && option.value !== 'when_multiline')) {
    return source;
  }

  const multilineOnly = option.value === 'when_multiline';
  const issues = new Set<string>();
  let current = source;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const updated = bracePass(current, multilineOnly, indentUnit, issues);
    if (updated === current) {
      break;
    }

    current = updated;
  }

  for (const issue of issues) {
    report(issue);
  }

  return current;
}

function bracePass(source: string, multilineOnly: boolean, indentUnit: string, issues: Set<string>): string {
  const tree = parseCSharp(source);

  try {
    const kinds = classifyCSharp(source);
    const candidates = findAll(tree.rootNode, OWNERS)
      .flatMap(embeddedStatements)
      .filter(({ statement }) => !multilineOnly || statement.text.includes('\n'))
      .sort((a, b) => a.statement.startIndex - b.statement.startIndex);

    const edits: TextEdit[] = [];
    let coveredUntil = -1;

    for (const candidate of candidates) {
      if (candidate.statement.startIndex < coveredUntil) {
        // Nested in a statement braced in this pass; handled by the next pass on the new text.
        continue;
      }

      const candidateEdits = braceEdits(source, kinds, candidate, indentUnit);
      if (typeof candidateEdits === 'string') {
        issues.add(describeIssue('IDE0011', OPTION, source, candidate.statement.startIndex, candidateEdits));
        continue;
      }

      edits.push(...candidateEdits);
      coveredUntil = candidate.statement.endIndex;
    }

    return applyEdits(source, edits);
  } finally {
    tree.delete();
  }
}

function embeddedStatements(owner: Node): EmbeddedStatement[] {
  const result: EmbeddedStatement[] = [];
  // Comments and directives are children too (`if (x) // why`, `A(); // note` before `else`): the
  // anchor and its statement are the tokens around them. `braceEdits` reports what they block.
  const children = owner.children.filter((child) => child.type !== 'comment' && !child.type.startsWith('preproc'));

  /** Adds the statement at `index` when the token before it is `anchorType` and it is not a block. */
  const add = (index: number, anchorType: string): void => {
    const anchor = children[index - 1];
    const statement = children[index];
    if (anchor?.type !== anchorType || !statement?.isNamed || statement.type === 'block' || statement.type === 'empty_statement') {
      return;
    }

    if (anchorType === 'else' && statement.type === 'if_statement') {
      return;
    }

    if ((owner.type === 'using_statement' || owner.type === 'fixed_statement') && statement.type === owner.type) {
      return;
    }

    result.push({ owner, anchor, statement });
  };

  // Located from the end: the header of a statement the parser misread may hold loose tokens.
  if (owner.type === 'do_statement') {
    add(children.findIndex((child) => child.type === 'do') + 1, 'do');

    return result;
  }

  const elseIndex = owner.type === 'if_statement' ? children.findIndex((child) => child.type === 'else') : -1;
  if (elseIndex >= 0) {
    add(elseIndex - 1, ')');
    add(elseIndex + 1, 'else');
  } else {
    add(children.length - 1, ')');
  }

  return result;
}

/** The edits wrapping one embedded statement in braces, or the reason it cannot be done safely. */
function braceEdits(source: string, kinds: Uint8Array, candidate: EmbeddedStatement, indentUnit: string): TextEdit[] | string {
  const { owner, anchor, statement } = candidate;
  if (hasParseErrors(owner)) {
    return 'braces were not added: the statement could not be fully parsed.';
  }

  const newline = newlineOf(source);
  const braceIndent = lineIndentAt(source, anchor.type === 'else' ? anchor.startIndex : owner.startIndex);
  const gap = source.slice(anchor.endIndex, statement.startIndex);
  const edits: TextEdit[] = [];

  if (gap.includes('\n')) {
    // The statement already sits on its own line: open the block at the end of the header line.
    const headerLineEnd = lineEndAt(source, anchor.endIndex);
    if (!isTrivia(source, kinds, anchor.endIndex, headerLineEnd) || continuesInComment(source, kinds, headerLineEnd)) {
      return 'braces were not added: the header line continues after the statement header.';
    }

    if (/^[ \t]*#/m.test(source.slice(headerLineEnd, statement.startIndex))) {
      return 'braces were not added: a preprocessor directive precedes the statement.';
    }

    const insertion = contentEnd(source, kinds, anchor.endIndex, headerLineEnd);
    edits.push({ start: insertion, end: headerLineEnd, text: `${newline}${braceIndent}{` });
  } else {
    if (gap.trim() !== '') {
      return 'braces were not added: a comment separates the statement from its header.';
    }

    if (containsMultiLineString(source, kinds, statement.startIndex, statement.endIndex)) {
      return 'braces were not added: the statement contains a multi-line string literal.';
    }

    const moved = indentFollowingLines(statement.text, indentUnit, kinds, statement.startIndex);
    edits.push({
      start: anchor.endIndex,
      end: statement.endIndex,
      text: `${newline}${braceIndent}{${newline}${braceIndent}${indentUnit}${moved}`,
    });
  }

  const closing = closingEdit(source, kinds, statement, braceIndent, newline);
  if (!closing) {
    return 'braces were not added: a comment or directive follows the statement on its line.';
  }

  edits.push(closing);

  return edits;
}

/**
 * `}` goes at the end of the statement's last line when only a comment follows it there; when code
 * follows (`else`, `while` of a `do`, or another statement), it goes right after the statement.
 */
function closingEdit(
  source: string,
  kinds: Uint8Array,
  statement: Node,
  braceIndent: string,
  newline: string
): TextEdit | undefined {
  const lineEnd = lineEndAt(source, statement.endIndex);
  if (isTrivia(source, kinds, statement.endIndex, lineEnd)) {
    if (continuesInComment(source, kinds, lineEnd)) {
      return undefined;
    }

    const insertion = contentEnd(source, kinds, statement.endIndex, lineEnd);

    return { start: insertion, end: lineEnd, text: `${newline}${braceIndent}}` };
  }

  const rest = source.slice(statement.endIndex, lineEnd);
  const leading = rest.length - rest.trimStart().length;
  const next = rest.trimStart();
  if (next.startsWith('/') || next.startsWith('#')) {
    return undefined;
  }

  const continuesClause = /^(else|while)\b/.test(next);

  return {
    start: statement.endIndex,
    end: statement.endIndex + leading,
    text: `${newline}${braceIndent}}${continuesClause ? ' ' : newline + braceIndent}`,
  };
}

/**
 * True when a block comment runs past the line break at `lineEnd`. The break counts by its `\n`:
 * a `//` comment ends before the `\n`, so the `\r` of a CRLF break is part of it.
 */
function continuesInComment(source: string, kinds: Uint8Array, lineEnd: number): boolean {
  return kinds[source[lineEnd] === '\r' ? lineEnd + 1 : lineEnd] === COMMENT;
}

/** True when `[start, end)` holds only whitespace and comments. */
function isTrivia(source: string, kinds: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    if (kinds[i] === CODE && source[i] !== ' ' && source[i] !== '\t' && source[i] !== '\r') {
      return false;
    }
  }

  return true;
}

/** End of `[start, end)` without its trailing spaces and tabs (never those inside a comment). */
function contentEnd(source: string, kinds: Uint8Array, start: number, end: number): number {
  let index = end;
  while (index > start && kinds[index - 1] === CODE && (source[index - 1] === ' ' || source[index - 1] === '\t')) {
    index--;
  }

  return index;
}
