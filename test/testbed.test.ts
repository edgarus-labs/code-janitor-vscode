import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CODE_STYLE_RULES } from '../src/cleanup/codeStyleRules';
import { runLanguageCleanup } from '../src/cleanup/layoutCleanup';
import { insertRegionAroundLines } from '../src/text/regionEdits';
import { sortLineRange } from '../src/text/sortLines';
import { CleanupSettings, createDefaultCommentFormatOptions, createDefaultSettings } from '../src/cleanup/types';
import { createDefaultReorganizeSettings } from '../src/cleanup/reorganizeSettings';
import { RazorFormatOptions } from '../src/razor/razorOptions';
import { formatRazor } from '../src/razor/razorFormatter';
import { EngineClient } from '../src/engine/client';
import { CleanupResult } from '../src/engine/protocol';
import { toEngineSettings } from '../src/engine/settings';
import { startEngine } from '../scripts/engineServer';
import { dotnetAvailable } from './helpers/dotnetBuild';
import { Check, failure, selectScenarios } from './helpers/testbedChecks';

/**
 * The Code Janitor testbed (https://github.com/edgarus-labs/code-janitor-testbed): a solution of
 * deliberately bad C#, one class per cleanup option, and `scenarios.json` saying what each cleanup
 * must do to it. Every scenario runs here on its own file with only its own option on - the C# ones
 * through one C# engine process (the Roslyn server) for the whole file, the layout and Razor ones
 * in the extension; then the whole solution is built and run before and after the cleanup, so a
 * rewrite that breaks the build or changes what the code prints fails the test.
 *
 * The testbed is found through `CODE_JANITOR_TESTBED` (CI clones it), else in a sibling folder.
 * `CODE_JANITOR_TESTBED_SCENARIOS` (scenario ids or option names, e.g. `CsharpPreferBraces` or
 * `removeRegions,csharp_prefer_braces`) runs only those scenarios: their cleanups, alone and with every
 * option on, are the only ones applied before the solution is built and run.
 */
type EntryPoint =
  | 'cleanup'
  | 'layout'
  | 'razor'
  | 'removeXmlDoc'
  | 'fixNamespace'
  | 'splitTypes'
  | 'oneTypePerFile'
  | 'sortLines'
  | 'insertRegion'
  | 'removeRegion'
  | 'moveMember'
  | 'deleteMember';

interface ScenarioEntry {
  readonly id: string;
  readonly category: string;
  readonly file: string;
  readonly entry: EntryPoint;
  readonly settings: Record<string, unknown>;
  readonly codeStyle: Record<string, string>;
  readonly editorconfig: boolean;
  readonly alwaysOn?: boolean;
  readonly knownDefect?: string;
  readonly everything?: boolean;
  readonly trap?: boolean;
  readonly reportOnly: boolean;
  readonly razor?: Partial<RazorFormatOptions>;
  readonly expectedNamespace?: string;
  readonly createdFiles?: string[];
  readonly lines?: [number, number];
  readonly policy?: boolean;
  readonly fileDir?: string;
  readonly userSettings?: Record<string, unknown>;
  readonly userCodeStyle?: Record<string, string>;
  /** `moveMember`: the arguments of the command (the member and the sibling it goes before or after). */
  readonly move?: Record<string, unknown>;
  /** `deleteMember`: the arguments of the command (the line and name of the member). */
  readonly delete?: Record<string, unknown>;
  readonly checks: Check[];
}

/** Options with no effect on the text of one file: they need git history or a whole workspace. */
const NOT_A_TEXT_TRANSFORMATION: Readonly<Record<string, string>> = {
  onlyChangedLines: 'limits any cleanup to the lines changed since the last commit (needs git history)',
  renamePublicSymbolsAcrossWorkspace: 'renames public symbols across the projects of a workspace (batch commands only)',
};

/** Entry points that are actions on a place in the file, not normalizations: doing one twice does something else. */
const ACTIONS: ReadonlySet<EntryPoint> = new Set(['insertRegion', 'moveMember', 'deleteMember']);

