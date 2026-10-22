/** The markup cleanup options (`RunCodeCleanupMarkup`). */
export interface MarkupOptions {
  readonly removeBlankLinesBeforeClosingTags: boolean;
  readonly removeBlankSpacesBeforeClosingAngleBrackets: boolean;
  readonly insertBlankSpaceBeforeSelfClosingAngleBrackets: boolean;
}

/**
 * A piece of a markup file: a tag (`<name ...>` or `</name>`), text between tags, or something that is never
 * changed - a comment, CDATA, a processing instruction, a declaration, or the content of an HTML element whose
 * text is not markup (`script`, `style`, `pre`, `textarea`).
 */
interface Segment {
  readonly kind: 'tag' | 'text' | 'verbatim';
  readonly text: string;
}

const VERBATIM: readonly (readonly [string, string])[] = [
  ['<!--', '-->'],
  ['<![CDATA[', ']]>'],
  ['<?', '?>'],
  ['<!', '>'],
];

const RAW_TEXT_ELEMENTS = /^<(script|style|pre|textarea)\b/i;

/**
 * Applies the markup rules to the tags of `source` and the text between them only: comments, CDATA, processing
 * instructions, attribute values and the content of `script`, `style`, `pre` and `textarea` (HTML) stay as they are.
 */
export function cleanupMarkup(source: string, options: MarkupOptions, html: boolean): string {
  if (
    !options.removeBlankLinesBeforeClosingTags &&
    !options.removeBlankSpacesBeforeClosingAngleBrackets &&
    !options.insertBlankSpaceBeforeSelfClosingAngleBrackets
  ) {
    return source;
  }

  const segments = splitMarkup(source, html);

  return segments
    .map((segment, index) => {
      if (segment.kind === 'tag') {
        return tagEnd(segment.text, options);
      }

      const next = segments[index + 1];
      if (segment.kind === 'text' && options.removeBlankLinesBeforeClosingTags && next?.kind === 'tag' && next.text.startsWith('</')) {
        return segment.text.replace(/(\r?\n)(?:[ \t]*\r?\n)+([ \t]*)$/, '$1$2');
      }

      return segment.text;
    })
    .join('');
}

/** The whitespace before the `>` or `/>` that ends a tag, as the options want it. */
function tagEnd(tag: string, options: MarkupOptions): string {
  const end = /(\s*)(\/?>)$/.exec(tag)!;
  const space = end[1];
  const head = tag.slice(0, end.index);
  if (end[2] === '>') {
    return options.removeBlankSpacesBeforeClosingAngleBrackets ? `${head}>` : tag;
  }

  if (options.insertBlankSpaceBeforeSelfClosingAngleBrackets) {
    return space === '' || (options.removeBlankSpacesBeforeClosingAngleBrackets && space !== ' ') ? `${head} />` : tag;
  }

  return options.removeBlankSpacesBeforeClosingAngleBrackets ? `${head}/>` : tag;
}

function splitMarkup(source: string, html: boolean): Segment[] {
  const segments: Segment[] = [];
  let text = 0;
  let at = 0;
  const flushText = (until: number): void => {
    if (until > text) {
      segments.push({ kind: 'text', text: source.slice(text, until) });
    }
  };

  while ((at = source.indexOf('<', at)) >= 0) {
    const verbatim = VERBATIM.find(([open]) => source.startsWith(open, at));
    if (verbatim) {
      const close = source.indexOf(verbatim[1], at + verbatim[0].length);
      const end = close < 0 ? source.length : close + verbatim[1].length;
      flushText(at);
      segments.push({ kind: 'verbatim', text: source.slice(at, end) });
      text = at = end;
      continue;
    }

    const end = /^<\/?[A-Za-z_:]/.test(source.slice(at, at + 3)) ? tagEndIndex(source, at) : -1;
    if (end < 0) {
      at++;
      continue;
    }

    flushText(at);
    const tag = source.slice(at, end);
    segments.push({ kind: 'tag', text: tag });
    text = at = end;

    const raw = html && !tag.endsWith('/>') ? RAW_TEXT_ELEMENTS.exec(tag) : null;
    if (raw) {
      const closing = new RegExp(`</${raw[1]}\\b`, 'gi');
      closing.lastIndex = at;
      const close = closing.exec(source);
      const contentEnd = close ? close.index : source.length;
      if (contentEnd > at) {
        segments.push({ kind: 'verbatim', text: source.slice(at, contentEnd) });
      }

      text = at = contentEnd;
    }
  }

  flushText(source.length);

  return segments;
}

/** The index just past the `>` closing the tag that starts at `start`, skipping quoted attribute values; -1 if none. */
function tagEndIndex(source: string, start: number): number {
  let quote: string | undefined;
  for (let i = start + 1; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return i + 1;
    } else if (char === '<') {
      return -1;
    }
  }

  return -1;
}
