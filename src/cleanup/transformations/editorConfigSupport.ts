import {
  EditorConfigProperties,
  EditorConfigSeverity,
  isEnforced,
  resolveDiagnosticSeverity,
  splitOptionSeverity,
} from '../editorconfig';
import { CODE, STRING } from '../csharpScanner';
import { Node, parseCSharp, walk } from '../parser';
import { memoizeBySource } from '../sourceCache';

/**
 * Receives one message per rule violation that cleanup found but could not fix safely; `symbol`
 * names a type or non-private member the naming rules would rename (see `EditorConfigIssue`).
 */
export type EditorConfigIssueReporter = (issue: string, symbol?: string) => void;

/** A code-style option read as `option = value[:severity]`, with its diagnostic's effective severity. */
export interface CodeStyleOption {
  /** The option value, lower-cased. */
  readonly value: string;
  readonly diagnosticId: string;
  readonly severity: EditorConfigSeverity | undefined;
  /** True when the diagnostic is reported as `suggestion`, `warning` or `error`. */
  readonly enforced: boolean;
}

/**
 * Reads a code-style option and resolves the effective severity of the diagnostic its value
 * selects (`diagnosticId` may depend on the value, e.g. IDE0160/IDE0161). Returns `undefined`
 * when the option is not set.
 */
export function readCodeStyleOption(
  props: EditorConfigProperties,
  option: string,
  diagnosticId: string | ((value: string) => string)
): CodeStyleOption | undefined {
  const raw = props.get(option);
  if (raw === undefined) {
    return undefined;
  }

  const { value, severity } = splitOptionSeverity(raw);
  const normalized = value.toLowerCase();
  const id = typeof diagnosticId === 'string' ? diagnosticId : diagnosticId(normalized);
  // A `:none` suffix stops the rule whatever severity its diagnostic gets from `dotnet_diagnostic` or a bulk severity.
  const effective = severity === 'none' ? 'none' : resolveDiagnosticSeverity(props, id, severity);

  return { value: normalized, diagnosticId: id, severity: effective, enforced: isEnforced(effective) };
}

/** Parses a positive integer property value; anything else yields `undefined`. */
export function positiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\s*\d+\s*$/.test(raw)) {
    return undefined;
  }

  const value = Number.parseInt(raw, 10);

  return value > 0 ? value : undefined;
}

/** Width of a tab character: `tab_width`, else a numeric `indent_size`, else 4. */
export function tabWidth(props: EditorConfigProperties): number {
  return positiveInt(props.get('tab_width')) ?? positiveInt(props.get('indent_size')) ?? 4;
}

/**
 * The text of one indentation level for code that cleanup creates: a tab for `indent_style = tab`,
 * otherwise `indent_size` spaces. Without `indent_style`, the style already used by the file wins.
 */
export function indentUnit(props: EditorConfigProperties, source: string): string {
  const style = props.get('indent_style')?.toLowerCase();
  const sizeRaw = props.get('indent_size')?.toLowerCase();
  const size = sizeRaw === 'tab' ? tabWidth(props) : (positiveInt(sizeRaw) ?? tabWidth(props));

  if (style === 'tab' || (style === undefined && usesTabIndentation(source))) {
    return '\t';
  }

  return ' '.repeat(size);
}

function usesTabIndentation(source: string): boolean {
  let tabs = 0;
  let spaces = 0;

  for (const match of source.matchAll(/^([ \t])/gm)) {
    if (match[1] === '\t') {
      tabs++;
    } else {
      spaces++;
    }
  }

  return tabs > spaces;
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

/** Offset of the line break (`\r\n` or `\n`) ending the line containing `index`, or the source length. */
export function lineEndAt(source: string, index: number): number {
  const newline = source.indexOf('\n', index);
  if (newline < 0) {
    return source.length;
  }

  return newline > 0 && source[newline - 1] === '\r' ? newline - 1 : newline;
}

/** Start of the line after the one containing `index` (the end of the source on the last line). */
export function nextLineStartAt(source: string, index: number): number {
  const newline = source.indexOf('\n', index);

  return newline < 0 ? source.length : newline + 1;
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

/** One-based line number of `index`. */
export function lineNumberAt(source: string, index: number): number {
  const end = Math.min(index, source.length);
  let line = 1;
  for (let newline = source.indexOf('\n'); newline >= 0 && newline < end; newline = source.indexOf('\n', newline + 1)) {
    line++;
  }

  return line;
}

/** True when a line break inside `[start, end)` belongs to a string literal (verbatim or raw). */
export function containsMultiLineString(source: string, kinds: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    if (source[i] === '\n' && kinds[i] === STRING) {
      return true;
    }
  }

  return false;
}

export function isBlank(text: string): boolean {
  return /^\s*$/.test(text);
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
 * True when the parser recovered from syntax it does not understand somewhere inside `node` (a
 * statement missing its `;`, a statement header split into loose tokens, or an incomplete
 * declaration). Such subtrees can misrepresent the code, e.g. `x with { A = 1 }` becomes a block
 * holding `A = 1`, so rewrites skip them.
 */
export function hasParseErrors(node: Node): boolean {
  return isRecoveredNode(node) || node.namedChildren.some(hasParseErrors);
}

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

/** Builds a reporter message: `IDE0008 (csharp_style_var_elsewhere) line 12: ...`. */
export function describeIssue(diagnosticId: string, option: string, source: string, index: number, message: string): string {
  return `${diagnosticId} (${option}) line ${lineNumberAt(source, index)}: ${message}`;
}

/**
 * Adds `indent` to the start of every line in `text` that begins after a line break, except lines
 * that start inside a string literal and blank lines. `kinds`/`offset` classify `text` within the
 * whole source.
 */
export function indentFollowingLines(text: string, indent: string, kinds: Uint8Array, offset: number): string {
  let result = '';
  let copied = 0;

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\n' || kinds[offset + i] === STRING) {
      continue;
    }

    const next = i + 1;
    const lineEnd = lineEndAt(text, next);
    if (next >= text.length || isBlank(text.slice(next, lineEnd))) {
      continue;
    }

    result += text.slice(copied, next) + indent;
    copied = next;
  }

  return result + text.slice(copied);
}

