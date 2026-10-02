import { CODE, classifyCSharp } from '../cleanup/csharpScanner';
import { layoutControlHeader, layoutMembers, layoutStatements } from './csharpLayout';
import { RazorFormatOptions, RazorLayout, indentUnitOf, resolveRazorLayout } from './razorOptions';
import {
  findClosingBracket,
  findCodeBlockEnd,
  hasWordAt,
  isIdentifierPart,
  isIdentifierStart,
  isVerbatimElement,
  skipElement,
  skipString,
  skipTransition,
  skipWhitespace,
} from './razorScanner';

/**
 * Safe formatting of Razor components and views (`.razor`, `.cshtml`), ported from the Visual
 * Studio extension: the C# of `@code` / `@functions` blocks and of the control blocks `@if`,
 * `@else`, `@for`, `@foreach`, `@while`, `@switch`, `@try`, `@catch` and `@finally` is laid out;
 * markup is never reformatted, only moved with the block that holds it.
 *
 * Only whitespace ever changes. A block the formatter cannot read with certainty, C# that does not
 * parse cleanly, or a result that would change anything but whitespace leaves that part of the
 * file exactly as authored.
 */
export function formatRazor(source: string, options: Partial<RazorFormatOptions> = {}): string {
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = source.slice(bom.length);
  if (body.trim().length === 0 || /\r(?!\n)/.test(body)) {
    return source;
  }

  const lineEnding = body.includes('\r\n') ? '\r\n' : '\n';
  const text = body.replace(/\r\n/g, '\n');
  const formatted = new Formatter(text, resolveRazorLayout(options, text)).run();
  if (formatted === text) {
    return source;
  }

  const result = lineEnding === '\n' ? formatted : formatted.replace(/\n/g, lineEnding);

  return bom + result;
}

type BlockKind = 'code' | 'if' | 'for' | 'foreach' | 'while' | 'switch' | 'else' | 'try' | 'catch' | 'finally';

interface Block {
  readonly keyword: BlockKind;
  /** `else`, `catch` and `finally` written without the `@`, as Razor requires after a block. */
  readonly bare: boolean;
  /** Index of the `@`, or of the keyword of a bare continuation. */
  readonly start: number;
  /** Index of the `{`. */
  readonly open: number;
  /** Index of the matching `}`. */
  readonly close: number;
}

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const PARENTHESIZED_KEYWORDS: readonly string[] = ['if', 'for', 'foreach', 'while', 'switch'];

class Formatter {
  private readonly unit: string;

  constructor(
    private readonly text: string,
    private readonly options: RazorLayout
  ) {
    this.unit = indentUnitOf(options);
  }

  run(): string {
    const blocks = this.findBlocks();
    const bases: string[] = [];
    const continues = blocks.map((block, index) => index > 0 && this.continuesPrevious(blocks[index - 1], block));
    blocks.forEach((block, index) => {
      bases.push(continues[index] ? bases[index - 1] : this.lineIndentAt(block.start));
    });

    const edits: Edit[] = [];
    blocks.forEach((block, index) => {
      const edit =
        block.keyword === 'code'
          ? this.formatCodeBlock(block, bases[index])
          : this.formatControlBlock(block, bases[index], continues[index] ? blocks[index - 1] : undefined, continues[index + 1] === true);
      if (edit && this.onlyWhitespaceChanges(edit)) {
        edits.push(edit);
      }
    });

    let result = this.text;
    for (const edit of [...edits].reverse()) {
      result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    }

    return stripWhitespace(result) === stripWhitespace(this.text) ? result : this.text;
  }

  /** True when `block` continues `previous` (`else` after `if`, `catch` / `finally` after `try`) with only whitespace between. */
  private continuesPrevious(previous: Block, block: Block): boolean {
    if (!/^\s*$/.test(this.text.slice(previous.close + 1, block.start))) {
      return false;
    }

    const afterIf = previous.keyword === 'if' || (previous.keyword === 'else' && this.isElseIf(previous));
    const afterTry = previous.keyword === 'try' || previous.keyword === 'catch';

    return (afterIf && block.keyword === 'else') || (afterTry && (block.keyword === 'catch' || block.keyword === 'finally'));
  }