/** The `.editorconfig` a scenario ships next to its file, or an empty text. */
function scenarioEditorConfig(root: string, scenario: ScenarioEntry): string {
  const file = path.join(root, path.dirname(scenario.file), '.editorconfig');

  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

/** The same rules with every severity turned off: whatever they asked for must no longer happen. */
function silenced(editorconfig: string): string {
  return editorconfig.replace(/:(?:warning|error|suggestion)\b/g, ':silent').replace(/(\.severity\s*=\s*)(?:warning|error|suggestion)\b/g, '$1none');
}

function findTestbed(): string | undefined {
  const candidates = [process.env.CODE_JANITOR_TESTBED, path.resolve(__dirname, '..', '.testbed'), path.resolve(__dirname, '..', '..', 'code-janitor-testbed')];

  return candidates.find((candidate): candidate is string => Boolean(candidate) && fs.existsSync(path.join(candidate as string, 'scenarios.json')));
}

const testbed = findTestbed();
const suite = testbed ? describe : describe.skip;

const TESTBED_MISSING =
  'The testbed was not found. Download it (it is public): git clone https://github.com/edgarus-labs/code-janitor-testbed .testbed ' +
  'in the repository root, or set CODE_JANITOR_TESTBED to a clone of it.';

if (!testbed) {
  if (process.env.CODE_JANITOR_REQUIRE_TESTBED === '1') {
    // CI sets this: a missing testbed must fail the build instead of skipping the test.
    describe('the Code Janitor testbed', () => {
      it('is present', () => {
        throw new Error(TESTBED_MISSING);
      });
    });
  } else {
    console.warn(`[testbed tests skipped] ${TESTBED_MISSING}`);
  }
}

function allOff(): CleanupSettings {
  const settings = createDefaultSettings() as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(settings)) {
    if (typeof value === 'boolean') {
      settings[key] = false;
    }
  }

  settings.fileHeaderCSharp = '';

  return settings as unknown as CleanupSettings;
}

function everythingOn(): CleanupSettings {
  const settings = createDefaultSettings() as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(settings)) {
    if (typeof value === 'boolean') {
      settings[key] = !(key in NOT_A_TEXT_TRANSFORMATION);
    }
  }

  settings.codeStyleRules = Object.fromEntries(CODE_STYLE_RULES.map((rule) => [rule.key, rule.defaultValue]));

  return settings as unknown as CleanupSettings;
}

function settingsOf(scenario: ScenarioEntry): CleanupSettings {
  if (scenario.everything) {
    const everything = everythingOn() as unknown as Record<string, unknown>;
    if (scenario.settings.reorganize) {
      const defaults = createDefaultReorganizeSettings();
      everything.reorganize = { ...defaults, ...(scenario.settings.reorganize as object), memberTypes: defaults.memberTypes };
    }

    return everything as unknown as CleanupSettings;
  }

  const settings = allOff() as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries({ ...scenario.userSettings, ...scenario.settings })) {
    if (!(key in settings)) {
      throw new Error(`${scenario.id}: unknown setting ${key}`);
    }

    if (key === 'reorganize') {
      const defaults = createDefaultReorganizeSettings();
      const override = value as Partial<typeof defaults>;
      settings.reorganize = { ...defaults, ...override, memberTypes: { ...defaults.memberTypes, ...(override.memberTypes ?? {}) } };
    } else if (key === 'commentFormat') {
      settings.commentFormat = { ...createDefaultCommentFormatOptions(), ...(value as object) };
    } else {
      settings[key] = value;
    }
  }

  const rules: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...scenario.userCodeStyle, ...scenario.codeStyle })) {
    const rule = CODE_STYLE_RULES.find((candidate) => candidate.key === key);
    if (!rule) {
      throw new Error(`${scenario.id}: unknown Code Style rule ${key}`);
    }

    rules[key] = value || rule.defaultValue;
  }

  settings.codeStyleRules = rules;

  return settings as unknown as CleanupSettings;
}

/** What one engine entry point makes of a scenario file: the new text, the files it creates and what it reports. */
interface Produced {
  readonly output: string;
  readonly created: Map<string, string>;
  readonly issues: string[];
}

/** An engine result as a scenario sees it; the issues are listed like the engine's own testbed tests list them. */
function fromResult(result: CleanupResult): Produced {
  return {
    output: result.text,
    created: new Map(result.newFiles.map((created) => [path.basename(created.path), created.text])),
    issues: [
      ...result.issues,
      ...result.unresolved.map((unresolved) => `unresolved: ${unresolved.id} line ${unresolved.line}: ${unresolved.message} (${unresolved.reason})`),
    ],
  };
}