/**
 * The body of a block, the text between `start` (after its `{`) and `end` (its `}`), without its
 * surrounding blank lines and with one indentation unit removed from every line that starts in
 * code. The unit is the indentation of the block's first member (see `memberIndent`). Lines that
 * continue a string literal (verbatim, raw, multi-line interpolated) and every line break stay as
 * they are.
 */
export function dedentBlock(source: string, kinds: Uint8Array, start: number, end: number): string {
  const text = source.slice(start, end);
  const firstContent = text.search(/\S/);
  if (firstContent < 0) {
    return '';
  }

  // Text on the line of the `{` (a trailing comment, or code) has no indentation of its own: the body
  // starts at that text, and the unit comes from the lines below it.
  const onBraceLine = !text.slice(0, firstContent).includes('\n');
  const bodyStart = onBraceLine ? firstContent : lineStartAt(text, firstContent);
  const unit = memberIndent(text, kinds, start, onBraceLine ? firstContent : bodyStart) ?? (onBraceLine ? '' : lineIndentAt(text, firstContent));
  const body = text.slice(bodyStart).trimEnd();
  const offset = start + bodyStart;
  let result = '';
  let lineStart = 0;
  while (lineStart < body.length) {
    const next = body.indexOf('\n', lineStart);
    const lineEnd = next < 0 ? body.length : next + 1;
    const line = body.slice(lineStart, lineEnd);
    const startsInString = lineStart > 0 && kinds[offset + lineStart - 1] === STRING;
    const content = line.replace(/\r?\n$/, '');
    result += startsInString ? line : isBlank(content) ? line.slice(content.length) : line.startsWith(unit) ? line.slice(unit.length) : line;
    lineStart = lineEnd;
  }

  return result;
}

/**
 * Indentation of the first line in `text` from `from` on that starts a member of the block: a line
 * of code at brace depth 0, or the line whose leading `}` returns to it. Directives (column 0 whatever
 * the code's indentation), lines continuing a comment or string, and lines nested in a block opened
 * on the `{` line set no unit. `from` inside a line (text on the `{` line) only counts its braces.
 * `undefined` when no line qualifies.
 */
function memberIndent(text: string, kinds: Uint8Array, offset: number, from: number): string | undefined {
  const isCode = (index: number) => kinds[offset + index] === CODE;
  let depth = 0;
  let lineStart = from;
  while (lineStart < text.length) {
    const next = text.indexOf('\n', lineStart);
    const lineEnd = next < 0 ? text.length : next;
    const indent = /^[ \t]*/.exec(text.slice(lineStart, lineEnd))![0];
    const first = lineStart + indent.length;
    const startsLine = lineStart > 0 && text[lineStart - 1] === '\n';
    if (startsLine && first < lineEnd && isCode(first - 1) && text[first] !== '#' && text[first] !== '\r') {
      let closers = 0;
      while (text[first + closers] === '}' && isCode(first + closers)) {
        closers++;
      }

      if (depth - closers <= 0) {
        return indent;
      }
    }

    for (let index = lineStart; index < lineEnd; index++) {
      if (isCode(index)) {
        depth += text[index] === '{' ? 1 : text[index] === '}' ? -1 : 0;
      }
    }

    lineStart = lineEnd + 1;
  }

  return undefined;
}

/** An option's value, lower-cased, ignoring a `:severity` suffix (formatting options carry none). */
export function optionValue(props: EditorConfigProperties, key: string): string | undefined {
  const raw = props.get(key);

  return raw === undefined ? undefined : splitOptionSeverity(raw).value.toLowerCase();
}

export function modifiersOf(node: Node): Node[] {
  return node.namedChildren.filter((child) => child.type === 'modifier');
}

export function hasModifier(node: Node, name: string): boolean {
  return modifiersOf(node).some((modifier) => modifier.text === name);
}

/** What a file can hold outside every type: anything else directly in the compilation unit is a top-level statement. */
const COMPILATION_UNIT_MEMBERS = new Set([
  'using_directive',
  'extern_alias_directive',
  'attribute_list',
  'namespace_declaration',
  'file_scoped_namespace_declaration',
  'class_declaration',
  'struct_declaration',
  'record_declaration',
  'interface_declaration',
  'enum_declaration',
  'delegate_declaration',
]);

/**
 * True when `node` is in the top-level statements of a file. The parser has no model of them: a
 * statement there is read as a field, a property or an incomplete declaration, so the names it
 * declares and the code after it cannot be analyzed. Rules that decide from what a piece of code
 * uses (captures, reads, writes) leave such code unchanged.
 */
export function isInTopLevelStatements(node: Node): boolean {
  let top: Node = node;
  while (top.parent && top.parent.type !== 'compilation_unit') {
    top = top.parent;
  }

  return top.parent?.type === 'compilation_unit' && !COMPILATION_UNIT_MEMBERS.has(top.type);
}