  private isElseIf(block: Block): boolean {
    return hasWordAt(this.text, skipWhitespace(this.text, block.start + (block.bare ? 4 : 5)), 'if');
  }

  private onlyWhitespaceChanges(edit: Edit): boolean {
    return stripWhitespace(this.text.slice(edit.start, edit.end)) === stripWhitespace(edit.text);
  }

  // -------------------------------------------------------------------------------------------
  // Finding the blocks
  // -------------------------------------------------------------------------------------------

  /** The `@code` / `@functions` and control blocks of the markup, outermost first, in document order. */
  private findBlocks(): Block[] {
    const text = this.text;
    const blocks: Block[] = [];
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === '<') {
        i = this.skipVerbatimMarkup(i);
      } else if (c !== '@') {
        i++;
      } else if (isIdentifierPart(text[i - 1]) || text[i - 1] === '@') {
        i++;
      } else {
        const block = this.readBlock(i, false);
        if (block) {
          blocks.push(block);
          i = block.close + 1;
          for (let bare = this.readBareContinuation(blocks[blocks.length - 1]); bare; bare = this.readBareContinuation(bare)) {
            blocks.push(bare);
            i = bare.close + 1;
          }
        } else {
          const next = skipTransition(text, i);
          i = next > i ? next : i + 1;
        }
      }
    }

    return blocks;
  }

  /** Past comments and elements whose content is not formatted or searched; `index + 1` for any other `<`. */
  private skipVerbatimMarkup(index: number): number {
    const text = this.text;
    if (text.startsWith('<!--', index)) {
      const end = text.indexOf('-->', index + 4);

      return end < 0 ? text.length : end + 3;
    }

    const name = /^<([A-Za-z][\w:.-]*)/.exec(text.slice(index, index + 64))?.[1];
    if (name === undefined || !isVerbatimElement(name)) {
      return index + 1;
    }

    const end = skipElement(text, index);

    return end < 0 ? text.length : end;
  }

  /** The bare `else` / `else if` / `catch` / `finally` block that follows `block`, if any. */
  private readBareContinuation(block: Block): Block | undefined {
    const at = skipWhitespace(this.text, block.close + 1);
    const candidate = /^(?:else|catch|finally)\b/.test(this.text.slice(at, at + 8)) ? this.readBlock(at, true) : undefined;

    return candidate && this.continuesPrevious(block, candidate) ? candidate : undefined;
  }

  private readBlock(at: number, bare: boolean): Block | undefined {
    const text = this.text;
    const wordStart = bare ? at : at + 1;
    let end = wordStart;
    while (isIdentifierPart(text[end])) {
      end++;
    }

    const word = text.slice(wordStart, end);
    let i = skipWhitespace(text, end);
    if (word === 'code' || word === 'functions') {
      return !bare && text[i] === '{' ? this.closeBlock('code', at, i, bare) : undefined;
    }

    if (word === 'try' || word === 'finally') {
      return text[i] === '{' && (!bare || word === 'finally') ? this.closeBlock(word, at, i, bare) : undefined;
    }

    if (word === 'else' && hasWordAt(text, i, 'if')) {
      i = skipWhitespace(text, i + 2);

      return this.readParenthesized('else', at, i, bare);
    }

    if (word === 'else') {
      return text[i] === '{' ? this.closeBlock('else', at, i, bare) : undefined;
    }

    if (word === 'catch') {
      return text[i] === '(' ? this.readParenthesized('catch', at, i, bare) : text[i] === '{' ? this.closeBlock('catch', at, i, bare) : undefined;
    }

    return !bare && PARENTHESIZED_KEYWORDS.includes(word) && text[i] === '(' ? this.readParenthesized(word as BlockKind, at, i, bare) : undefined;
  }

  private readParenthesized(keyword: BlockKind, at: number, parenthesis: number, bare: boolean): Block | undefined {
    const close = this.text[parenthesis] === '(' ? findClosingBracket(this.text, parenthesis) : -1;
    if (close < 0) {
      return undefined;
    }

    const open = skipWhitespace(this.text, close + 1);

    return this.text[open] === '{' ? this.closeBlock(keyword, at, open, bare) : undefined;
  }

  private closeBlock(keyword: BlockKind, start: number, open: number, bare: boolean): Block | undefined {
    const close = findCodeBlockEnd(this.text, open);

    return close < 0 ? undefined : { keyword, bare, start, open, close };
  }

  // -------------------------------------------------------------------------------------------
  // @code and @functions
  // -------------------------------------------------------------------------------------------

  private formatCodeBlock(block: Block, base: string): Edit | undefined {
    const content = this.text.slice(block.open + 1, block.close);
    const laid = layoutMembers(content, this.options);
    if (laid === undefined) {
      return undefined;
    }

    const body = indentCode(laid, base + this.unit);

    return { start: block.open + 1, end: block.close, text: `\n${body}\n${base}` };
  }

  // -------------------------------------------------------------------------------------------
  // Control blocks
  // -------------------------------------------------------------------------------------------

  /**
   * `previous` is the block this one continues (`else` after `if`, ...): the two lines up, the
   * continuation starting a line of its own at the indent of the first. `continued` is true when
   * the next block continues this one and sets the line break itself.
   */
  private formatControlBlock(block: Block, base: string, previous: Block | undefined, continued: boolean): Edit | undefined {
    const header = this.buildHeader(block);
    if (header === undefined) {
      return undefined;
    }

    const inner = this.text.slice(block.open + 1, block.close);
    const body = this.formatInner(inner, base + this.unit);
    if (body === undefined) {
      return undefined;
    }

    const formatted = `${header}\n${base}{\n${body.length > 0 ? `${body}\n` : ''}${base}}`;
    const afterClose = block.close + 1;
    const next = this.text[afterClose];
    const followedByKeyword = /^\s*(?:else|catch|finally)\b/.test(this.text.slice(afterClose, afterClose + 16));
    const separator = !continued && next !== undefined && !/\s/.test(next) && !followedByKeyword ? '\n' : '';
    if (!previous) {
      return { start: block.start, end: afterClose, text: formatted + separator };
    }

    const gap = this.text.slice(previous.close + 1, block.start);
    const lead = block.bare || !gap.includes('\n') ? `\n${base}` : gap;

    return { start: previous.close + 1, end: afterClose, text: lead + formatted + separator };
  }

  /** The header line (`@if (a && b)`, `@else`, `catch (Exception ex)`) or undefined when it cannot be read. */
  private buildHeader(block: Block): string | undefined {
    const raw = this.text.slice(block.bare ? block.start : block.start + 1, block.open).trim();
    const prefix = block.bare ? '' : '@';
    if (block.keyword === 'try' || block.keyword === 'finally') {
      return `${prefix}${block.keyword}`;
    }

    const rest = raw.slice(block.keyword.length).trim();
    if (rest.length === 0 && (block.keyword === 'else' || block.keyword === 'catch')) {
      return `${prefix}${block.keyword}`;
    }

    const condition = block.keyword === 'else' ? rest.replace(/^if\s*/, '') : rest;
    if (!condition.startsWith('(') || findClosingBracket(condition, 0) !== condition.length - 1) {
      // A `when` filter or anything else after the parentheses: the header is left as authored.
      return undefined;
    }

    const keyword = block.keyword === 'else' ? 'if' : block.keyword;
    const normalized = this.normalizeHeader(keyword, condition);

    return block.keyword === 'else' ? `${prefix}else ${normalized}` : `${prefix}${normalized}`;
  }

  private normalizeHeader(keyword: string, condition: string): string {
    const fallback = `${keyword} ${condition}`;
    if (condition.includes('\n')) {
      return fallback;
    }

    if (keyword === 'catch') {
      const laid = layoutStatements(`try\n{\n}\ncatch${condition}\n{\n}`, this.options);
      const line = laid?.split('\n').find((candidate) => candidate.startsWith('catch'));

      return line !== undefined && !line.includes('\n') ? line.trim() : fallback;
    }

    const laid = layoutControlHeader(`${keyword}${condition}`, this.options);

    return laid !== undefined && !laid.includes('\n') ? laid : fallback;
  }

  // -------------------------------------------------------------------------------------------
  // The content of a control block
  // -------------------------------------------------------------------------------------------

  /**
   * The lines between the braces, every one at `childIndent` plus what it had beyond the content's
   * own margin. Markup is moved, never reformatted; statements are laid out when they parse. Returns
   * undefined when anything in the content is not safe to move.
   */
  private formatInner(inner: string, childIndent: string): string | undefined {
    if (inner.trim().length === 0) {
      return '';
    }

    const segments = splitSegments(inner);
    if (segments === undefined) {
      return undefined;
    }

    // What lies inside a string literal or a block comment belongs to that token, not to the layout.
    const kinds = new Uint8Array(inner.length);
    for (const segment of segments.filter((candidate) => candidate.kind === 'code')) {
      kinds.set(classifyCSharp(inner.slice(segment.start, segment.end)), segment.start);
    }

    const margin = marginOf(inner, kinds);
    if (margin === undefined) {
      return undefined;
    }

    let output = '';
    let previous: Segment | undefined;
    let extra = '';
    for (const segment of segments) {
      const lineStart = inner.lastIndexOf('\n', segment.start - 1) + 1;
      if (lineStart > 0 && inner.slice(lineStart, segment.start).trim().length === 0) {
        extra = inner.slice(lineStart, segment.start).slice(margin.length);
      }

      const indent = childIndent + extra;
      const piece = this.formatSegment(inner, segment, margin, kinds, childIndent, indent);
      if (piece === undefined) {
        return undefined;
      }

      if (previous === undefined) {
        output = piece;
      } else {
        const gap = inner.slice(previous.end, segment.start);
        const newlines = gap.split('\n').length - 1;
        if (previous.kind === 'markup' && segment.kind === 'markup' && newlines === 0 && piece.startsWith(indent)) {
          // Two elements written side by side stay side by side: the text between them is content.
          output += gap + piece.slice(indent.length);
        } else {
          output += (newlines >= 2 ? '\n\n' : '\n') + piece;
        }
      }

      previous = segment;
    }

    return output;
  }

  private formatSegment(inner: string, segment: Segment, margin: string, kinds: Uint8Array, childIndent: string, indent: string): string | undefined {
    const content = inner.slice(segment.start, segment.end);
    if (segment.kind === 'markup') {
      return /<(?:pre|textarea|script|style)\b/i.test(content) ? undefined : shiftLines(content, margin, childIndent, indent, kinds, segment.start);
    }

    const laid = layoutStatements(content, this.options);

    return laid === undefined ? shiftLines(content, margin, childIndent, indent, kinds, segment.start) : indentCode(laid, indent);
  }

  private lineIndentAt(index: number): string {
    const lineStart = this.text.lastIndexOf('\n', index - 1) + 1;
    const match = /^[ \t]*/.exec(this.text.slice(lineStart, index));

    return match ? match[0] : '';
  }
}

