/** How the Razor formatter indents; `auto` follows the file (tabs when most indented lines use them). */
export type RazorIndentStyle = 'space' | 'tab' | 'auto';

/** Layout options of the Razor formatter. The defaults are the Visual Studio extension's (four spaces). */
export interface RazorFormatOptions {
  /** Columns of one indent level; also the tab width when the indent style is `tab`. */
  readonly indentSize: number;
  readonly indentStyle: RazorIndentStyle;
}

/** The options once the indent style is settled for a file. */
export interface RazorLayout {
  readonly indentSize: number;
  readonly indentStyle: 'space' | 'tab';
}

export const DEFAULT_RAZOR_OPTIONS: RazorFormatOptions = { indentSize: 4, indentStyle: 'auto' };

export const MIN_INDENT_SIZE = 1;
export const MAX_INDENT_SIZE = 8;

/** Fills in defaults for the file `text`; an unusable value falls back to the default. */
export function resolveRazorLayout(options: Partial<RazorFormatOptions>, text: string): RazorLayout {
  const size = options.indentSize;
  const indentSize =
    typeof size === 'number' && Number.isInteger(size) && size >= MIN_INDENT_SIZE && size <= MAX_INDENT_SIZE
      ? size
      : DEFAULT_RAZOR_OPTIONS.indentSize;
  const style = options.indentStyle ?? DEFAULT_RAZOR_OPTIONS.indentStyle;
  if (style === 'space' || style === 'tab') {
    return { indentSize, indentStyle: style };
  }

  const tabs = text.match(/^\t+\S/gm)?.length ?? 0;
  const spaces = text.match(/^ +\S/gm)?.length ?? 0;

  return { indentSize, indentStyle: tabs > spaces ? 'tab' : 'space' };
}

/** One indent level as text. */
export function indentUnitOf(layout: RazorLayout): string {
  return layout.indentStyle === 'tab' ? '\t' : ' '.repeat(layout.indentSize);
}
