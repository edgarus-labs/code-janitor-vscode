import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startEngine } from '../scripts/engineServer';
import { CleanupSettings, createDefaultSettings } from '../src/cleanup/types';
import { EngineClient } from '../src/engine/client';
import { toEngineSettings } from '../src/engine/settings';
import { buildProject, dotnetAvailable, formatErrors } from './helpers/dotnetBuild';

/**
 * Real-compiler proof of the using directive placement (IDE0065) of the C# engine: the corpora of test/oracle (Usings,
 * UsingsGlobal) are built, every file of their `cases.json` is moved outside and inside its namespace (files where that
 * is not safe must be left as they are, with a reason), and the result is built again. No new compiler error is allowed,
 * and the moves must go back and forth. `npm run verify:compile` builds the same corpora with the full cleanup.
 */

interface Expectation {
  /** Text the moved file must contain (line breaks as `\n`). */
  readonly moved?: readonly string[];
  /** Text of the reason why the file must be left as it is. */
  readonly skipped?: string;
  /** A file that the compiler rejects (or binds differently) once its directives are moved as plain text, without qualifying their names. */
  readonly control?: boolean;
}

type Direction = 'outward' | 'inward';
type Cases = Record<Direction, Record<string, Expectation>>;

const PLACEMENT_RULE = 'IDE0065';
const INSIDE_NAMESPACE = 'root = true\n\n[*.cs]\ncsharp_using_directive_placement = inside_namespace:warning\n';

const CORPORA = ['Usings', 'UsingsGlobal'].map((name) => {
  const directory = path.join(__dirname, 'oracle', name);

  return { name, directory, project: `${name}.csproj`, cases: JSON.parse(fs.readFileSync(path.join(directory, 'cases.json'), 'utf8')) as Cases };
});

/** Only the placement step is on; `.editorconfig` decides the direction for `inward`, the setting for `outward`. */
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
  /** Why the engine left a placement violation, one per IDE0065 it did not fix. */
  readonly reasons: string[];
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
  const copies: string[] = [];
  let engine: EngineClient;

  /**
   * A new copy of `source` (the corpus as it is in the repository by default), with `.editorconfig` deciding the
   * direction if it is `inward`. Every step works in a new folder, so the engine loads the files as they are on disk.
   */
  function freshCopy(direction: Direction, source: string = directory): string {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-usings-'));
    copies.push(work);
    fs.cpSync(source, work, { recursive: true, filter: (from) => !['bin', 'obj', '.editorconfig'].includes(path.basename(from)) });
    if (direction === 'inward') {
      fs.writeFileSync(path.join(work, '.editorconfig'), INSIDE_NAMESPACE);
    }

    return work;
  }

  async function clean(file: string, direction: Direction): Promise<Outcome> {
    const before = fs.readFileSync(file, 'utf8');
    const result = await engine.cleanup({ filePath: file, text: before, settings: toEngineSettings(settings(direction)) });

    return { before, after: result.text, reasons: result.unresolved.filter((item) => item.id === PLACEMENT_RULE).map((item) => item.reason) };
  }

  /** Moves every file of `files` in `direction` and writes the moved ones; the files that were left as they are have a reason. */
  async function moveAll(work: string, files: Iterable<string>, direction: Direction): Promise<Map<string, Outcome>> {
    const outcomes = new Map<string, Outcome>();
    for (const relative of files) {
      outcomes.set(relative, await clean(path.join(work, relative), direction));
    }

    for (const [relative, outcome] of outcomes) {
      if (outcome.after !== outcome.before) {
        fs.writeFileSync(path.join(work, relative), outcome.after);
      }
    }

    return outcomes;
  }

  function expectBuilds(work: string): void {
    const built = buildProject(work, project);

    expect(built.errors, formatErrors(built)).toEqual([]);
    expect(built.ok, built.output).toBe(true);
    // CS0105: a using directive the move left twice in one scope.
    expect(built.output, 'duplicate using directive').not.toContain('CS0105');
  }

  beforeAll(() => {
    engine = startEngine([os.tmpdir()]);
  });

  afterAll(async () => {
    await engine?.shutdown();
    copies.forEach((copy) => fs.rmSync(copy, { recursive: true, force: true }));
  });

  it('builds before the move', () => {
    expectBuilds(freshCopy('outward'));
  }, 180_000);

  describe.each(['outward', 'inward'] as const)('%s', (direction) => {
    const entries = Object.entries(cases[direction]);
    let work: string;
    let outcomes: Map<string, Outcome>;

    beforeAll(async () => {
      work = freshCopy(direction);
      outcomes = await moveAll(
        work,
        entries.map(([relative]) => relative),
        direction
      );
    }, 300_000);

    it.each(entries)('%s', (relative, expectation) => {
      const { before, after, reasons } = outcomes.get(relative)!;
      if (expectation.skipped !== undefined) {
        // One reason per directive that stays misplaced, each with the expected text.
        expect(after).toBe(before);
        expect(reasons).not.toEqual([]);
        expect(reasons.filter((reason) => !reason.includes(expectation.skipped!))).toEqual([]);
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

    it('builds after the move without a new compiler error', () => expectBuilds(work), 180_000);

    it('is stable: a second run changes nothing', async () => {
      const again = freshCopy(direction, work);
      for (const [relative, expectation] of entries) {
        if (expectation.moved) {
          const outcome = await clean(path.join(again, relative), direction);
          expect(outcome.after, relative).toBe(outcome.before);
        }
      }
    }, 300_000);

    it('moves back where it came from and still builds', async () => {
      const back = direction === 'outward' ? 'inward' : 'outward';
      const returned = freshCopy(back, work);
      const moved = entries.filter(([, expectation]) => expectation.moved).map(([relative]) => relative);
      for (const [relative, { after, reasons }] of await moveAll(returned, moved, back)) {
        // A file the way back cannot prove safe stays where it is, with a reason; otherwise it moves. The exception is a
        // file with an extern alias: Roslyn does not report IDE0065 for it inwards, so it stays without a reason.
        const externAlias = back === 'inward' && /^extern alias /m.test(after);
        expect(externAlias || reasons.length > 0 || after !== outcomes.get(relative)!.after, relative).toBe(true);
      }

      expectBuilds(returned);
    }, 300_000);
  });

  describe('controls: moving the skipped files as plain text breaks the build', () => {
    const controls = (['outward', 'inward'] as const).flatMap((direction) =>
      Object.entries(cases[direction])
        .filter(([, expectation]) => expectation.control)
        .map(([relative]) => [relative, direction === 'outward' ? naiveOutward : naiveInward] as const)
    );

    it.each(controls)(
      '%s',
      (relative, move) => {
        const work = freshCopy('outward');
        const file = path.join(work, relative);
        const original = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file, move(original));

        expect(move(original)).not.toBe(original);
        expect(buildProject(work, project).errors.length, relative).toBeGreaterThan(0);
      },
      120_000
    );
  });
});