// -----------------------------------------------------------------------------------------------
// Splitting the content of a block into statements and markup
// -----------------------------------------------------------------------------------------------

interface Segment {
  readonly kind: 'code' | 'markup';
  /** Offsets in the block content, without the whitespace around. */
  readonly start: number;
  readonly end: number;
}

/** Code and top-level markup elements of a block's content; undefined when the content is not well formed. */
function splitSegments(inner: string): Segment[] | undefined {
  const segments: Segment[] = [];
  let depth = 0;
  let statementStart = true;
  let codeStart = 0;
  const flushCode = (end: number): void => {
    const slice = inner.slice(codeStart, end);
    const leading = slice.length - slice.trimStart().length;
    if (slice.trim().length > 0) {
      segments.push({ kind: 'code', start: codeStart + leading, end: codeStart + slice.trimEnd().length });
    }
  };

  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    let next = i;
    if (c === '"') {
      next = skipString(inner, i) - 1;
      statementStart = false;
    } else if (c === "'") {
      next = skipCharacter(inner, i) - 1;
      statementStart = false;
    } else if (c === '/' && (inner[i + 1] === '/' || inner[i + 1] === '*')) {
      next = skipComment(inner, i) - 1;
    } else if (c === '@' && (inner[i + 1] === '*' || inner[i + 1] === ':' || inner[i + 1] === '<')) {
      next = skipTransition(inner, i) - 1;
      statementStart = true;
    } else if (c === '<' && statementStart && (isIdentifierStart(inner[i + 1]) || inner.startsWith('<!--', i))) {
      const end = skipElement(inner, i);
      if (end < 0) {
        return undefined;
      }

      if (depth === 0) {
        flushCode(i);
        segments.push({ kind: 'markup', start: i, end });
        codeStart = end;
      }

      next = end - 1;
    } else if (c === '{') {
      depth++;
      statementStart = true;
    } else if (c === '}') {
      if (--depth < 0) {
        return undefined;
      }

      statementStart = true;
    } else if (c === ';' || c === ':') {
      statementStart = true;
    } else if (!/\s/.test(c)) {
      statementStart = false;
    }

    if (next < i - 1) {
      return undefined;
    }

    i = next;
  }

  if (depth !== 0) {
    return undefined;
  }

  flushCode(inner.length);

  return segments;
}

