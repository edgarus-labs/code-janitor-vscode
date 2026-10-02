import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveEditorConfigProperties } from '../src/cleanup/editorconfig';
import { EditorConfigRules, buildPipeline } from '../src/cleanup/runCleanup';
import { CleanupSettings, createDefaultSettings } from '../src/cleanup/types';

/**
 * Executes the shared transformation fixture corpus from the sibling Visual Studio repository
 * (code-janitor-vs/shared/tests/transformations). The same JSON files run in
 * CodeJanitor.UnitTests/Cleaning/SharedTransformationCorpusTests.cs; a failing case here means
 * the two implementations diverged.
 */
interface SharedFixture {
  name: string;
  description?: string;
  input: string;
  settings: Record<string, unknown>;
  mustContain: string[];
  mustNotContain?: string[];
}

/** Fan-out aliases, mirroring commands/settings.ts readCleanupSettings. */
const BLANK_LINE_PADDING_ALIAS = 'insertBlankLinePadding';
const EXPLICIT_ACCESS_MODIFIERS_ALIAS = 'insertExplicitAccessModifiers';

function resolveCorpusDirectory(): string | null {
  let directory = __dirname;
  for (;;) {
    const local = path.join(directory, 'shared', 'tests', 'transformations');
    if (fs.existsSync(local)) {
      return local;
    }

    const sibling = path.join(directory, 'code-janitor-vs', 'shared', 'tests', 'transformations');
    if (fs.existsSync(sibling)) {
      return sibling;
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      return null;
    }

    directory = parent;
  }
}

function applyFixtureSettings(settings: Record<string, unknown>): CleanupSettings {
  const result = createDefaultSettings() as unknown as Record<string, unknown>;

  for (const [key, value] of Object.entries(settings)) {
    if (key === 'newlines') {
      continue;
    }

    if (key === BLANK_LINE_PADDING_ALIAS || key === EXPLICIT_ACCESS_MODIFIERS_ALIAS) {
      const prefix = key === BLANK_LINE_PADDING_ALIAS ? 'insertBlankLinePadding' : 'insertExplicitAccessModifiers';
      for (const targetKey of Object.keys(result)) {
        if (targetKey.startsWith(prefix)) {
          result[targetKey] = value;
        }
      }

      continue;
    }

    if (key in result) {
      result[key] = value;
    }
  }

  return result as unknown as CleanupSettings;
}

/**
 * Fixtures of the Visual Studio corpus this syntax-only engine intentionally does not satisfy. The
 * shared JSON stays unchanged; the divergence is asserted here instead of being skipped silently.
 */
const KNOWN_DIVERGENCES: Readonly<Record<string, { reason: string; unchanged: string; notProduced: string }>> = {
  'pattern-matching-null-checks-block-lambda-convert': {
    reason: 'a block-lambda null check on a parameter of unknown type is not converted (no semantic model)',
    unchanged: 'x == null',
    notProduced: 'x is null',
  },
};

/**
 * The Visual Studio harness compiles the fixtures in a project on the latest C#; the cleanup here needs to
 * be told so, because it only writes file-scoped namespaces for a project known to use C# 10 or newer.
 */
const CORPUS_RULES: EditorConfigRules = {
  properties: resolveEditorConfigProperties([{ directory: '/repo', text: 'root = true\n' }], '/repo/Sample.cs'),
  report: () => undefined,
  project: { directory: '/repo', languageVersion: 99 },
};

const corpusDirectory = resolveCorpusDirectory();
const fixtureFiles = corpusDirectory
  ? fs.readdirSync(corpusDirectory).filter((name) => name.endsWith('.json')).sort()
  : [];

const suite = corpusDirectory && fixtureFiles.length > 0 ? describe : describe.skip;

suite('shared transformation corpus', () => {
  for (const fixtureFile of fixtureFiles) {
    const fixture = JSON.parse(fs.readFileSync(path.join(corpusDirectory!, fixtureFile), 'utf8')) as SharedFixture;
    const lf = fixture.settings?.newlines === 'lf';
    const normalize = (text: string): string => (lf ? text.replace(/\r\n/g, '\n') : text);
    const input = normalize(fixture.input);

    const divergence = KNOWN_DIVERGENCES[fixture.name];

    it(fixture.name, () => {
      const settings = applyFixtureSettings(fixture.settings ?? {});
      const output = buildPipeline(input, settings, CORPUS_RULES).run(input);

      if (divergence) {
        // Roslyn knows the lambda parameter's type; without a semantic model `x is null` could be
        // CS0037 for a non-nullable value type, so this engine must leave the comparison alone.
        expect(output, divergence.reason).toContain(divergence.unchanged);
        expect(output, divergence.reason).not.toContain(divergence.notProduced);

        return;
      }

      for (const expected of fixture.mustContain ?? []) {
        expect(output, `expected output to contain: ${JSON.stringify(expected)}`).toContain(normalize(expected));
      }

      for (const forbidden of fixture.mustNotContain ?? []) {
        expect(output, `expected output NOT to contain: ${JSON.stringify(forbidden)}`).not.toContain(normalize(forbidden));
      }
    });
  }
});
