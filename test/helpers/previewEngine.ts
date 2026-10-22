import * as path from 'node:path';
import { countChangedRegions } from '../../src/cleanup/lineDiff';
import { CleanupResult, RuleResult } from '../../src/engine/protocol';
import { EngineParams, cleanupResult } from './fakeEngine';

/** One rule of the fake engine: an id, the name the preview shows and a text rewrite. */
interface FakeRule {
  readonly id: string;
  readonly name: string;
  apply(text: string, eol: string): string;
}

const RULES: readonly FakeRule[] = [
  { id: 'CJ0001', name: 'Remove trailing whitespace', apply: (text) => text.replace(/[ \t]+(?=\r?\n|$)/g, '') },
  {
    id: 'CJ0002',
    name: 'Normalize blank lines',
    apply: (text, eol) =>
      text
        .split(`${eol}${eol}${eol}`)
        .join(`${eol}${eol}`)
        .replace(/(\r?\n)+$/, eol),
  },
  { id: 'IDE0090', name: 'IDE0090', apply: (text) => text.replace(/(\w+(?:<[^>]*>)?) (\w+) = new \1\(\)/g, '$1 $2 = new()') },
  {
    id: 'IDE0011',
    name: 'IDE0011',
    apply: (text, eol) =>
      text
        .split(eol)
        .flatMap((line, index, lines) => {
          const single = /^(\s*)(if|foreach) (\(.+\)) (\S.*;)$/.exec(line);
          if (single) {
            return [`${single[1]}${single[2]} ${single[3]}`, `${single[1]}{`, `${single[1]}    ${single[4]}`, `${single[1]}}`];
          }

          const header = /^(\s*)(if|foreach) \(.+\)$/.exec(line);
          const body = lines[index + 1];
          if (header && body !== undefined && !body.trim().startsWith('{')) {
            return [line, `${header[1]}{`];
          }

          const previous = /^(\s*)(if|foreach) \(.+\)$/.exec(lines[index - 1] ?? '');
          if (previous && !line.trim().startsWith('{')) {
            return [line, `${previous[1]}}`];
          }

          return [line];
        })
        .join(eol),
  },
];

/**
 * The fake engine of the preview tests: four rules applied in order, the excluded ones left out, each
 * with the number of places it changed; a second top-level class `Bar` moves to `Bar.cs` (one type per
 * file); a `Widget` local is an `.editorconfig` violation it cannot fix.
 */
export function fakePreviewCleanup(params: EngineParams): CleanupResult {
  const excluded = new Set((params.excludedRules as string[] | undefined) ?? []);
  const eol = params.text.includes('\r\n') ? '\r\n' : '\n';
  let text = params.text;
  const rules: RuleResult[] = [];
  for (const rule of RULES) {
    const included = !excluded.has(rule.id);
    const updated = included ? rule.apply(text, eol) : text;
    rules.push({ id: rule.id, name: rule.name, changes: countChangedRegions(text, updated), included });
    text = updated;
  }

  const split = /\n\ninternal class Bar\n\{[\s\S]*$/.exec(text);
  const newFiles = split ? [{ path: path.join(path.dirname(params.filePath), 'Bar.cs'), text: `namespace Demo;${split[0]}` }] : [];
  if (split) {
    text = `${text.slice(0, split.index)}\n`;
  }

  const unresolved = text.includes('Widget ')
    ? [{ id: 'IDE0008', message: "use an explicit type instead of 'var'", severity: 'warning', line: 5, column: 9, reason: 'the type of Create() is unknown' }]
    : [];

  return cleanupResult(text, { rules, newFiles, unresolved });
}
