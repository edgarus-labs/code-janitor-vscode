import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCleanup } from '../src/cleanup/runCleanup';
import { CleanupSettings, createDefaultSettings } from '../src/cleanup/types';
import { clearUsingIndexCache } from '../src/cleanup/usings/workspaceIndex';
import { buildProject, dotnetAvailable, formatErrors } from './helpers/dotnetBuild';

/**
 * Real-compiler proof of the using directive placement: the corpora of test/oracle (Usings, UsingsGlobal) are
 * built, every file is moved outside and inside its namespace (files where that is not provably safe must be
 * left as they are, with a reason), and the result is built again. No new compiler error is allowed, and the
 * moves must go back and forth. `npm run verify:compile` builds the same corpora with the full cleanup.
 */

interface Expectation {
  /** Text the moved file must contain (line breaks as `\n`). */
  readonly moved?: readonly string[];
  /** Text of the reason why the file must be left as it is. */
  readonly skipped?: string;
  /** A skipped file that the compiler rejects (or binds differently) once its directives are moved as plain text. */
  readonly control?: boolean;
}

type Direction = 'outward' | 'inward';
type Cases = Record<Direction, Record<string, Expectation>>;

const CORPORA = ['Usings', 'UsingsGlobal'].map((name) => {
  const directory = path.join(__dirname, 'oracle', name);

  return { name, directory, project: `${name}.csproj`, cases: JSON.parse(fs.readFileSync(path.join(directory, 'cases.json'), 'utf8')) as Cases };
});

/** Only the placement steps are on; `.editorconfig` decides the direction for `inward`, the setting for `outward`. */
function settings(direction: Direction): CleanupSettings {
  const result = createDefaultSettings() as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === 'boolean') {
      result[key] = false;
    }
  }

  return { ...(result as unknown as CleanupSettings), moveUsingsOutsideNamespace: direction === 'outward' };
}

interface Outcome {
  readonly before: string;
  readonly after: string;
  readonly reasons: string[];
}

function clean(file: string, direction: Direction): Outcome {
  const before = fs.readFileSync(file, 'utf8');
  const reasons: string[] = [];
  const after = runCleanup(before, file, settings(direction), undefined, (issue) => {
    if (issue.kind === 'unresolved') {
      reasons.push(issue.detail);
    }
  });

  return { before, after, reasons };
}

/** Moved as plain text, the way a textual "move usings" would: outward every indented using goes to the top ... */
function naiveOutward(text: string): string {
  const moved: string[] = [];
  const rest = text.replace(/^[ \t]+(using [^;\r\n]+;)[^\r\n]*\r?\n/gm, (_line, directive: string) => {
    moved.push(directive);

    return '';
  });

  return `${moved.join('\n')}\n${rest}`;
}

