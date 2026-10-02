/**
 * The expectations of a scenario of the public Code Janitor testbed repository (`scenarios.json`),
 * and how one is checked against the cleaned text.
 */
/** One expectation about the cleaned text of a scenario. */
export type Check =
  | { t: 'contains'; s: string }
  | { t: 'absent'; s: string }
  | { t: 'blankBetween'; a: string; b: string }
  | { t: 'noBlankBetween'; a: string; b: string }
  | { t: 'order'; s: string[] }
  | { t: 'noBom' }
  | { t: 'startsWith'; s: string }
  | { t: 'endsWith'; s: string }
  | { t: 'reported'; re: string };

const normalize = (text: string): string => text.replace(/\r\n/g, '\n');

/** Why `output` does not satisfy `check`, or undefined when it does. */
export function failure(check: Check, output: string, issues: readonly string[]): string | undefined {
  const text = normalize(output);
  switch (check.t) {
    case 'contains':
      return text.includes(check.s) ? undefined : `expected the output to contain ${JSON.stringify(check.s)}`;
    case 'absent':
      return text.includes(check.s) ? `expected the output NOT to contain ${JSON.stringify(check.s)}` : undefined;
    case 'startsWith':
      return text.startsWith(check.s) ? undefined : `expected the output to start with ${JSON.stringify(check.s)}`;
    case 'endsWith':
      return text.endsWith(check.s) ? undefined : `expected the output to end with ${JSON.stringify(check.s)}`;
    case 'noBom':
      return text.charCodeAt(0) === 0xfeff ? 'expected the byte order mark to be removed' : undefined;
    case 'reported':
      return issues.some((issue) => new RegExp(check.re).test(issue)) ? undefined : `expected a reported issue matching /${check.re}/, got: ${JSON.stringify(issues)}`;
    case 'order': {
      let from = 0;
      for (const part of check.s) {
        const at = text.indexOf(part, from);
        if (at < 0) {
          return `expected ${JSON.stringify(part)} after ${from === 0 ? 'the start' : 'the previous part'}`;
        }

        from = at + part.length;
      }

      return undefined;
    }

    case 'blankBetween':
    case 'noBlankBetween': {
      const first = text.indexOf(check.a);
      const second = first < 0 ? -1 : text.indexOf(check.b, first + check.a.length);
      if (first < 0 || second < 0) {
        return `could not find ${JSON.stringify(first < 0 ? check.a : check.b)} (in order) in the output`;
      }

      const between = text.slice(first + check.a.length, second);
      const blank = /\n[ \t]*\n/.test(between);

      return check.t === 'blankBetween' ? (blank ? undefined : `expected a blank line between ${JSON.stringify(check.a)} and ${JSON.stringify(check.b)}`) : blank ? `expected no blank line between ${JSON.stringify(check.a)} and ${JSON.stringify(check.b)}` : undefined;
    }

    default: {
      // `scenarios.json` comes from another repository: a type this one does not know must fail, not pass.
      const unknown: { t: unknown } = check;

      return `unknown check type ${JSON.stringify(unknown.t)}`;
    }
  }
}