async function produce(engine: EngineClient, root: string, scenario: ScenarioEntry, text: string): Promise<Produced> {
  const filePath = path.join(root, scenario.file);
  const created = new Map<string, string>();
  const issues: string[] = [];
  const document = { filePath, text, settings: toEngineSettings(settingsOf(scenario)) };
  switch (scenario.entry) {
    case 'razor':
      return { output: formatRazor(text, scenario.razor ?? {}), created, issues };
    case 'layout':
      return {
        output: await runLanguageCleanup(text, filePath, settingsOf(scenario), {
          formatComments: async (comments, commentPrefix) =>
            (await engine.formatCommentText({ text: comments, commentPrefix, settings: document.settings })).text,
        }),
        created,
        issues,
      };
    case 'sortLines':
      return { output: sortLineRange(text, scenario.lines![0], scenario.lines![1]), created, issues };
    case 'insertRegion':
      return { output: insertRegionAroundLines(text, scenario.lines![0], scenario.lines![1], createDefaultSettings()).text, created, issues };
    case 'removeXmlDoc':
      return fromResult(await engine.command({ ...document, command: 'removeXmlDocumentation' }));
    case 'fixNamespace':
      return fromResult(await engine.command({ ...document, command: 'fixNamespace', arguments: { namespace: scenario.expectedNamespace ?? '' } }));
    case 'splitTypes':
      return fromResult(await engine.command({ ...document, command: 'splitTopLevelTypes' }));
    case 'removeRegion':
      return fromResult(
        await engine.command({ ...document, command: 'removeRegions', arguments: { startLine: scenario.lines![0], endLine: scenario.lines![1] } })
      );
    case 'moveMember':
      return fromResult(await engine.command({ ...document, command: 'moveMember', arguments: scenario.move }));
    case 'deleteMember':
      return fromResult(await engine.command({ ...document, command: 'deleteMember', arguments: scenario.delete }));
    default:
      // `cleanup` and `oneTypePerFile`; the engine applies the scenario's `.codejanitor` and `.editorconfig` itself.
      return fromResult(await engine.cleanup(document));
  }
}

interface Outcome extends Produced {
  readonly scenario: ScenarioEntry;
  readonly input: string;
  readonly again: string;
  /** The engine failed on the scenario. */
  readonly error?: string;
}

async function clean(engine: EngineClient, root: string, scenario: ScenarioEntry, input: string): Promise<Outcome> {
  try {
    const first = await produce(engine, root, scenario, input);

    return { ...first, scenario, input, again: ACTIONS.has(scenario.entry) ? first.output : (await produce(engine, root, scenario, first.output)).output };
  } catch (err) {
    return { output: input, created: new Map(), issues: [], scenario, input, again: input, error: (err as Error).message };
  }
}

/** The output of a cleanup through the engine with `settings`, or the error it failed with. */
async function cleanupText(engine: EngineClient, filePath: string, text: string, settings: CleanupSettings): Promise<string> {
  try {
    return (await engine.cleanup({ filePath, text, settings: toEngineSettings(settings) })).text;
  } catch (err) {
    return `the engine failed: ${(err as Error).message}`;
  }
}

function copyTestbed(source: string): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-testbed-'));
  fs.cpSync(source, target, { recursive: true, filter: (from) => !/[\\/](bin|obj|\.git|node_modules)([\\/]|$)/.test(from) });

  return target;
}

interface BuildRun {
  readonly errors: string[];
  readonly lines: Map<string, string>;
}

function buildAndRun(root: string): BuildRun {
  // A failed build must not run the program of an earlier build of the same copy.
  const program = path.join(root, 'src', 'Scenarios', 'bin', 'Debug', 'net10.0', 'Scenarios.dll');
  fs.rmSync(program, { force: true });

  // The .NET host sometimes dies with an internal CLR error before it compiles anything; that says nothing about the code.
  let output = '';
  let failed: string | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const build = spawnSync('dotnet', ['build', path.join(root, 'CodeJanitor.Testbed.slnx'), '-nologo', '-v:q', '-clp:NoSummary', '-nodeReuse:false'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      timeout: 900_000,
    });
    output = `${build.stdout}\n${build.stderr}`;
    // A build can fail without a coded error line: a timeout, a signal, the CLR error left after the last attempt, a bare `error :`.
    failed = build.error
      ? `dotnet build could not run: ${build.error.message}`
      : build.status !== 0
        ? `dotnet build exited with ${build.signal ?? `code ${build.status}`}: ${output.trim().split('\n').slice(-20).join('\n')}`
        : undefined;
    if (!/Internal CLR error/.test(output)) {
      break;
    }
  }

  const coded = output
    .split('\n')
    .filter((line) => /: error [A-Z]+\d+/.test(line))
    .map((line) => line.replace(root, '').replace(/\s+\[[^\]]+\]$/, ''));
  const errors = [...new Set(coded.length === 0 && failed ? [failed] : coded)];
  const lines = new Map<string, string>();
  if (errors.length === 0) {
    const run = spawnSync('dotnet', [program], { encoding: 'utf8', timeout: 120_000 });
    for (const line of run.stdout.split('\n').filter(Boolean)) {
      const at = line.indexOf('=');
      lines.set(line.slice(0, at), line.slice(at + 1));
    }
  }

  return { errors, lines };
}

