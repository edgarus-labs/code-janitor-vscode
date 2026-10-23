import { Node, parseCSharp, walk } from './parser';
import { memoizeBySource } from './sourceCache';

/** The formatting options, by `.editorconfig` key (case-insensitive). */
export interface FormattingOptions {
  get(key: string): string | undefined;
}

export function positiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\s*\d+\s*$/.test(raw)) {
    return undefined;
  }

  const value = Number.parseInt(raw, 10);

  return value > 0 ? value : undefined;
}

/** Width of a tab character: `tab_width`, else a numeric `indent_size`, else 4. */
export function tabWidth(props: FormattingOptions): number {
  return positiveInt(props.get('tab_width')) ?? positiveInt(props.get('indent_size')) ?? 4;
}

export function newlineOf(source: string): string {
  return source.includes('\r\n') ? '\r\n' : '\n';
}

export function lineStartAt(source: string, index: number): number {
  if (index <= 0) {
    return 0;
  }

  return source.lastIndexOf('\n', index - 1) + 1;
}

/** Leading whitespace of the line containing `index`. */
export function lineIndentAt(source: string, index: number): string {
  const start = lineStartAt(source, index);
  let end = start;
  while (source[end] === ' ' || source[end] === '\t') {
    end++;
  }

  return source.slice(start, end);
}

/** Statements and declarations the parser only completes with a terminating `;`. */
const SEMICOLON_TERMINATED: Record<string, true> = {
  expression_statement: true,
  local_declaration_statement: true,
  return_statement: true,
  throw_statement: true,
  break_statement: true,
  continue_statement: true,
  goto_statement: true,
  yield_statement: true,
  do_statement: true,
  field_declaration: true,
  event_field_declaration: true,
};

/** Statements whose header is a single parenthesized part: `if (...)`, `while (...)`, `for (...)`, ... */
const PARENTHESIZED_HEADERS: Record<string, true> = {
  if_statement: true,
  while_statement: true,
  do_statement: true,
  for_statement: true,
  for_each_statement: true,
  using_statement: true,
  lock_statement: true,
  fixed_statement: true,
  switch_statement: true,
};

/**
 * Number of places where the parser recovered from syntax it does not understand. A rewrite whose
 * result has more of them than its input is discarded: it may have broken the code.
 */
export const parseErrorCount: (source: string) => number = memoizeBySource((source) => {
  let count = 0;
  for (const node of walk(parseCSharp(source).rootNode)) {
    if (isRecoveredNode(node)) {
      count++;
    }
  }

  return count;
});

/**
 * True when the parser recovered from syntax it does not understand at `node` (a statement missing
 * its `;`, a statement header split into loose tokens, or an incomplete declaration). Such subtrees
 * can misrepresent the code, so formatting leaves them alone.
 */
export function isRecoveredNode(node: Node): boolean {
  if (node.type === 'incomplete_declaration') {
    return true;
  }

  if (SEMICOLON_TERMINATED[node.type] === true && node.children[node.children.length - 1]?.type !== ';') {
    return true;
  }

  if (PARENTHESIZED_HEADERS[node.type] !== true) {
    return false;
  }

  const opening = node.children.filter((child) => child.type === '(').length;
  const closing = node.children.filter((child) => child.type === ')').length;

  return opening !== 1 || closing !== 1;
}

/** An option's value, lower-cased. */
export function optionValue(props: FormattingOptions, key: string): string | undefined {
  return props.get(key)?.toLowerCase();
}