/** ... and inward every file-level using goes behind the opening brace of the namespace. */
function naiveInward(text: string): string {
  const moved: string[] = [];
  const rest = text.replace(/^(using [^;\r\n]+;)[^\r\n]*\r?\n/gm, (_line, directive: string) => {
    moved.push(`    ${directive}`);

    return '';
  });

  return rest.replace(/^\{\r?\n/m, `{\n${moved.join('\n')}\n`);
}

describe.skipIf(!dotnetAvailable).each(CORPORA)('using directive placement against the compiler: $name', ({ directory, project, cases }) => {
  let work: string;

  /** The corpus as it is in the repository, with `.editorconfig` deciding the direction if it is `inward`. */
  function freshCopy(direction: Direction): void {
    fs.rmSync(work, { recursive: true, force: true });
    fs.cpSync(directory, work, { recursive: true, filter: (source) => !['bin', 'obj'].includes(path.basename(source)) });
    if (direction === 'inward') {
      fs.writeFileSync(path.join(work, '.editorconfig'), 'root = true\n\n[*.cs]\ncsharp_using_directive_placement = inside_namespace:warning\n');
    }

    clearUsingIndexCache();
  }

  /** Moves every file of `files` in `direction`; the files that were left as they are have a reason. */
  function moveAll(files: Iterable<string>, direction: Direction): Map<string, Outcome> {
    const outcomes = new Map<string, Outcome>();
    for (const relative of files) {
      const file = path.join(work, relative);
      const outcome = clean(file, direction);
      outcomes.set(relative, outcome);
      if (outcome.after !== outcome.before) {
        fs.writeFileSync(file, outcome.after);
      }
    }

    return outcomes;
  }

  function expectBuilds(): void {
    const built = buildProject(work, project);

    expect(built.errors, formatErrors(built)).toEqual([]);
    expect(built.ok, built.output).toBe(true);
  }

  beforeAll(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-usings-'));
  });

  afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

  it('builds before the move', () => {
    freshCopy('outward');

    expectBuilds();
  }, 180_000);

  describe.each(['outward', 'inward'] as const)('%s', (direction) => {
    const entries = Object.entries(cases[direction]);
    let outcomes: Map<string, Outcome>;

    beforeAll(() => {
      freshCopy(direction);
      outcomes = moveAll(entries.map(([relative]) => relative), direction);
    }, 120_000);

    it.each(entries)('%s', (relative, expectation) => {
      const { before, after, reasons } = outcomes.get(relative) as Outcome;
      if (expectation.skipped !== undefined) {
        expect(after).toBe(before);
        expect(reasons).toEqual([expect.stringContaining(expectation.skipped)]);
      } else if (expectation.moved) {
        expect(after).not.toBe(before);
        expect(reasons).toEqual([]);
        for (const text of expectation.moved) {
          expect(after.replace(/\r\n/g, '\n')).toContain(text);
        }
      } else {
        expect(after).toBe(before);
        expect(reasons).toEqual([]);
      }
    });

    it('builds after the move without a new compiler error', expectBuilds, 180_000);

    it('is stable: a second run changes nothing', () => {
      clearUsingIndexCache();
      for (const [relative, expectation] of entries) {
        if (expectation.moved) {
          const file = path.join(work, relative);
          expect(clean(file, direction).after, relative).toBe(fs.readFileSync(file, 'utf8'));
        }
      }
    });

    it('moves back where it came from and still builds', () => {
      const back = direction === 'outward' ? 'inward' : 'outward';
      fs.rmSync(path.join(work, '.editorconfig'), { force: true });
      if (back === 'inward') {
        fs.writeFileSync(path.join(work, '.editorconfig'), 'root = true\n\n[*.cs]\ncsharp_using_directive_placement = inside_namespace:warning\n');
      }

      clearUsingIndexCache();
      for (const [relative, { after, reasons }] of moveAll(
        entries.filter(([, expectation]) => expectation.moved).map(([relative]) => relative),
        back
      )) {
        const moved = outcomes.get(relative) as Outcome;
        // A file the way back cannot prove safe stays where it is, with a reason; otherwise it moves. Inwards, a
        // file without a single namespace (or with anything but directives outside it) stays without a reason.
        expect(back === 'inward' || reasons.length > 0 || after !== moved.after, relative).toBe(true);
      }

      expectBuilds();
    }, 180_000);
  });

  describe('controls: moving the skipped files as plain text breaks the build', () => {
    const controls = (['outward', 'inward'] as const).flatMap((direction) =>
      Object.entries(cases[direction])
        .filter(([, expectation]) => expectation.control)
        .map(([relative]) => [relative, direction === 'outward' ? naiveOutward : naiveInward] as const)
    );

    it.each(controls)('%s', (relative, move) => {
      freshCopy('outward');
      const file = path.join(work, relative);
      const original = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, move(original));

      expect(move(original)).not.toBe(original);
      expect(buildProject(work, project).errors.length, relative).toBeGreaterThan(0);
    }, 120_000);
  });
});