function skipCharacter(text: string, index: number): number {
  for (let i = index + 1; i < Math.min(text.length, index + 12); i++) {
    if (text[i] === '\\') {
      i++;
    } else if (text[i] === '\n') {
      return -1;
    } else if (text[i] === "'") {
      return i + 1;
    }
  }

  return -1;
}

function skipComment(text: string, index: number): number {
  if (text[index + 1] === '/') {
    const end = text.indexOf('\n', index);

    return end < 0 ? text.length : end;
  }

  const end = text.indexOf('*/', index + 2);

  return end < 0 ? -1 : end + 2;
}

// -----------------------------------------------------------------------------------------------
// Indentation helpers
// -----------------------------------------------------------------------------------------------

function stripWhitespace(text: string): string {
  return text.replace(/\s+/g, '');
}

/**
 * The indent shared by every line of the content after the first (the first shares the line of the
 * opening brace): the margin the content is written at. Lines inside a literal or a block comment
 * (`kinds`) do not count. Undefined when two lines disagree on it.
 */
function marginOf(inner: string, kinds: Uint8Array): string | undefined {
  const indents: string[] = [];
  let offset = inner.indexOf('\n') + 1;
  for (const line of inner.slice(offset).split('\n')) {
    if (line.trim().length > 0 && kinds[offset - 1] === CODE) {
      indents.push(/^[ \t]*/.exec(line)?.[0] ?? '');
    }

    offset += line.length + 1;
  }

  const margin = indents.reduce((shortest, indent) => (indent.length < shortest.length ? indent : shortest), indents[0] ?? '');

  return indents.every((indent) => indent.startsWith(margin)) ? margin : undefined;
}