function write(root: string, scenario: ScenarioEntry, produced: Produced): void {
  fs.writeFileSync(path.join(root, scenario.file), produced.output);
  for (const [name, content] of produced.created) {
    fs.writeFileSync(path.join(root, path.dirname(scenario.file), name), content);
  }
}

function differences(before: BuildRun, after: BuildRun): string[] {
  return [...before.lines].filter(([name, value]) => after.lines.get(name) !== value).map(([name, value]) => `${name}: ${value} -> ${after.lines.get(name)}`);
}

suite('the Code Janitor testbed', () => {
  // Vitest also runs the body of a skipped suite to collect it: without a testbed there is nothing to read.
  const root = testbed ?? '';
  const all = testbed ? (JSON.parse(fs.readFileSync(path.join(root, 'scenarios.json'), 'utf8')) as { scenarios: ScenarioEntry[] }).scenarios : [];
  const scenarios = selectScenarios(all, process.env.CODE_JANITOR_TESTBED_SCENARIOS);
  const outcomes = new Map<string, Outcome>();
  const folders: string[] = [];
  let engine: EngineClient;

  // One engine process for the whole file; the scenarios run one after the other.
  beforeAll(async () => {
    engine = startEngine([root], (line) => process.env.CODE_JANITOR_TESTBED_LOG === '1' && console.log(line));
    for (const scenario of scenarios) {
      outcomes.set(scenario.id, await clean(engine, root, scenario, fs.readFileSync(path.join(root, scenario.file), 'utf8')));
    }
  }, 1_800_000);
  afterAll(async () => {
    await engine?.shutdown();
    folders.forEach((folder) => fs.rmSync(folder, { recursive: true, force: true }));
  });

  describe('coverage of the options', () => {
    it('has a scenario for every Code Style rule', () => {
      const covered = new Set(all.flatMap((scenario) => Object.keys(scenario.codeStyle)));

      expect(CODE_STYLE_RULES.map((rule) => rule.key).filter((key) => !covered.has(key))).toEqual([]);
    });

    it('has a scenario for every cleanup setting that changes the text of a file', () => {
      const covered = new Set(all.flatMap((scenario) => Object.keys(scenario.settings)));
      const settings = createDefaultSettings() as unknown as Record<string, unknown>;
      const options = Object.keys(settings).filter((key) => typeof settings[key] === 'boolean' && !(key in NOT_A_TEXT_TRANSFORMATION));

      expect(options.filter((key) => !covered.has(key))).toEqual([]);
    });

    it('has a scenario for every Reorganize option', () => {
      const covered = new Set(all.flatMap((scenario) => Object.keys((scenario.settings.reorganize ?? {}) as Record<string, unknown>)));
      const options = Object.keys(createDefaultReorganizeSettings());

      expect(options.filter((key) => !covered.has(key))).toEqual([]);
    });

    it('names every scenario class after its option', () => {
      const names = (key: string): string =>
        key
          .split('_')
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join('');
      for (const scenario of all.filter((candidate) => candidate.category === 'CodeStyle')) {
        expect(Object.keys(scenario.codeStyle).map(names), scenario.id).toContain(scenario.id);
      }
    });
  });

  describe('each cleanup, alone, on its own bad code', () => {
    it.each(scenarios.map((scenario) => [scenario.id, scenario] as const))('%s', (_id, scenario) => {
      const outcome = outcomes.get(scenario.id) as Outcome;
      expect(outcome.error, `${scenario.id}: the engine failed`).toBeUndefined();
      const problems = scenario.checks
        .map((check) => failure(check, outcome.output, outcome.issues))
        .filter((problem): problem is string => problem !== undefined);

      if (scenario.knownDefect) {
        expect(problems.length, `${scenario.id} now works: remove its knownDefect (${scenario.knownDefect})`).toBeGreaterThan(0);

        return;
      }

      expect(problems, `${scenario.id}: the cleaned file is:\n${outcome.output}`).toEqual([]);
      if (scenario.reportOnly) {
        expect(outcome.output, 'an option that is only reported must not change the code').toBe(outcome.input);
      } else if (!scenario.trap) {
        expect(outcome.output, 'the bad code must change').not.toBe(outcome.input);
      }

      expect([...outcome.created.keys()].sort(), 'the files the command creates').toEqual([...(scenario.createdFiles ?? [])].sort());
      // An action (wrapping lines in a region, moving or deleting a member) is not a normalization: it is not repeated.
      if (!ACTIONS.has(scenario.entry)) {
        expect(outcome.again, 'cleaning the result again must change nothing').toBe(outcome.output);
      }
    });
  });

  describe('with its option turned off', () => {
    it.each(
      scenarios
        .filter((scenario) => scenario.entry === 'cleanup' && !scenario.everything && !scenario.editorconfig && !scenario.alwaysOn && !scenario.policy)
        .map((scenario) => [scenario.id, scenario] as const)
    )('%s leaves its code alone', async (_id, scenario) => {
      const input = fs.readFileSync(path.join(root, scenario.file), 'utf8');
      const off: ScenarioEntry = { ...scenario, settings: {}, codeStyle: {} };

      expect(await cleanupText(engine, path.join(root, scenario.file), input, settingsOf(off))).toBe(input);
    });
  });

  describe('with every severity turned off', () => {
    it.each(
      scenarios
        .filter(
          (scenario) =>
            scenario.editorconfig && !scenario.alwaysOn && !scenario.reportOnly && scenario.entry === 'cleanup' && !scenario.policy && !scenario.fileDir
        )
        .map((scenario) => [scenario.id, scenario] as const)
    )('%s leaves its code alone', async (_id, scenario) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-silent-'));
      folders.push(dir);
      fs.writeFileSync(path.join(dir, '.editorconfig'), `root = true\n\n[*.cs]\n${silenced(scenarioEditorConfig(root, scenario))}\n`);
      fs.writeFileSync(
        path.join(dir, 'Scenarios.csproj'),
        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>'
      );
      const file = path.join(dir, path.basename(scenario.file));
      const input = fs.readFileSync(path.join(root, scenario.file), 'utf8');
      fs.writeFileSync(file, input);

      expect(await cleanupText(engine, file, input, allOff())).toBe(input);
    });
  });

  describe.skipIf(!dotnetAvailable)('against the compiler', () => {
    it('builds and prints the same values after every cleanup', () => {
      const copy = copyTestbed(root);
      folders.push(copy);
      const before = buildAndRun(copy);
      expect(before.errors, 'the unfixed testbed must build').toEqual([]);
      expect(before.lines.size).toBeGreaterThan(0);

      for (const { scenario, ...produced } of outcomes.values()) {
        write(copy, scenario, produced);
      }

      const after = buildAndRun(copy);
      expect(after.errors, 'a cleanup produced code that does not compile').toEqual([]);
      expect(differences(before, after), 'a cleanup changed what the code does').toEqual([]);
    }, 900_000);

    it('builds and prints the same values with every option on at once', async () => {
      const copy = copyTestbed(root);
      folders.push(copy);
      const before = buildAndRun(copy);
      expect(before.errors, 'the unfixed testbed must build').toEqual([]);
      expect(before.lines.size).toBeGreaterThan(0);
      const everything: CleanupSettings = { ...everythingOn(), reorganize: { ...createDefaultReorganizeSettings(), runAtStartOfCleanup: true } };
      // The copy is its own workspace; each file is cleaned as the files cleaned before it left their project.
      const copyEngine = startEngine([copy]);
      try {
        for (const scenario of scenarios.filter((candidate) => candidate.entry === 'cleanup')) {
          const file = path.join(copy, scenario.file);
          const result = await copyEngine.cleanup({ filePath: file, text: fs.readFileSync(file, 'utf8'), settings: toEngineSettings(everything) });
          for (const changed of [{ path: file, text: result.text }, ...result.otherFiles, ...result.newFiles]) {
            fs.writeFileSync(changed.path, changed.text);
            copyEngine.fileChanged(changed.path);
          }
        }
      } finally {
        await copyEngine.shutdown();
      }

      const after = buildAndRun(copy);
      expect(after.errors, 'a cleanup produced code that does not compile').toEqual([]);
      expect(differences(before, after), 'a cleanup changed what the code does').toEqual([]);
    }, 900_000);
  });
});
