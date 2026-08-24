import { CODE, classifyCSharp } from '../csharpScanner';
import { HeaderPosition, HeaderUpdateMode } from '../types';

/**
 * File header and blank-line transforms. Ported from the regex-based cleanup helpers of the source
 * extension; the only intentional deviation is that the line ending is always taken from the file
 * itself instead of `Environment.NewLine`, so the result does not depend on the host platform.
 */

export function removeBlankLinesAtTop(source: string): string {
  return source.replace(/^(?:[ \t]*\r?\n)+/, '');
}

export function removeBlankLinesAtBottom(source: string): string {
  return source.replace(/(?:\r?\n[ \t]*)+$/, '');
}

export function removeBlankLinesAfterAttributes(source: string): string {
  return replaceUsingFileLineEnding(
    source,
    /(^[ \t]*\[[^\]]+\][ \t]*(?:\/\/[^\r\n]*)*)(?:\r?\n){2}(?![ \t]*\/\/)/gm,
    '$1{NL}'
  );
}

export function removeBlankLinesAfterOpeningBrace(source: string): string {
  return replaceUsingFileLineEnding(source, /\{([ \t]*(?:\/\/[^\r\n]*)*)(?:\r?\n){2,}/gm, '{$1{NL}');
}

export function removeBlankLinesBeforeClosingBrace(source: string): string {
  return replaceUsingFileLineEnding(source, /(?:\r?\n){2,}([ \t]*)\}/gm, '{NL}$1}');
}

export function removeBlankLinesBetweenChainedStatements(source: string): string {
  return replaceUsingFileLineEnding(
    source,
    /(?:\r?\n){2,}([ \t]*)(else|catch|finally)( |\t|\r?\n)/gm,
    '{NL}$1$2$3'
  );
}

function replaceUsingFileLineEnding(source: string, pattern: RegExp, replacement: string): string {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';

  return source.replace(pattern, replacement.replace('{NL}', newline));
}

export interface FileHeaderOptions {
  header: string;
  position: HeaderPosition;
  updateMode: HeaderUpdateMode;
}

export function applyConfiguredCSharpFileHeader(source: string, options: FileHeaderOptions): string {
  if (!options.header || !options.header.trim()) {
    return source;
  }

  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  let header = normalizeLineEndings(options.header, newline);
  if (!header.endsWith(newline)) {
    header += newline;
  }

  if (options.position === HeaderPosition.DocumentStart) {
    return options.updateMode === HeaderUpdateMode.Insert
      ? insertHeaderAtDocumentStart(source, header)
      : replaceHeaderAtDocumentStart(source, header);
  }

  return options.updateMode === HeaderUpdateMode.Insert
    ? insertHeaderAfterUsings(source, header)
    : replaceHeaderAfterUsings(source, header);
}

function insertHeaderAtDocumentStart(source: string, header: string): string {
  return source.startsWith(header.trim()) ? source : header + source;
}

function replaceHeaderAtDocumentStart(source: string, header: string): string {
  const current = extractLeadingHeaderSegment(source);

  return current.trimmedHeader === header.trim() ? source : header + source.slice(current.segmentLength);
}

function insertHeaderAfterUsings(source: string, header: string): string {
  const insertionIndex = getTopLevelUsingInsertionIndex(source);
  const current = extractLeadingHeaderSegment(source.slice(insertionIndex));

  if (current.trimmedHeader.startsWith(header.trim())) {
    return source;
  }

  const headerWithLeadingNewline = ensureHeaderStartsOnNewLine(header);

  return source.slice(0, insertionIndex) + headerWithLeadingNewline + source.slice(insertionIndex);
}

function replaceHeaderAfterUsings(source: string, header: string): string {
  const insertionIndex = getTopLevelUsingInsertionIndex(source);
  const suffix = source.slice(insertionIndex);
  const current = extractLeadingHeaderSegment(suffix);

  if (current.trimmedHeader === header.trim()) {
    return source;
  }

  return source.slice(0, insertionIndex) + ensureHeaderStartsOnNewLine(header) + suffix.slice(current.segmentLength);
}

function ensureHeaderStartsOnNewLine(header: string): string {
  const newline = header.includes('\r\n') ? '\r\n' : '\n';

  return header.startsWith(newline) ? header : newline + header;
}

/**
 * Returns the offset just past the last compilation-unit-level `using` directive. Top-level usings
 * must precede every member declaration, so they can be found lexically without a full parse.
 */
export function getTopLevelUsingInsertionIndex(source: string): number {
  const kinds = classifyCSharp(source);
  const usingPattern = /(^|\n)([ \t]*)using\b/g;
  let insertionIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = usingPattern.exec(source)) !== null) {
    const keywordStart = match.index + match[1].length + match[2].length;
    if (kinds[keywordStart] !== CODE) {
      continue;
    }

    if (!isTopLevelPosition(source, kinds, keywordStart)) {
      break;
    }

    const semicolon = indexOfCodeChar(source, kinds, ';', keywordStart);
    if (semicolon < 0) {
      break;
    }

    const lineEnd = source.indexOf('\n', semicolon);
    insertionIndex = lineEnd < 0 ? source.length : lineEnd + 1;
    usingPattern.lastIndex = insertionIndex;
  }

  return insertionIndex;
}

/** A `using` directive is compilation-unit-level only while no brace has been opened before it. */
function isTopLevelPosition(source: string, kinds: Uint8Array, index: number): boolean {
  for (let i = 0; i < index; i++) {
    if (kinds[i] === CODE && source[i] === '{') {
      return false;
    }
  }

  return true;
}

function indexOfCodeChar(source: string, kinds: Uint8Array, char: string, from: number): number {
  for (let i = from; i < source.length; i++) {
    if (source[i] === char && kinds[i] === CODE) {
      return i;
    }
  }

  return -1;
}

interface LeadingHeaderSegment {
  segmentLength: number;
  trimmedHeader: string;
}

function extractLeadingHeaderSegment(source: string): LeadingHeaderSegment {
  const lineHeaderMatch = /^(?:[ \t]*\r?\n)*(?:\/\/[^\r\n]*(?:\r?\n\/\/[^\r\n]*)*(?:\r?\n)?)/.exec(source);
  if (lineHeaderMatch && lineHeaderMatch[0]) {
    return { segmentLength: lineHeaderMatch[0].length, trimmedHeader: lineHeaderMatch[0].trim() };
  }

  const blockHeaderMatch = /^(?:[ \t]*\r?\n)*\/\*[\s\S]*?\*\/(?:\r?\n)?/.exec(source);
  if (blockHeaderMatch && blockHeaderMatch[0]) {
    return { segmentLength: blockHeaderMatch[0].length, trimmedHeader: blockHeaderMatch[0].trim() };
  }

  return { segmentLength: 0, trimmedHeader: '' };
}

function normalizeLineEndings(value: string, newline: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, newline);
}