/** Puts `indent` before every line of laid-out code, except lines continuing a literal or a preprocessor directive. */
function indentCode(code: string, indent: string): string {
  const kinds = classifyCSharp(code);
  let offset = 0;

  return code
    .split('\n')
    .map((line) => {
      const continues = offset > 0 && kinds[offset - 1] !== CODE;
      const skip = line.trim().length === 0 || continues || line.startsWith('#');
      offset += line.length + 1;

      return skip ? line : indent + line;
    })
    .join('\n');
}

/**
 * Moves text written at `margin` to `childIndent`: the first line gets `firstIndent`, the others
 * keep what they have beyond the margin. Lines that continue a literal or a block comment (`kinds`,
 * `offset` being where `content` starts) are not touched. Undefined when a line is written left of the margin.
 */
function shiftLines(content: string, margin: string, childIndent: string, firstIndent: string, kinds: Uint8Array, offset: number): string | undefined {
  let position = offset;
  const shifted: string[] = [];
  for (const [i, line] of content.split('\n').entries()) {
    const continues = i > 0 && kinds[position - 1] !== CODE;
    position += line.length + 1;
    if (i === 0) {
      shifted.push(firstIndent + line);
    } else if (continues) {
      shifted.push(line);
    } else if (line.trim().length === 0) {
      shifted.push('');
    } else if (line.startsWith(margin)) {
      shifted.push(childIndent + line.slice(margin.length));
    } else {
      return undefined;
    }
  }

  return shifted.join('\n');
}
