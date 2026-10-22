import { CleanupSettings } from '../cleanup/types';

/**
 * Insert Region (`SpadeContextInsertRegion`): wraps lines in a `#region`, a pure text edit. Removing
 * regions is the C# engine's `removeRegions` command.
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
