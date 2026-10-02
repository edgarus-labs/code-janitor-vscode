import { CleanupSettings } from '../cleanup/types';

/**
 * The region commands that work on lines: wrapping lines in a region (`SpadeContextInsertRegion`)
 * and removing the regions in some lines (`RemoveRegionCommand`, `SpadeContextRemoveRegion`).
 */

export type RegionPadding = Pick<
  CleanupSettings,
  | 'insertBlankLinePaddingBeforeRegionTags'
  | 'insertBlankLinePaddingAfterRegionTags'
  | 'insertBlankLinePaddingBeforeEndRegionTags'
  | 'insertBlankLinePaddingAfterEndRegionTags'
  | 'updateEndRegionDirectives'
>;

export interface InsertedRegion {
  text: string;
  /** Where the region's name is, to select it for renaming. */
  nameLine: number;
  nameStart: number;
  nameEnd: number;
}

/** A line that is not blank and does not start a scope (a `{`): padding goes after it. */
const NOT_SCOPE_START = /^\s*[^\s{]/;
/** A line that is not blank and does not end a scope (a `}`): padding goes before it. */
const NOT_SCOPE_END = /^\s*[^\s}]/;
const REGION_DIRECTIVE = /^[ \t]*#\s*(region|endregion)\b/;

export function insertRegionAroundLines(source: string, firstLine: number, lastLine: number, settings: RegionPadding, name = 'New Region'): InsertedRegion {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = splitLines(source);
  const texts = lines.map((line) => line.text);
  const indent = /^[ \t]*/.exec(texts[firstLine] ?? '')![0];
  const added = (text: string): Line => ({ text, eol });

  const result: Line[] = lines.slice(0, firstLine);
  if (settings.insertBlankLinePaddingBeforeRegionTags && firstLine > 0 && NOT_SCOPE_START.test(texts[firstLine - 1])) {
    result.push(added(''));
  }

  const nameLine = result.length;
  result.push(added(`${indent}#region ${name}`));
  if (settings.insertBlankLinePaddingAfterRegionTags && NOT_SCOPE_END.test(texts[firstLine] ?? '')) {
    result.push(added(''));
  }

  result.push(...lines.slice(firstLine, lastLine + 1));
  if (settings.insertBlankLinePaddingBeforeEndRegionTags && NOT_SCOPE_START.test(texts[lastLine] ?? '')) {
    result.push(added(''));
  }

  result.push(added(`${indent}#endregion${settings.updateEndRegionDirectives ? ` ${name}` : ''}`));
  const next = texts[lastLine + 1];
  if (settings.insertBlankLinePaddingAfterEndRegionTags && next !== undefined && NOT_SCOPE_END.test(next)) {
    result.push(added(''));
  }

  result.push(...lines.slice(lastLine + 1));
  const nameStart = indent.length + '#region '.length;
  // The last line of the file has no line break; one that no longer ends the file takes the file's.
  const text = result.map((line, index) => line.text + (index === result.length - 1 ? '' : line.eol || eol)).join('');

  return { text, nameLine, nameStart, nameEnd: nameStart + name.length };
}

interface Line {
  text: string;
  /** The line break after the line: empty for the last line of the file. */
  eol: string;
}

/** The lines of `source` with their own line breaks, counted the way the editor numbers them. */
function splitLines(source: string): Line[] {
  const lines: Line[] = [];
  const lineBreak = /\r?\n/g;
  let start = 0;
  for (let match = lineBreak.exec(source); match; match = lineBreak.exec(source)) {
    lines.push({ text: source.slice(start, match.index), eol: match[0] });
    start = match.index + match[0].length;
  }
  lines.push({ text: source.slice(start), eol: '' });

  return lines;
}

interface RegionLines {
  startLine: number;
  endLine: number;
}

/** The `#region`/`#endregion` pairs of the lines, innermost first as they close; directives without a partner are ignored. */
function regionPairs(lines: readonly string[], firstLine = 0, lastLine = lines.length - 1): RegionLines[] {
  const open: number[] = [];
  const pairs: RegionLines[] = [];

  for (let line = firstLine; line <= lastLine && line < lines.length; line++) {
    const directive = REGION_DIRECTIVE.exec(lines[line])?.[1];
    if (directive === 'region') {
      open.push(line);
    } else if (directive === 'endregion' && open.length > 0) {
      pairs.push({ startLine: open.pop()!, endLine: line });
    }
  }

  return pairs;
}

/**
 * Removes the `#region` and `#endregion` lines of the regions that lie inside the lines, with the
 * blank lines next to them (the Visual Studio command collapses the vertical whitespace there).
 */
export function removeRegionsInLines(source: string, firstLine: number, lastLine: number): string {
  return removeRegionDirectives(source, (texts) => regionPairs(texts, firstLine, lastLine));
}

/** Removes the region with a directive on `line` (`IsCodeRegionUnderCursor`, `RemoveRegion`), keeping the regions nested in it. */
export function removeRegionAt(source: string, line: number): string {
  return removeRegionDirectives(source, (texts) => regionPairs(texts).filter((pair) => pair.startLine === line || pair.endLine === line));
}

function removeRegionDirectives(source: string, pairsOf: (texts: readonly string[]) => RegionLines[]): string {
  const endsWithNewline = source.endsWith('\n');
  const lines = splitLines(source);
  if (endsWithNewline) {
    lines.pop();
  }
  const texts = lines.map((line) => line.text);

  const removed = new Set<number>();
  for (const { startLine, endLine } of pairsOf(texts)) {
    for (const directive of [startLine, endLine]) {
      removed.add(directive);
      for (let line = directive - 1; line >= 0 && texts[line].trim() === ''; line--) {
        removed.add(line);
      }
      for (let line = directive + 1; line < texts.length && texts[line].trim() === ''; line++) {
        removed.add(line);
      }
    }
  }

  if (removed.size === 0) {
    return source;
  }

  const text = lines
    .filter((_, index) => !removed.has(index))
    .map((line) => line.text + line.eol)
    .join('');

  // A file without a final line break keeps none when its last line goes.
  return endsWithNewline ? text : text.replace(/\r?\n$/, '');
}
