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
  const lines = source.split(eol);
  const indent = /^[ \t]*/.exec(lines[firstLine] ?? '')![0];

  const result: string[] = lines.slice(0, firstLine);
  if (settings.insertBlankLinePaddingBeforeRegionTags && firstLine > 0 && NOT_SCOPE_START.test(lines[firstLine - 1])) {
    result.push('');
  }

  const nameLine = result.length;
  result.push(`${indent}#region ${name}`);
  if (settings.insertBlankLinePaddingAfterRegionTags && NOT_SCOPE_END.test(lines[firstLine] ?? '')) {
    result.push('');
  }

  result.push(...lines.slice(firstLine, lastLine + 1));
  if (settings.insertBlankLinePaddingBeforeEndRegionTags && NOT_SCOPE_START.test(lines[lastLine] ?? '')) {
    result.push('');
  }

  result.push(`${indent}#endregion${settings.updateEndRegionDirectives ? ` ${name}` : ''}`);
  const next = lines[lastLine + 1];
  if (settings.insertBlankLinePaddingAfterEndRegionTags && next !== undefined && NOT_SCOPE_END.test(next)) {
    result.push('');
  }

  result.push(...lines.slice(lastLine + 1));
  const nameStart = indent.length + '#region '.length;

  return { text: result.join(eol), nameLine, nameStart, nameEnd: nameStart + name.length };
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

/** The region with a directive on `line` (`IsCodeRegionUnderCursor`). */
export function regionLinesAt(source: string, line: number): RegionLines | undefined {
  const lines = source.split(/\r?\n/);

  return regionPairs(lines).find((pair) => pair.startLine === line || pair.endLine === line);
}

/**
 * Removes the `#region` and `#endregion` lines of the regions that lie inside the lines, with the
 * blank lines next to them (the Visual Studio command collapses the vertical whitespace there).
 */
export function removeRegionsInLines(source: string, firstLine: number, lastLine: number): string {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const endsWithNewline = source.endsWith('\n');
  const lines = source.split(eol);
  if (endsWithNewline) {
    lines.pop();
  }

  const removed = new Set<number>();
  for (const { startLine, endLine } of regionPairs(lines, firstLine, lastLine)) {
    for (const directive of [startLine, endLine]) {
      removed.add(directive);
      for (let line = directive - 1; line >= 0 && lines[line].trim() === ''; line--) {
        removed.add(line);
      }
      for (let line = directive + 1; line < lines.length && lines[line].trim() === ''; line++) {
        removed.add(line);
      }
    }
  }

  if (removed.size === 0) {
    return source;
  }

  return lines.filter((_, index) => !removed.has(index)).join(eol) + (endsWithNewline ? eol : '');
}
