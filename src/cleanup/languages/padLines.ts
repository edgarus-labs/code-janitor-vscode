/**
 * Inserts a blank line before each line `wantBlankBefore` selects, when neither that line nor the one above it is
 * blank; the inserted line break is the one ending the line above.
 */
export function padLines(source: string, wantBlankBefore: (lines: readonly string[], index: number) => boolean): string {
  // Even indexes hold the lines, odd ones the line breaks between them.
  const parts = source.split(/(\r?\n)/);
  const lines = parts.filter((_, index) => index % 2 === 0);
  const output: string[] = [];
  let changed = false;
  for (let index = 0; index < lines.length; index++) {
    if (index > 0 && lines[index].trim() !== '' && lines[index - 1].trim() !== '' && wantBlankBefore(lines, index)) {
      output.push(parts[2 * index - 1]);
      changed = true;
    }

    output.push(parts[2 * index]);
    if (2 * index + 1 < parts.length) {
      output.push(parts[2 * index + 1]);
    }
  }

  return changed ? output.join('') : source;
}
